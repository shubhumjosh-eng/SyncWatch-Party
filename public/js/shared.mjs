// Pure helpers shared by the browser client and its Node regression tests.
// Keep this module DOM-free so `node --test` can import it directly.

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// A clip never claims a range past the end of the loaded video. Everything is
// clamped before FFmpeg is asked to encode, so card labels stay honest.
export function clipRange(time, requested, duration) {
  const length = clamp(finite(requested, 8), 1, 60);
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const at = clamp(finite(time, 0), 0, limit);
  let start = Math.max(0, at - 4);
  let end = start + length;
  if (Number.isFinite(limit)) {
    end = Math.min(end, limit);
    start = Math.min(start, end);
  }
  return { start, end };
}

// Chat timestamps accept any minute count, not just 0-99, and never turn a
// malformed string into a seek button.
export function splitChatStamps(text) {
  return String(text || '')
    .split(/(@\d{1,4}:\d{2})/g)
    .map((part) => {
      const match = /^@(\d{1,4}):(\d{2})$/.exec(part);
      return match
        ? { text: part, seconds: Number(match[1]) * 60 + Number(match[2]) }
        : { text: part, seconds: null };
    });
}

export function seekFraction(value) {
  return clamp(finite(value, 0) / 1000, 0, 1);
}

// Worker error events often carry no message at all. Never surface "undefined"
// to the user; describe the real failure in plain language instead.
export function workerErrorText(error) {
  const raw = error && typeof error.message === 'string' ? error.message : '';
  return raw.trim() || 'the clipping worker could not start in this browser';
}

export function clippingUnavailableMessage(detail) {
  return `Clipping is unavailable here (${workerErrorText(detail)}). Try an up-to-date browser.`;
}
