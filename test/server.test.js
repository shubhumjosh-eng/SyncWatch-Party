'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { server, wss, cleanRoomCode } = require('../server');

let port;
const sockets = [];

function track(ws) {
  sockets.push(ws);
  return ws;
}

function onceMessage(ws, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeout);
    const handler = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(msg);
    };
    ws.on('message', handler);
  });
}

async function connect() {
  const ws = track(new WebSocket(`ws://127.0.0.1:${port}`));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function join(ws, room, clientId) {
  const joined = onceMessage(
    ws,
    (msg) => msg.type === 'joined' && msg.room === cleanRoomCode(room)
  );
  ws.send(JSON.stringify({ type: 'join', room, clientId }));
  return joined;
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  for (const ws of sockets) ws.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

test('media files support byte ranges', async () => {
  const full = await fetch(`http://127.0.0.1:${port}/samples/flower.mp4`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');

  const ranged = await fetch(`http://127.0.0.1:${port}/samples/flower.mp4`, {
    headers: { Range: 'bytes=0-99' }
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
  assert.match(ranged.headers.get('content-range'), /^bytes 0-99\//);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
});

test('server assigns client IDs and sanitizes room codes', async () => {
  const ws = await connect();
  const joined = await join(ws, 'bad-room-!!', 'attacker-id');
  assert.notEqual(joined.clientId, 'attacker-id');
  assert.equal(joined.room, 'BADROOM');
  assert.match(joined.clientId, /^u[a-z0-9]+$/i);
});

test('late joiners receive the current media source', async () => {
  const room = `MEDIA${Date.now()}`.slice(0, 8);
  const host = await connect();
  const hostJoined = await join(host, room, 'host');
  const hostId = hostJoined.clientId;

  const guest = await connect();
  await join(guest, room, 'guest');
  const media = onceMessage(guest, (msg) => msg.type === 'mediaSource');
  host.send(JSON.stringify({
    type: 'mediaSource',
    source: { kind: 'url', url: 'https://example.com/clip.mp4', name: 'clip.mp4' }
  }));
  await media;

  const late = await connect();
  const lateJoined = await join(late, room, 'late');
  assert.notEqual(lateJoined.clientId, hostId);
  assert.equal(lateJoined.mediaSource.kind, 'url');
  assert.equal(lateJoined.mediaSource.url, 'https://example.com/clip.mp4');
});

test('host migration broadcasts the new host', async () => {
  const room = `MIGRATE${Date.now()}`.slice(0, 8);
  const host = await connect();
  const hostJoined = await join(host, room, 'host');
  const guest = await connect();
  const guestJoined = await join(guest, room, 'guest');

  const changed = onceMessage(guest, (msg) => msg.type === 'hostChanged');
  host.close();
  const msg = await changed;
  assert.equal(msg.hostId, guestJoined.clientId);
  assert.notEqual(hostJoined.clientId, guestJoined.clientId);
});

test('RTC signaling cannot cross rooms', async () => {
  const roomA = `ROOMA${Date.now()}`.slice(0, 8);
  const roomB = `ROOMB${Date.now()}`.slice(0, 8);
  const a = await connect();
  const aJoined = await join(a, roomA, 'a');
  const b = await connect();
  const bJoined = await join(b, roomB, 'b');

  let leaked = false;
  const listener = () => { leaked = true; };
  b.on('message', listener);
  a.send(JSON.stringify({
    type: 'rtc-offer',
    to: bJoined.clientId,
    kind: 'cam',
    description: { type: 'offer', sdp: 'v=0 fake' }
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  b.off('message', listener);
  assert.equal(leaked, false);
  assert.notEqual(aJoined.room, bJoined.room);
});

test('malformed strokes are rejected and valid strokes are sanitized', async () => {
  const room = `STROKE${Date.now()}`.slice(0, 8);
  const sender = await connect();
  const observer = await connect();
  await join(sender, room, 'sender');
  await join(observer, room, 'observer');

  let broadcasts = 0;
  const listener = (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'stroke') broadcasts += 1;
  };
  observer.on('message', listener);

  sender.send(JSON.stringify({ type: 'stroke', stroke: { tool: 'pen', points: [null] } }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(broadcasts, 0);

  const forwarded = onceMessage(observer, (msg) => msg.type === 'stroke');
  sender.send(JSON.stringify({
    type: 'stroke',
    stroke: {
      id: 's1',
      tool: 'pen',
      color: '#56d6c4',
      width: 9999,
      points: [[-5, 2], [0.5, 0.25]]
    }
  }));
  const msg = await forwarded;
  assert.equal(msg.stroke.width, 24);
  assert.deepEqual(msg.stroke.points, [[0, 1], [0.5, 0.25]]);
  observer.off('message', listener);
});

test('cross-origin upgrades are rejected', () => {
  assert.equal(
    wss.shouldHandle({ headers: { origin: 'https://evil.example', host: 'good.example' } }),
    false
  );
  assert.equal(
    wss.shouldHandle({ headers: { origin: 'https://good.example', host: 'good.example' } }),
    true
  );
});
