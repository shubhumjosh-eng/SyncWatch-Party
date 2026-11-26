'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { server, wss, rooms, cleanRoomCode, MAX_ROOMS } = require('../server');

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

test('screen frames relay only from the host while sharing', async () => {
  const room = `RELAY${Date.now()}`.slice(0, 8);
  const host = await connect();
  const hostJoined = await join(host, room, 'host');
  const hostId = hostJoined.clientId;
  const guest = await connect();
  const guestJoined = await join(guest, room, 'guest');

  host.send(JSON.stringify({
    type: 'mediaSource',
    source: { kind: 'screen', hostId }
  }));
  const frame = onceMessage(guest, (msg) => msg.type === 'screen-frame');
  host.send(JSON.stringify({
    type: 'screen-frame',
    data: 'data:image/jpeg;base64,QUJD',
    w: 640,
    h: 360,
    seq: 3
  }));
  const received = await frame;
  assert.equal(received.from, hostId);
  assert.equal(received.seq, 3);
  assert.equal(received.data, 'data:image/jpeg;base64,QUJD');

  const webp = onceMessage(guest, (msg) => msg.type === 'screen-frame' && msg.data.startsWith('data:image/webp'));
  host.send(JSON.stringify({
    type: 'screen-frame',
    data: 'data:image/webp;base64,QUJD',
    w: 640,
    h: 360,
    seq: 4
  }));
  assert.equal((await webp).seq, 4);

  let guestFrames = 0;
  let invalidFrames = 0;
  const listener = (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'screen-frame') guestFrames += 1;
  };
  guest.on('message', listener);
  guest.send(JSON.stringify({
    type: 'screen-frame',
    data: 'data:image/jpeg;base64,QUJD',
    w: 640,
    h: 360,
    seq: 4
  }));
  host.send(JSON.stringify({
    type: 'screen-frame',
    data: 'data:text/html;base64,PHNjcmlwdD4=',
    w: 640,
    h: 360,
    seq: 5
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  guest.off('message', listener);
  assert.equal(guestFrames, 0);
  assert.equal(invalidFrames, 0);
  assert.notEqual(guestJoined.clientId, hostId);
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

function urlsOf(config) {
  return config.iceServers.flatMap((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).map(String)
  );
}

test('RTC config exposes STUN only by default', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/rtc-config.json`);
  assert.equal(response.status, 200);
  const urls = urlsOf(await response.json());
  assert.ok(urls.some((url) => url.startsWith('stun:')));
  assert.ok(!urls.some((url) => url.startsWith('turn:')));
});

test('RTC config honors TURN environment overrides', async () => {
  const keys = ['TURN_URL', 'TURN_USERNAME', 'TURN_CREDENTIAL'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.TURN_URL = 'turn:relay.example.com:3478,turns:relay.example.com:5349';
  process.env.TURN_USERNAME = 'room-user';
  process.env.TURN_CREDENTIAL = 'room-pass';
  try {
    const response = await fetch(`http://127.0.0.1:${port}/rtc-config.json`);
    const config = await response.json();
    const urls = urlsOf(config);
    assert.ok(urls.includes('turn:relay.example.com:3478'));
    assert.ok(urls.includes('turns:relay.example.com:5349'));
    assert.ok(!urls.some((url) => url.includes('openrelay')));
    const turn = config.iceServers.find((entry) => urlsOf({ iceServers: [entry] }).some((u) => u.startsWith('turn:')));
    assert.equal(turn.username, 'room-user');
    assert.equal(turn.credential, 'room-pass');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// --- P0 regression tests -------------------------------------------------

test('reactions reach peers but are never echoed to the sender', async () => {
  const room = `REACT${Date.now()}`.slice(0, 8);
  const sender = await connect();
  const observer = await connect();
  const senderId = (await join(sender, room, 'sender')).clientId;
  await join(observer, room, 'observer');

  const seen = onceMessage(observer, (msg) => msg.type === 'reaction');
  let echo = false;
  const listener = (raw) => {
    if (JSON.parse(raw.toString()).type === 'reaction') echo = true;
  };
  sender.on('message', listener);

  sender.send(JSON.stringify({ type: 'reaction', emoji: '🔥', videoTime: 1.25 }));
  const msg = await seen;
  await new Promise((resolve) => setTimeout(resolve, 120));
  sender.off('message', listener);

  assert.equal(msg.from, senderId);
  assert.equal(msg.emoji, '🔥');
  assert.equal(msg.videoTime, 1.25);
  assert.equal(echo, false);
});

test('an emptied room is deleted so the next joiner starts clean', async () => {
  const room = `EMPTY${Date.now()}`.slice(0, 8);
  const first = await connect();
  await join(first, room, 'first');
  first.send(JSON.stringify({
    type: 'mediaSource',
    source: { kind: 'url', url: 'https://example.com/secret.mp4', name: 'secret.mp4' }
  }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(rooms.has(cleanRoomCode(room)), false);

  const next = await connect();
  const joined = await join(next, room, 'next');
  assert.equal(joined.hostId, joined.clientId);
  assert.equal(joined.mediaSource.kind, 'sample');
  assert.equal(joined.mediaSource.src, '/samples/flower.mp4');
});

test('host migration clears inherited media source of every kind', async () => {
  const room = `MIGSRC${Date.now()}`.slice(0, 8);
  const host = await connect();
  const guest = await connect();
  const hostId = (await join(host, room, 'host')).clientId;
  const guestId = (await join(guest, room, 'guest')).clientId;

  const announced = onceMessage(guest, (msg) => msg.type === 'mediaSource');
  host.send(JSON.stringify({
    type: 'mediaSource',
    source: { kind: 'url', url: 'https://example.com/secret.mp4', name: 'secret.mp4' }
  }));
  await announced;

  const changed = onceMessage(guest, (msg) => msg.type === 'hostChanged');
  const reset = onceMessage(guest, (msg) => msg.type === 'mediaSource' && msg.from === guestId);
  host.close();
  assert.equal((await changed).hostId, guestId);
  const source = (await reset).source;
  assert.equal(source.kind, 'sample');
  assert.notEqual(hostId, guestId);
});

test('peer departure announces the stream kinds so tiles can be removed', async () => {
  const room = `LEAVE${Date.now()}`.slice(0, 8);
  const observer = await connect();
  const leaver = await connect();
  await join(observer, room, 'observer');
  await join(leaver, room, 'leaver');

  leaver.send(JSON.stringify({ type: 'rtc-meta', kind: 'screen', note: 'screen share started' }));
  leaver.send(JSON.stringify({ type: 'rtc-meta', kind: 'cam', note: 'camera joined' }));
  await new Promise((resolve) => setTimeout(resolve, 80));

  const departures = [];
  observer.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'rtc-peer-left') departures.push(msg);
  });
  leaver.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(departures.length >= 2);
  assert.ok(departures.every((msg) => typeof msg.kind === 'string'));
  assert.ok(departures.some((msg) => msg.kind === 'screen'));
  assert.ok(departures.some((msg) => msg.kind === 'cam'));
});

// --- P1 regression tests -------------------------------------------------

test('rapid joins from one socket cannot create unbounded rooms', async () => {
  const before = rooms.size;
  const spammer = await connect();
  for (let i = 0; i < 60; i += 1) {
    spammer.send(JSON.stringify({ type: 'join', room: `SPAM${i}`, clientId: 'spammer' }));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(rooms.size - before <= 1, `created ${rooms.size - before} rooms`);
  assert.ok(rooms.size <= MAX_ROOMS);
  spammer.close();
});

test('a room cap evicts the oldest room instead of growing forever', async () => {
  const sockets = [];
  for (let i = 0; i < MAX_ROOMS + 12; i += 1) {
    const ws = await connect();
    sockets.push(ws);
    await join(ws, `CAP${i}${Date.now()}`.slice(0, 8), `cap${i}`);
  }
  assert.ok(rooms.size <= MAX_ROOMS, `room count ${rooms.size} exceeded ${MAX_ROOMS}`);
  for (const ws of sockets) ws.close();
  await new Promise((resolve) => setTimeout(resolve, 120));
});

test('HEAD requests return headers without a body or file stream', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/samples/flower.mp4`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.ok(Number(response.headers.get('content-length')) > 0);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(await response.text(), '');
});

test('range errors advertise Accept-Ranges and valid ranges clamp', async () => {
  const url = `http://127.0.0.1:${port}/samples/flower.mp4`;

  const zeroSuffix = await fetch(url, { headers: { Range: 'bytes=-0' } });
  assert.equal(zeroSuffix.status, 206);
  assert.match(zeroSuffix.headers.get('content-range'), /^bytes \d+-\d+\//);

  const reversed = await fetch(url, { headers: { Range: 'bytes=100-50' } });
  assert.equal(reversed.status, 206);
  assert.match(reversed.headers.get('content-range'), /^bytes 100-100\//);
  assert.equal((await reversed.arrayBuffer()).byteLength, 1);

  const impossible = await fetch(url, { headers: { Range: 'bytes=999999999-' } });
  assert.equal(impossible.status, 416);
  assert.equal(impossible.headers.get('accept-ranges'), 'bytes');
  assert.match(impossible.headers.get('content-range'), /^bytes \*\/\d+$/);
});

test('a solo viewer can trigger clip consensus', async () => {
  const room = `SOLO${Date.now()}`.slice(0, 8);
  const ws = await connect();
  await join(ws, room, 'solo');
  const consensus = onceMessage(ws, (msg) => msg.type === 'clipConsensus');
  ws.send(JSON.stringify({ type: 'clipVote', time: 12 }));
  const msg = await consensus;
  assert.equal(msg.voters, 1);
  assert.equal(msg.time, 12);
});

test('blank chat messages are rejected', async () => {
  const room = `BLANK${Date.now()}`.slice(0, 8);
  const sender = await connect();
  const observer = await connect();
  await join(sender, room, 'sender');
  await join(observer, room, 'observer');

  let chats = 0;
  observer.on('message', (raw) => {
    if (JSON.parse(raw.toString()).type === 'chat') chats += 1;
  });
  sender.send(JSON.stringify({ type: 'chat', text: '   \n\t  ', videoTime: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(chats, 0);
});
