// Web Worker: FFmpeg.wasm loads, slices, and stitches video without blocking the UI.
// Core/wasm are same-origin blob URLs created below.

import { FFmpeg } from '/ffmpeg/ffmpeg/index.js';
import { fetchFile, toBlobURL } from '/ffmpeg/util/index.js';

const ffmpeg = new FFmpeg();
let loading = null;
let currentId = null;
let currentMeta = null;

ffmpeg.on('progress', ({ progress, time }) => {
  self.postMessage({ id: currentId, type: 'progress', progress: progress || 0, time: time || 0 });
});

ffmpeg.on('log', ({ message }) => {
  self.postMessage({ id: currentId, type: 'log', message: String(message || '') });
});

async function ensureLoaded() {
  if (!loading) {
    loading = (async () => {
      self.postMessage({ type: 'stage', stage: 'Loading FFmpeg core' });
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL('/ffmpeg/core-esm/ffmpeg-core.js', 'text/javascript'),
        toBlobURL('/ffmpeg/core-esm/ffmpeg-core.wasm', 'application/wasm')
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
    })();
  }
  return loading;
}

function clipCommand(input, ext, start, duration, output) {
  return [
    '-ss', String(Math.max(0, start)),
    '-i', input,
    '-t', String(duration),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    output
  ];
}

async function removeFiles(paths) {
  for (const path of paths) {
    try {
      await ffmpeg.deleteFile(path);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

async function clipJob(event) {
  const { id, src, start, duration, meta } = event.data;
  const ext = event.data.ext || (String(src || '').split('?')[0].split('.').pop() || 'mp4').toLowerCase();
  const input = `input.${ext}`;
  const output = 'highlight.mp4';

  self.postMessage({ id, type: 'stage', stage: 'Reading video' });
  const bytes = event.data.buffer
    ? new Uint8Array(event.data.buffer)
    : await fetchFile(src);
  await ffmpeg.writeFile(input, bytes);

  self.postMessage({ id, type: 'stage', stage: 'Encoding highlight' });
  const code = await ffmpeg.exec(clipCommand(input, ext, start, duration, output));
  if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);

  const data = await ffmpeg.readFile(output);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  await removeFiles([input, output]);

  self.postMessage({ id, type: 'done', buffer, mime: 'video/mp4', meta }, [buffer]);
}

async function stitchJob(event) {
  const { id, buffers, meta } = event.data;
  if (!buffers || !buffers.length) throw new Error('No clips to stitch');

  const names = buffers.map((_, i) => `clip${i}.mp4`);
  self.postMessage({ id, type: 'stage', stage: 'Writing clips' });

  for (let i = 0; i < buffers.length; i++) {
    await ffmpeg.writeFile(names[i], new Uint8Array(buffers[i]));
  }

  const list = names.map((name) => `file '${name}'`).join('\n');
  await ffmpeg.writeFile('list.txt', list);

  self.postMessage({ id, type: 'stage', stage: 'Stitching reel' });
  const code = await ffmpeg.exec([
    '-f', 'concat',
    '-safe', '0',
    '-i', 'list.txt',
    '-c', 'copy',
    '-movflags', '+faststart',
    'reel.mp4'
  ]);
  if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);

  const data = await ffmpeg.readFile('reel.mp4');
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  await removeFiles([...names, 'list.txt', 'reel.mp4']);

  self.postMessage({ id, type: 'done', buffer, mime: 'video/mp4', meta }, [buffer]);
}

self.onmessage = async (event) => {
  const { id, cmd } = event.data || {};
  if (cmd !== 'clip' && cmd !== 'stitch') return;

  currentId = id;
  currentMeta = event.data.meta || null;

  try {
    await ensureLoaded();
    if (cmd === 'clip') await clipJob(event);
    else await stitchJob(event);
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      message: error && error.message ? error.message : String(error),
      meta: currentMeta
    });
  }
};
