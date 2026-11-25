'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

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

// FFmpeg.wasm may rely on SharedArrayBuffer. These headers keep every
// resource same-origin and isolate the page so it is available.
const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
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

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      ...SECURITY_HEADERS
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  for (const route of VENDOR_ROUTES) {
    if (pathname.startsWith(route.prefix)) {
      const relative = pathname.slice(route.prefix.length);
      const filePath = path.resolve(route.dir, relative);
      if (!filePath.startsWith(route.dir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      serveFile(filePath, res);
      return;
    }
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  serveFile(filePath, res);
});

const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      clients: new Map(),
      host: null,
      state: { playing: false, currentTime: 0, updatedAt: Date.now(), version: 0 },
      votes: []
    });
  }
  return rooms.get(code);
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
  broadcast(room, {
    type: 'presence',
    count: room.clients.size,
    clients: [...room.clients.keys()],
    hostId: room.host
  });
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;
  let clientId = null;
  ws.isAlive = true;

  const heartbeat = setInterval(() => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      const code = String(msg.room || 'DEMO')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 8) || 'DEMO';

      clientId = String(msg.clientId || Math.random().toString(36).slice(2, 8));
      if (room) room.clients.delete(clientId);

      room = getRoom(code);
      if (!room.host) room.host = clientId;
      room.clients.set(clientId, ws);

      send(ws, {
        type: 'joined',
        room: code,
        clientId,
        hostId: room.host,
        state: room.state,
        serverTime: Date.now()
      });
      broadcastPresence(room);
      return;
    }

    if (msg.type === 'ping') {
      const t1 = Date.now();
      const t2 = Date.now();
      send(ws, { type: 'pong', t0: msg.t0, t1, t2 });
      return;
    }

    if (!room) return;

    if (msg.type === 'state') {
      if (clientId !== room.host) return;
      room.state = {
        playing: !!msg.playing,
        currentTime: Number(msg.currentTime) || 0,
        updatedAt: Date.now(),
        version: (room.state.version || 0) + 1
      };
      broadcast(room, { type: 'state', ...room.state }, ws);
      return;
    }

    if (msg.type === 'requestState') {
      send(ws, { type: 'state', ...room.state });
      return;
    }

    if (msg.type === 'stroke') {
      broadcast(room, { type: 'stroke', stroke: msg.stroke, from: clientId }, ws);
      return;
    }

    if (msg.type === 'clearStrokes') {
      broadcast(room, { type: 'clearStrokes' }, ws);
      return;
    }

    if (msg.type === 'clipVote') {
      const now = Date.now();
      room.votes = room.votes.filter((v) => now - v.at < 5000);
      if (!room.votes.some((v) => v.id === clientId)) {
        room.votes.push({ id: clientId, at: now });
      }
      const unique = new Set(room.votes.map((v) => v.id)).size;
      const threshold = Math.max(2, Math.ceil(room.clients.size * 0.6));

      if (unique >= threshold) {
        broadcast(room, {
          type: 'clipConsensus',
          time: Number(msg.time) || 0,
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
    if (!room || !clientId) return;
    room.clients.delete(clientId);
    if (room.host === clientId) {
      room.host = room.clients.keys().next().value || null;
      broadcast(room, { type: 'hostChanged', hostId: room.host });
    }
    broadcastPresence(room);
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && Date.now() - room.state.updatedAt > 3600000) {
      rooms.delete(code);
    }
  }
}, 60000).unref();

server.listen(PORT, () => {
  console.log(`SyncWatch Party running at http://localhost:${PORT}`);
});
