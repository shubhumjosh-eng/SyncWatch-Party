// Web Worker: FFmpeg.wasm loads, slices, and stitches video without blocking the UI.
// Core/wasm are same-origin blob URLs created below. Jobs run one at a time, use
// unique MEMFS paths, and clean those paths up in `finally` on success or failure.

import { FFmpeg } from '/ffmpeg/ffmpeg/index.js';
import { fetchFile, toBlobURL } from '/ffmpeg/util/index.js';

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_CLIPS = 20;
const MAX_URL_LENGTH = 4096;
const MAX_START_SECONDS = 24 * 60 * 60;
const MAX_DURATION_SECONDS = 60 * 60;

const ffmpeg = new FFmpeg();
let loading = null;
let queue = Promise.resolve();
let activeJobId = null;
let fileSeq = 0;

function post(id, payload, transfer) {
  const message = { ...payload, id };
  try {
    if (transfer && transfer.length) self.postMessage(message, transfer);
    else self.postMessage(message);
  } catch {
    // A closed worker must never break the queue or the `finally` cleanup.
  }
}

function errorMessage(error) {
  const raw = error && error.message ? error.message : String(error);
  return raw.slice(0, 1000);
}

function formatBytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// FFmpeg emits progress/log messages asynchronously. Drop any that arrive while
// no job owns the decoder so they can never be blamed on the next job.
ffmpeg.on('progress', ({ progress, time }) => {
  if (activeJobId === null) return;
  post(activeJobId, {
    type: 'progress',
    progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
    time: Number.isFinite(time) ? Math.max(0, time) : 0
  });
});

ffmpeg.on('log', ({ message }) => {
  if (activeJobId === null) return;
  post(activeJobId, { type: 'log', message: String(message ?? '').slice(0, 2000) });
});

async function ensureLoaded() {
  if (!loading) {
    loading = (async () => {
      post(activeJobId, { type: 'stage', stage: 'Loading FFmpeg core' });
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL('/ffmpeg/core-esm/ffmpeg-core.js', 'text/javascript'),
        toBlobURL('/ffmpeg/core-esm/ffmpeg-core.wasm', 'application/wasm')
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
    })().catch((error) => {
      // A failed load must not be cached forever; let a later job retry.
      loading = null;
      throw error;
    });
  }
  return loading;
}

function isBufferLike(value) {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function byteLengthOf(value) {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

function asBytes(value) {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function checkedBytes(bytes, label) {
  if (!bytes.byteLength) throw new Error(`${label} is empty.`);
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`${label} is too large (limit ${formatBytes(MAX_INPUT_BYTES)}).`);
  }
  return bytes;
}

function sanitizeMeta(meta) {
  if (meta === undefined || meta === null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('Invalid meta: expected an object.');
  }
  const out = {};
  if (typeof meta.kind === 'string' && meta.kind.length <= 32) out.kind = meta.kind;
  for (const key of ['start', 'end']) {
    if (Number.isFinite(meta[key]) && meta[key] >= 0 && meta[key] <= MAX_START_SECONDS * 2) {
      out[key] = meta[key];
    }
  }
  return out;
}

function validateSrc(src) {
  if (typeof src !== 'string' || !src.trim()) {
    throw new Error('Missing video source: provide src or buffer.');
  }
  if (src.length > MAX_URL_LENGTH) {
    throw new Error(`Source URL is too long (limit ${MAX_URL_LENGTH} characters).`);
  }
  let url;
  try {
    url = new URL(src, self.location.href);
  } catch {
    throw new Error('Invalid source URL.');
  }
  if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol)) {
    throw new Error(`Unsupported source URL protocol "${url.protocol}". Use http(s), blob:, data:, or pass a buffer.`);
  }
  return url;
}

