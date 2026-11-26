// Multi-user canvas overlay. All coordinates are normalized to [0..1],
// so every peer draws in the same place regardless of screen pixel size.

const MAX_POINTS = 400;
const MAX_STROKES = 200;
const MAX_ID_LENGTH = 64;
const MAX_COLOR_LENGTH = 32;
const MIN_WIDTH = 0.5;
const MAX_WIDTH = 24;
const FADE_MS = 3500;

export class Telestrator {
  constructor({ canvas, send, onLog } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.send = typeof send === 'function' ? send : () => {};
    this.onLog = typeof onLog === 'function' ? onLog : null;
    this.tool = null;
    this.color = '#56d6c4';
    this.width = 3;
    this.autoFade = false;
    this.fadeTimer = null;
    this.strokes = [];
    this.active = null;
    this.lastSent = 0;
    this.seq = 0;

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    window.addEventListener('resize', () => this.resize());
  }

  log(text) {
    if (typeof this.onLog !== 'function') return;
    try {
      this.onLog(String(text).slice(0, 200));
    } catch {
      // Logging must never break drawing.
    }
  }

  sendSafe(payload) {
    try {
      this.send(payload);
    } catch (err) {
      this.log(`Could not send drawing update: ${err && err.message ? err.message : err}`);
    }
  }

  setTool(tool) {
    const next = tool === 'pen' || tool === 'arrow' ? tool : null;
    this.tool = this.tool === next ? null : next;
    this.canvas.style.pointerEvents = this.tool ? 'auto' : 'none';
    this.canvas.style.cursor = this.tool ? 'crosshair' : 'default';
    return this.tool;
  }

  setColor(color) {
    this.color = sanitizeColor(color, '#56d6c4');
    if (this.active) this.active.color = this.color;
    this.render();
  }

  setWidth(width) {
    this.width = clamp(finiteNumber(width, 3), MIN_WIDTH, MAX_WIDTH);
    if (this.active) this.active.width = this.width;
  }

  setAutoFade(enabled) {
    this.autoFade = !!enabled;
    clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    if (this.autoFade) {
      this.fadeTimer = setInterval(() => this.render(), 200);
    }
    this.render();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Number(window.devicePixelRatio);
    const dpr = Number.isFinite(ratio) && ratio > 0 ? clamp(ratio, 1, 3) : 1;
    this.canvas.width = Math.max(1, Math.round(Math.max(1, rect.width) * dpr));
    this.canvas.height = Math.max(1, Math.round(Math.max(1, rect.height) * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  point(e) {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    return [
      clamp(finiteNumber((Number(e.clientX) - rect.left) / w, 0), 0, 1),
      clamp(finiteNumber((Number(e.clientY) - rect.top) / h, 0), 0, 1)
    ];
  }

  pushStroke(stroke) {
    this.strokes.push(stroke);
    while (this.strokes.length > MAX_STROKES) this.strokes.shift();
    if (this.active && !this.strokes.includes(this.active)) this.active = null;
  }

  onDown(e) {
    if (!this.tool) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is optional.
    }
    this.seq = (this.seq + 1) % 1000000;
    this.active = {
      id: `s${Date.now().toString(36)}${this.seq.toString(36)}`,
      tool: this.tool,
      color: this.color,
      width: clamp(finiteNumber(this.width, 3), MIN_WIDTH, MAX_WIDTH),
      points: [this.point(e)],
      createdAt: Date.now(),
      done: false
    };
    this.pushStroke(this.active);
    this.render();
    this.broadcast();
    this.lastSent = Date.now();
  }

  onMove(e) {
    if (!this.active || this.active.points.length >= MAX_POINTS) return;
    e.preventDefault();
    const p = this.point(e);
    const last = this.active.points[this.active.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.003) return;
    this.active.points.push(p);
    this.render();
    if (Date.now() - this.lastSent > 70) {
      this.broadcast();
      this.lastSent = Date.now();
    }
  }

  onUp(e) {
    if (!this.active) return;
    e.preventDefault();
    this.active.done = true;
    this.broadcast();
    this.active = null;
    this.log('Stroke shared with the room');
  }

  broadcast() {
    if (!this.active) return;
    this.sendSafe({ type: 'stroke', stroke: this.active });
  }

  applyRemote(stroke) {
    try {
      const incoming = sanitizeStroke(stroke, this.color, this.width, Date.now());
      if (!incoming) {
        this.log('Dropped malformed stroke');
        return;
      }
      const existing = this.strokes.find((s) => s.id === incoming.id);
      if (existing) {
        // Remote updates are cumulative snapshots; never regress to a shorter
        // point list just because packets arrived out of order.
        if (incoming.points.length >= existing.points.length) {
          existing.points = incoming.points.slice(0, MAX_POINTS);
        }
        existing.tool = incoming.tool;
        existing.color = incoming.color;
        existing.width = incoming.width;
        existing.createdAt = incoming.createdAt;
        existing.done = incoming.done;
      } else {
        this.pushStroke(incoming);
      }
      this.render();
    } catch (err) {
      this.log(`Ignored malformed stroke: ${err && err.message ? err.message : err}`);
    }
  }

  clear(send = true) {
    this.strokes = [];
    this.active = null;
    this.render();
    if (send) this.sendSafe({ type: 'clearStrokes' });
  }

  pruneFaded() {
    const now = Date.now();
    this.strokes = this.strokes.filter((stroke) => now - finiteNumber(stroke.createdAt, now) <= FADE_MS);
    if (this.active && !this.strokes.includes(this.active)) this.active = null;
  }

  render() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    const now = Date.now();
    if (this.autoFade) this.pruneFaded();

    for (const stroke of this.strokes) {
      if (this.autoFade && now - finiteNumber(stroke.createdAt, now) > FADE_MS) continue;
      const pts = stroke.points
        .slice(0, MAX_POINTS)
        .map((p) => sanitizePoint(p))
        .filter(Boolean)
        .map(([x, y]) => [x * w, y * h]);
      if (pts.length < 2) continue;
      this.ctx.strokeStyle = stroke.color;
      this.ctx.fillStyle = stroke.color;
      this.ctx.lineWidth = clamp(finiteNumber(stroke.width, 3), MIN_WIDTH, MAX_WIDTH);

      if (stroke.tool === 'arrow') {
        const [x1, y1] = pts[0];
        const [x2, y2] = pts[pts.length - 1];
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
        drawArrowHead(this.ctx, x1, y1, x2, y2, 12);
      } else {
        this.ctx.beginPath();
        this.ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i][0], pts[i][1]);
        this.ctx.stroke();
      }
    }
  }
}

