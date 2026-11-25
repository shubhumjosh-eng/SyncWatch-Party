// Multi-user canvas overlay. All coordinates are normalized to [0..1],
// so every peer draws in the same place regardless of screen pixel size.

export class Telestrator {
  constructor({ canvas, send, onLog }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.send = send;
    this.onLog = onLog;
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

  setTool(tool) {
    this.tool = this.tool === tool ? null : tool;
    this.canvas.style.pointerEvents = this.tool ? 'auto' : 'none';
    this.canvas.style.cursor = this.tool ? 'crosshair' : 'default';
    return this.tool;
  }

  setColor(color) {
    this.color = color;
    if (this.active) this.active.color = color;
    this.render();
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
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  point(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [
      clamp((e.clientX - rect.left) / rect.width, 0, 1),
      clamp((e.clientY - rect.top) / rect.height, 0, 1)
    ];
  }

  onDown(e) {
    if (!this.tool) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.active = {
      id: `s${Date.now().toString(36)}${(this.seq++).toString(36)}`,
      tool: this.tool,
      color: this.color,
      width: this.width,
      points: [this.point(e)],
      createdAt: Date.now(),
      done: false
    };
    this.strokes.push(this.active);
    this.render();
    this.broadcast();
    this.lastSent = Date.now();
  }

  onMove(e) {
    if (!this.active) return;
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
    if (this.onLog) this.onLog('Stroke shared with the room');
  }

  broadcast() {
    if (!this.active) return;
    this.send({ type: 'stroke', stroke: this.active });
  }

  applyRemote(stroke) {
    if (!stroke || !stroke.id) return;
    const existing = this.strokes.find((s) => s.id === stroke.id);
    if (existing) {
      existing.points = Array.isArray(stroke.points) ? stroke.points : existing.points;
      existing.done = !!stroke.done;
      existing.tool = stroke.tool || existing.tool;
    } else {
      this.strokes.push({
        id: stroke.id,
        tool: stroke.tool || 'pen',
        color: stroke.color || this.color,
        width: stroke.width || this.width,
        points: Array.isArray(stroke.points) ? stroke.points : [],
        createdAt: stroke.createdAt || Date.now(),
        done: !!stroke.done
      });
    }
    this.render();
  }

  clear(send = true) {
    this.strokes = [];
    this.active = null;
    this.render();
    if (send) this.send({ type: 'clearStrokes' });
  }

  render() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    for (const stroke of this.strokes) {
      if (this.autoFade && stroke.createdAt && Date.now() - stroke.createdAt > 3500) continue;
      if (!stroke.points || stroke.points.length < 2) continue;
      const pts = stroke.points.map(([x, y]) => [x * w, y * h]);
      this.ctx.strokeStyle = stroke.color;
      this.ctx.fillStyle = stroke.color;
      this.ctx.lineWidth = stroke.width || 3;

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