function sanitizeExt(ext, src) {
  let candidate = typeof ext === 'string' ? ext : '';
  if (!candidate && typeof src === 'string') {
    const filename = src.split(/[?#]/, 1)[0].split('/').pop() || '';
    const dot = filename.lastIndexOf('.');
    candidate = dot >= 0 ? filename.slice(dot + 1) : '';
  }
  candidate = candidate.toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(candidate) ? candidate : 'mp4';
}

function looksLikeMp4(bytes) {
  return bytes.byteLength >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 &&
    bytes[6] === 0x79 && bytes[7] === 0x70; // 'ftyp'
}

function validateMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const { cmd } = data;
  if (cmd !== 'clip' && cmd !== 'stitch') return null;

  if (!Number.isSafeInteger(data.id) || data.id < 0) {
    post(null, { type: 'error', message: 'Invalid job id: expected a non-negative integer.' });
    return null;
  }

  try {
    const meta = sanitizeMeta(data.meta);

    if (cmd === 'clip') {
      if (!Number.isFinite(data.start) || data.start < 0 || data.start > MAX_START_SECONDS) {
        throw new Error(`Invalid start: expected a number from 0 to ${MAX_START_SECONDS} seconds.`);
      }
      if (!Number.isFinite(data.duration) || data.duration <= 0 || data.duration > MAX_DURATION_SECONDS) {
        throw new Error(`Invalid duration: expected a number from 0 to ${MAX_DURATION_SECONDS} seconds.`);
      }
      if (data.buffer !== undefined && data.buffer !== null) {
        if (!isBufferLike(data.buffer)) throw new Error('Invalid buffer: expected an ArrayBuffer or typed array.');
        const bytes = checkedBytes(asBytes(data.buffer), 'Video buffer');
        return { id: data.id, cmd, meta, start: data.start, duration: data.duration, bytes, src: null, ext: sanitizeExt(data.ext, null) };
      }
      const src = validateSrc(data.src).href;
      return { id: data.id, cmd, meta, start: data.start, duration: data.duration, bytes: null, src, ext: sanitizeExt(data.ext, src) };
    }

    const buffers = data.buffers;
    if (!Array.isArray(buffers) || buffers.length < 2 || buffers.length > MAX_CLIPS) {
      throw new Error(`Invalid buffers: expected between 2 and ${MAX_CLIPS} clips.`);
    }
    let total = 0;
    const clips = buffers.map((buffer, index) => {
      const label = `Clip ${index + 1}`;
      if (!isBufferLike(buffer)) throw new Error(`${label} is not an ArrayBuffer or typed array.`);
      const bytes = checkedBytes(asBytes(buffer), label);
      total += bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) throw new Error(`Reel is too large (limit ${formatBytes(MAX_TOTAL_BYTES)}).`);
      if (!looksLikeMp4(bytes)) throw new Error(`${label} is not a valid MP4 clip.`);
      return bytes;
    });
    return { id: data.id, cmd, meta, clips };
  } catch (error) {
    post(data.id, { type: 'error', message: errorMessage(error), meta: null });
    return null;
  }
}