function sanitizeStroke(raw, fallbackColor, fallbackWidth, now) {
  if (!raw || typeof raw !== 'object') return null;
  const id = safeString(raw.id, MAX_ID_LENGTH);
  if (!id) return null;
  const points = sanitizePoints(raw.points);
  if (!points.length) return null;
  return {
    id,
    tool: raw.tool === 'arrow' ? 'arrow' : 'pen',
    color: sanitizeColor(raw.color, fallbackColor),
    width: clamp(finiteNumber(raw.width, fallbackWidth), MIN_WIDTH, MAX_WIDTH),
    points,
    createdAt: clamp(finiteNumber(raw.createdAt, now), 0, now + 60000),
    done: !!raw.done
  };
}

function sanitizePoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  // Bound the work done on hostile input: scan at most 4x the retained limit.
  const scan = Math.min(points.length, MAX_POINTS * 4);
  for (let i = 0; i < scan && out.length < MAX_POINTS; i++) {
    const point = sanitizePoint(points[i]);
    if (point) out.push(point);
  }
  return out;
}

function sanitizePoint(point) {
  let x;
  let y;
  if (Array.isArray(point)) {
    x = point[0];
    y = point[1];
  } else if (point && typeof point === 'object') {
    x = point.x;
    y = point.y;
  } else {
    return null;
  }
  x = Number(x);
  y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [clamp(x, 0, 1), clamp(y, 0, 1)];
}

function safeString(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return String(value).trim().slice(0, max);
}

function sanitizeColor(color, fallback) {
  const text = safeString(color, MAX_COLOR_LENGTH).toLowerCase();
  if (/^#[\da-f]{3,8}$/.test(text)) return text;
  if (/^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+/-]+\)$/.test(text)) return text;
  if (/^[a-z]{3,20}$/.test(text)) return text;
  return sanitizeColor(fallback, '#56d6c4');
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function drawArrowHead(ctx, x1, y1, x2, y2, size) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 7), y2 - size * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 7), y2 - size * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
