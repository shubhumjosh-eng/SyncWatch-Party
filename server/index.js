'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_PAYLOAD = 256 * 1024;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm'
};

// Keeps SharedArrayBuffer available for FFmpeg.wasm. COEP credentialless still
// allows same-origin and credentialless cross-origin media to be embedded.
const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

const VENDOR_ROUTES = [
  {
    prefix: '/ffmpeg/ffmpeg/',
    dir: path.join(ROOT, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm')
  },
  {
    prefix: '/ffmpeg/util/',
    dir: path.join(ROOT, 'node_modules', '@ffmpeg', 'util', 'dist', 'esm')
  },
  {
    prefix: '/ffmpeg/core/',
    dir: path.join(ROOT, 'node_modules', '@ffmpeg', 'core', 'dist', 'umd')
  },
  {
    prefix: '/ffmpeg/core-esm/',
    dir: path.join(ROOT, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm')
  }
];

const DEFAULT_MEDIA_SOURCE = Object.freeze({
  kind: 'sample',
  src: '/samples/flower.mp4',
  name: 'FLOWER'
});

const ALLOWED_EMOJI = new Set(['🔥', '🎯', '⚡', '😂']);
const ALLOWED_TOOLS = new Set(['pen', 'arrow']);
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

// Screen sharing is relayed over the room WebSocket. TURN is opt-in for
// camera calls via TURN_URL / TURN_USERNAME / TURN_CREDENTIAL.
function cleanRoomCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'DEMO';
}

function randomId() {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function finiteNumber(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function buildIceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const configured = cleanText(process.env.TURN_URL, 500);

  if (!configured) return servers;

  const urls = configured
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^(turn|turns):/i.test(value))
    .slice(0, 8);
  if (!urls.length) return servers;

  const entry = { urls };
  const username = cleanText(process.env.TURN_USERNAME, 200);
  const credential = cleanText(process.env.TURN_CREDENTIAL, 300);
  if (username) entry.username = username;
  if (credential) entry.credential = credential;
  servers.push(entry);
  return servers;
}

function headersFor(filePath, size) {
  const ext = path.extname(filePath).toLowerCase();
  const dynamic = ['.html', '.js', '.mjs', '.css'].includes(ext);
  return {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': dynamic ? 'no-cache' : 'public, max-age=3600',
    ...SECURITY_HEADERS
  };
}

function badRange(res, size) {
  res.writeHead(416, {
    'Content-Type': 'text/plain',
    'Content-Range': `bytes */${size}`,
    ...SECURITY_HEADERS
  });
  res.end('Invalid range');
}

function serveFile(filePath, req, res) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      res.end('Not found');
      return;
    }

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, headersFor(filePath, stat.size));
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!match || (!match[1] && !match[2])) {
      badRange(res, stat.size);
      return;
    }

    let start;
    let end;
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        badRange(res, stat.size);
        return;
      }
      start = Math.max(0, stat.size - suffix);
      end = stat.size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!Number.isFinite(end)) end = stat.size - 1;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= stat.size) {
      badRange(res, stat.size);
      return;
    }

    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      ...headersFor(filePath, end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${stat.size}`
    });
    fs.createReadStream(filePath, { start, end })
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('Bad request');
    return;
  }

  if (pathname === '/rtc-config.json') {
    const body = JSON.stringify({ iceServers: buildIceServers() });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS
    });
    res.end(body);
    return;
  }

  for (const route of VENDOR_ROUTES) {
    if (pathname.startsWith(route.prefix)) {
      const relative = pathname.slice(route.prefix.length);
      const filePath = path.resolve(route.dir, relative);
      if (!filePath.startsWith(route.dir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        res.end('Forbidden');
        return;
      }
      serveFile(filePath, req, res);
      return;
    }
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('Forbidden');
    return;
  }
  serveFile(filePath, req, res);
});

const rooms = new Map();

function getRoom(code) {
  const roomCode = cleanRoomCode(code);
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      clients: new Map(),
      host: null,
      state: { playing: false, currentTime: 0, updatedAt: Date.now(), version: 0 },
      mediaSource: { ...DEFAULT_MEDIA_SOURCE },
      votes: []
    });
  }
  return rooms.get(roomCode);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, except) {
  for (const [id, ws] of room.clients) {
    if (ws !== except) send(ws, obj);
  }
}

function broadcastPresence(room) {
  if (!room) return;
  broadcast(room, {
    type: 'presence',
    count: room.clients.size,
    clients: [...room.clients.keys()],
    hostId: room.host
  });
}

function sanitizeSource(raw, clientId) {
  const source = raw && typeof raw === 'object' ? raw : {};
  if (source.kind === 'sample') {
    const src = cleanText(source.src, 120);
    if (!/^\/samples\/[A-Za-z0-9_-]+\.(mp4|webm)$/.test(src)) return null;
    return { kind: 'sample', src, name: cleanText(source.name, 40) || 'SAMPLE' };
  }
  if (source.kind === 'url') {
    const url = cleanText(source.url, 2048);
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
    } catch {
      return null;
    }
    return { kind: 'url', url, name: cleanText(source.name, 120) || 'remote video' };
  }
  if (source.kind === 'local') {
    return {
      kind: 'local',
      name: cleanText(source.name, 120) || 'local file',
      size: finiteNumber(source.size, 0, 0, 1024 * 1024 * 1024)
    };
  }
  if (source.kind === 'screen') {
    return { kind: 'screen', hostId: cleanText(source.hostId || clientId, 64) };
  }
  return null;
}

function sanitizeStroke(raw) {
  const stroke = raw && typeof raw === 'object' ? raw : null;
  if (!stroke || !ALLOWED_TOOLS.has(stroke.tool)) return null;

  const points = Array.isArray(stroke.points) ? stroke.points.slice(0, 2000) : [];
  const cleanPoints = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    cleanPoints.push([
      Math.min(1, Math.max(0, x)),
      Math.min(1, Math.max(0, y))
    ]);
  }
  if (!cleanPoints.length) return null;

  const color = HEX_COLOR.test(String(stroke.color)) ? String(stroke.color) : '#56d6c4';
  return {
    id: cleanText(stroke.id, 40) || randomId(),
    tool: stroke.tool,
    color,
    width: finiteNumber(stroke.width, 3, 1, 24),
    points: cleanPoints
  };
}

function sanitizeDescription(raw) {
  const description = raw && typeof raw === 'object' ? raw : null;
  if (!description || !['offer', 'answer', 'pranswer', 'rollback'].includes(description.type)) return null;
  if (description.type !== 'rollback' && typeof description.sdp !== 'string') return null;
  return {
    type: description.type,
    sdp: typeof description.sdp === 'string' ? description.sdp.slice(0, 100_000) : ''
  };
}

function sanitizeCandidate(raw) {
  const candidate = raw && typeof raw === 'object' ? raw : null;
  if (!candidate || typeof candidate.candidate !== 'string') return null;
  return {
    candidate: candidate.candidate.slice(0, 2000),
    sdpMid: candidate.sdpMid == null ? null : cleanText(candidate.sdpMid, 80),
    sdpMLineIndex: finiteNumber(candidate.sdpMLineIndex, 0, 0, 1000)
  };
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return true;
  const allowed = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
wss.shouldHandle = originAllowed;

wss.on('connection', (ws, req) => {
  const clientId = randomId();
  let room = null;
  let rateWindowStart = Date.now();
  let rateCount = 0;
  ws.isAlive = true;

  const heartbeat = setInterval(() => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  }, 30_000);
  heartbeat.unref();

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  function allowMessage() {
    const now = Date.now();
    if (now - rateWindowStart >= RATE_WINDOW_MS) {
      rateWindowStart = now;
      rateCount = 0;
    }
    rateCount += 1;
    return rateCount <= RATE_LIMIT;
  }

  function leaveRoom() {
    if (!room) return;
    const previous = room;
    room = null;
    previous.clients.delete(clientId);
    broadcast(previous, { type: 'rtc-peer-left', from: clientId });

    if (previous.host === clientId) {
      const nextHost = previous.clients.keys().next().value || null;
      previous.host = nextHost;
      if (nextHost) {
        if (previous.mediaSource.kind === 'screen') {
          previous.mediaSource = { ...DEFAULT_MEDIA_SOURCE };
        }
        previous.state = {
          playing: false,
          currentTime: previous.state.currentTime,
          updatedAt: Date.now(),
          version: previous.state.version + 1
        };
        broadcast(previous, { type: 'hostChanged', hostId: nextHost });
        broadcast(previous, { type: 'state', ...previous.state });
        broadcast(previous, { type: 'mediaSource', from: nextHost, source: previous.mediaSource });
      }
    }
    broadcastPresence(previous);
  }

  ws.on('message', (raw) => {
    if (!allowMessage()) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      leaveRoom();
      const code = cleanRoomCode(msg.room);
      room = getRoom(code);
      room.clients.set(clientId, ws);
      if (!room.host) room.host = clientId;

      send(ws, {
        type: 'joined',
        room: code,
        clientId,
        hostId: room.host,
        state: room.state,
        mediaSource: room.mediaSource,
        serverTime: Date.now()
      });
      broadcastPresence(room);
      return;
    }

    if (msg.type === 'ping') {
      const t0 = finiteNumber(msg.t0, Date.now(), 0, Number.MAX_SAFE_INTEGER);
      const now = Date.now();
      send(ws, { type: 'pong', t0, t1: now, t2: now });
      return;
    }

    if (!room) return;

    if (msg.type === 'state') {
      if (clientId !== room.host) return;
      room.state = {
        playing: !!msg.playing,
        currentTime: finiteNumber(msg.currentTime, 0, 0, 86_400),
        updatedAt: Date.now(),
        version: room.state.version + 1
      };
      broadcast(room, { type: 'state', ...room.state }, ws);
      return;
    }

    if (msg.type === 'requestState') {
      send(ws, { type: 'state', ...room.state });
      send(ws, { type: 'mediaSource', from: room.host, source: room.mediaSource });
      return;
    }

    if (msg.type === 'stroke') {
      const stroke = sanitizeStroke(msg.stroke);
      if (!stroke) return;
      broadcast(room, { type: 'stroke', stroke, from: clientId }, ws);
      return;
    }

    if (msg.type === 'clearStrokes') {
      broadcast(room, { type: 'clearStrokes' }, ws);
      return;
    }

    if (msg.type === 'chat') {
      broadcast(room, {
        type: 'chat',
        from: clientId,
        text: cleanText(msg.text, 500),
        videoTime: finiteNumber(msg.videoTime, 0, 0, 86_400),
        ts: Date.now()
      });
      return;
    }

    if (msg.type === 'reaction') {
      const emoji = ALLOWED_EMOJI.has(msg.emoji) ? msg.emoji : null;
      if (!emoji) return;
      broadcast(room, {
        type: 'reaction',
        from: clientId,
        emoji,
        videoTime: finiteNumber(msg.videoTime, 0, 0, 86_400),
        ts: Date.now()
      });
      return;
    }

    if (msg.type === 'mediaSource') {
      if (clientId !== room.host) return;
      const source = sanitizeSource(msg.source, clientId);
      if (!source) return;
      room.mediaSource = source;
      broadcast(room, { type: 'mediaSource', from: clientId, source }, ws);
      return;
    }

    // Screen video is relayed through the room WebSocket instead of WebRTC so
    // it works across any network without a TURN relay. Frames are small JPEGs
    // and the server enforces both size and rate limits.
    if (msg.type === 'screen-frame') {
      if (clientId !== room.host || room.mediaSource.kind !== 'screen') return;
      if (typeof msg.data !== 'string' || msg.data.length > 220_000) return;
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(msg.data)) return;
      const width = finiteNumber(msg.w, 0, 16, 1920);
      const height = finiteNumber(msg.h, 0, 16, 1080);
      if (!width || !height) return;
      broadcast(room, {
        type: 'screen-frame',
        from: clientId,
        data: msg.data,
        w: width,
        h: height,
        seq: finiteNumber(msg.seq, 0, 0, Number.MAX_SAFE_INTEGER)
      }, ws);
      return;
    }

    if (msg.type.startsWith('rtc-')) {
      const kind = msg.kind === 'screen' ? 'screen' : 'cam';
      const payload = {
        type: msg.type,
        from: clientId,
        to: cleanText(msg.to, 64) || null,
        kind,
        description: null,
        candidate: null,
        note: cleanText(msg.note, 200)
      };

      if (msg.type === 'rtc-offer' || msg.type === 'rtc-answer') {
        payload.description = sanitizeDescription(msg.description);
        if (!payload.description) return;
      } else if (msg.type === 'rtc-ice') {
        payload.candidate = sanitizeCandidate(msg.candidate);
        if (!payload.candidate) return;
      } else if (!['rtc-leave', 'rtc-meta'].includes(msg.type)) {
        return;
      }

      if (payload.to) {
        const target = room.clients.get(payload.to);
        if (target && target !== ws) send(target, payload);
      } else {
        broadcast(room, payload, ws);
      }
      return;
    }

    if (msg.type === 'clipVote') {
      const now = Date.now();
      room.votes = room.votes.filter((vote) => now - vote.at < 5000).slice(-100);
      if (!room.votes.some((vote) => vote.id === clientId)) {
        room.votes.push({ id: clientId, at: now });
      }
      const unique = new Set(room.votes.map((vote) => vote.id)).size;
      const threshold = Math.max(2, Math.ceil(room.clients.size * 0.6));
      if (unique >= threshold) {
        broadcast(room, {
          type: 'clipConsensus',
          time: finiteNumber(msg.time, 0, 0, 86_400),
          voters: unique,
          at: now
        });
        room.votes = [];
      } else {
        broadcast(room, { type: 'clipVoteCount', count: unique, need: threshold });
      }
      return;
    }

    if (msg.type === 'clipReady') {
      broadcast(room, { type: 'clipReady', from: clientId }, ws);
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    leaveRoom();
  });

  ws.on('error', () => {
    clearInterval(heartbeat);
    leaveRoom();
  });

  void req;
});

const cleanupTimer = setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && Date.now() - room.state.updatedAt > 3_600_000) {
      rooms.delete(code);
    }
  }
}, 60_000);
cleanupTimer.unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`SyncWatch Party running at http://localhost:${PORT}`);
  });
}

module.exports = {
  server,
  wss,
  getRoom,
  rooms,
  cleanRoomCode,
  buildIceServers,
  sanitizeSource,
  sanitizeStroke,
  DEFAULT_MEDIA_SOURCE
};