async function readSource(src) {
  const url = validateSrc(src);
  if (url.protocol === 'blob:' || url.protocol === 'data:') {
    const fetched = await fetchFile(url.href);
    return checkedBytes(fetched instanceof Uint8Array ? fetched : new Uint8Array(fetched), 'Video file');
  }

  let response;
  try {
    response = await fetch(url.href, { mode: 'cors' });
  } catch (error) {
    throw new Error(
      `Cannot load video from ${url.origin}: that server did not allow cross-origin (CORS) requests from this app. ` +
      `Use a same-origin URL or download the video and load it locally. (${errorMessage(error)})`
    );
  }
  if (response.type === 'opaque') {
    throw new Error(`Cannot load video from ${url.origin}: the response is CORS-opaque. The server must send Access-Control-Allow-Origin.`);
  }
  if (!response.ok) {
    throw new Error(`Cannot load video: HTTP ${response.status} ${response.statusText || ''} from ${url.href}.`);
  }
  if ((response.headers.get('content-type') || '').toLowerCase().startsWith('text/html')) {
    throw new Error(`Cannot load video: ${url.href} returned HTML instead of a video. Check the URL or CORS configuration.`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_INPUT_BYTES) {
    throw new Error(`Video is too large (limit ${formatBytes(MAX_INPUT_BYTES)}).`);
  }

  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) return checkedBytes(new Uint8Array(await response.arrayBuffer()), 'Video');

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INPUT_BYTES) {
        await reader.cancel();
        throw new Error(`Video is too large (limit ${formatBytes(MAX_INPUT_BYTES)}).`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return checkedBytes(bytes, 'Video');
}

function nextPrefix(id) {
  fileSeq += 1;
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'job';
  return `sw-${safeId}-${fileSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function removeFiles(paths) {
  for (const path of paths) {
    try {
      await ffmpeg.deleteFile(path);
    } catch {
      // Ignore cleanup failures (the path may never have been written).
    }
  }
}

async function readOutput(path) {
  const data = await ffmpeg.readFile(path);
  if (!data || !data.byteLength) throw new Error(`FFmpeg produced an empty output (${path}).`);
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer; // a standalone, transferable ArrayBuffer
}

async function clipJob(job, files) {
  const prefix = nextPrefix(job.id);
  const input = `${prefix}.input.${job.ext}`;
  const output = `${prefix}.highlight.mp4`;
  files.add(input);
  files.add(output);

  post(job.id, { type: 'stage', stage: 'Reading video' });
  const bytes = job.bytes || await readSource(job.src);
  await ffmpeg.writeFile(input, bytes);

  post(job.id, { type: 'stage', stage: 'Encoding highlight' });
  const code = await ffmpeg.exec([
    '-ss', String(job.start),
    '-i', input,
    '-t', String(job.duration),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    output
  ]);
  if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);

  const buffer = await readOutput(output);
  post(job.id, { type: 'done', buffer, mime: 'video/mp4', meta: job.meta }, [buffer]);
}

async function stitchJob(job, files) {
  const prefix = nextPrefix(job.id);
  const names = job.clips.map((_, index) => `${prefix}.clip-${index}.mp4`);
  const list = `${prefix}.list.txt`;
  const output = `${prefix}.reel.mp4`;
  for (const path of [...names, list, output]) files.add(path);

  post(job.id, { type: 'stage', stage: 'Writing clips' });
  for (let i = 0; i < job.clips.length; i++) {
    await ffmpeg.writeFile(names[i], job.clips[i]);
  }
  await ffmpeg.writeFile(list, names.map((name) => `file '${name}'`).join('\n'));

  post(job.id, { type: 'stage', stage: 'Stitching reel' });
  // Re-encode instead of `-c copy`: it normalizes codec, pixel format, sample
  // rate, frame rate and timebase, and aac_adtstoasc handles ADTS -> MP4 AAC.
  const code = await ffmpeg.exec([
    '-f', 'concat',
    '-safe', '0',
    '-i', list,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-video_track_timescale', '90000',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '128k',
    '-af', 'aresample=async=1:first_pts=0',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    output
  ]);
  if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);

  const buffer = await readOutput(output);
  post(job.id, { type: 'done', buffer, mime: 'video/mp4', meta: job.meta }, [buffer]);
}

async function runJob(job) {
  const files = new Set();
  activeJobId = job.id;
  try {
    await ensureLoaded();
    if (job.cmd === 'clip') await clipJob(job, files);
    else await stitchJob(job, files);
  } catch (error) {
    post(job.id, { type: 'error', message: errorMessage(error), meta: job.meta });
  } finally {
    try {
      await removeFiles(files);
    } finally {
      activeJobId = null;
    }
  }
}

self.onmessage = (event) => {
  const job = validateMessage(event && event.data);
  if (!job) return; // unknown commands are ignored, invalid jobs already reported
  queue = queue
    .then(() => runJob(job))
    .catch((error) => {
      // Keep the queue alive if anything unexpected escapes runJob.
      post(job.id, { type: 'error', message: errorMessage(error), meta: job.meta });
    });
};
