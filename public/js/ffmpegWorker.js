// Web Worker: FFmpeg.wasm loads and slices video without blocking the UI.
// FFmpeg itself receives core/wasm as same-origin blob URLs created below.

import { FFmpeg } from '/ffmpeg/ffmpeg/index.js';
import { fetchFile, toBlobURL } from '/ffmpeg/util/index.js';

const ffmpeg = new FFmpeg();
let loading = null;
let currentId = null;

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

self.onmessage = async (event) => {
  const { id, cmd } = event.data || {};
  if (cmd !== 'clip') return;

  currentId = id;
  const { src, start, duration } = event.data;
  try {
    await ensureLoaded();

    const cleanSrc = String(src).split('?')[0];
    const ext = (cleanSrc.split('.').pop() || 'mp4').toLowerCase();
    const input = `input.${ext}`;
    const output = 'highlight.mp4';

    self.postMessage({ id, type: 'stage', stage: 'Reading video' });
    await ffmpeg.writeFile(input, await fetchFile(src));

    self.postMessage({ id, type: 'stage', stage: 'Encoding highlight' });
    const code = await ffmpeg.exec([
      '-ss', String(Math.max(0, start)),
      '-i', input,
      '-t', String(duration),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      output
    ]);

    if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);

    const data = await ffmpeg.readFile(output);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

    await ffmpeg.deleteFile(input);
    await ffmpeg.deleteFile(output);

    self.postMessage(
      { id, type: 'done', buffer, mime: 'video/mp4' },
      [buffer]
    );
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      message: error && error.message ? error.message : String(error)
    });
  }
};
