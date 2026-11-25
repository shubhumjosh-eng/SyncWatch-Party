import { SyncEngine } from './syncEngine.js';
import { Telestrator } from './telestrator.js';
import { ClipConsensus } from './clipConsensus.js';

const el = (id) => document.getElementById(id);

const video = el('video');
const canvas = el('overlay');
const screen = el('screen');
const seek = el('seek');
const roomInput = el('roomInput');
const statusLine = el('statusLine');

const initialRoom = new URLSearchParams(location.search).get('room');
if (initialRoom) roomInput.value = initialRoom.toUpperCase();

let ws = null;
let clientId = sessionStorage.getItem('syncwatch-client') || `u${Math.random().toString(36).slice(2, 8)}`;
sessionStorage.setItem('syncwatch-client', clientId);
let roomCode = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'DEMO';
let isHost = false;
let isSeeking = false;
let ffmpegJob = 0;
const activeJobs = new Set();

function log(text) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString([], { hour12: false })}] ${text}`;
  el('log').prepend(line);
  while (el('log').children.length > 30) el('log').lastChild.remove();
}

function setStatus(text) {
  statusLine.textContent = text;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

const sync = new SyncEngine({
  send,
  getVideo: () => video,
  onTelemetry: ({ offset, rtt, drift }) => {
    el('offsetVal').textContent = `${offset} ms`;
    el('offsetVal').className = Math.abs(offset) < 100 ? 'on' : 'warn';
    el('rttVal').textContent = `${rtt} ms`;
    el('rttVal').className = rtt < 200 ? 'on' : 'warn';
    el('driftVal').textContent = `${drift} ms`;
    el('driftVal').className = Math.abs(drift) < 100 ? 'on' : 'warn';
  }
});

const teles = new Telestrator({
  canvas,
  send,
  onLog: log
});

const consensus = new ClipConsensus({
  send,
  onCount: ({ count, need }) => {
    setStatus(`Clip votes: ${count}/${need}. Two or more peers within 5 seconds triggers an automatic clip.`);
  },
  onConsensus: (msg) => {
    log(`Clip consensus reached by ${msg.voters} viewers`);
    setStatus(`Consensus at ${formatTime(msg.time)} — clipping on every device.`);
    clipAt(msg.time);
  }
});

const ffmpegWorker = new Worker('/js/ffmpegWorker.js', { type: 'module' });

ffmpegWorker.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'stage') {
    setStatus(`${msg.stage}…`);
    return;
  }
  if (msg.type === 'progress') {
    const pct = Math.round((msg.progress || 0) * 100);
    setStatus(`Encoding highlight — ${pct}%`);
    return;
  }
  if (msg.type === 'log') {
    if (msg.message.includes('error')) log(msg.message.slice(0, 120));
    return;
  }
  if (msg.type === 'error') {
    activeJobs.delete(msg.id);
    log(`Clip failed: ${msg.message}`);
    setStatus(`Clip failed: ${msg.message}`);
    return;
  }
  if (msg.type === 'done') {
    activeJobs.delete(msg.id);
    const blob = new Blob([msg.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const job = msg.id;
    addClipCard(url, job);
    log(`Clip ${job} ready (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    setStatus('Clip ready. Download it from the Clip Reel.');
    send({ type: 'clipReady', job });
  }
};

ffmpegWorker.onerror = (event) => {
  log(`FFmpeg worker error: ${event.message}`);
  setStatus('FFmpeg worker failed. Try reloading the page.');
};

function addClipCard(url, job) {
  const reel = el('clips');
  const empty = reel.querySelector('.empty');
  if (empty) empty.remove();

  const card = document.createElement('div');
  card.className = 'clip-card';

  const link = document.createElement('a');
  link.href = url;
  link.download = `syncwatch-highlight-${job}.mp4`;
  link.textContent = 'DOWNLOAD';

  const meta = document.createElement('small');
  meta.textContent = `clip ${job}`;

  card.append(link, meta);
  reel.prepend(card);
  while (reel.children.length > 8) reel.lastChild.remove();
}

function clipAt(time) {
  const duration = Number(el('clipDuration').value) || 8;
  const src = video.currentSrc || video.src || document.querySelector('.tab.active')?.dataset.src;
  if (!src) {
    setStatus('Load a sample video first.');
    return;
  }

  const job = ++ffmpegJob;
  activeJobs.add(job);
  const absolute = new URL(src, location.href).href;
  const start = Math.max(0, Number(time) || 0);

  setStatus(`Preparing clip ${formatTime(start)} → ${formatTime(start + duration)}…`);
  log(`Clipping ${formatTime(start)} to ${formatTime(start + duration)}`);
  ffmpegWorker.postMessage({ id: job, cmd: 'clip', src: absolute, start, duration });
}

function updatePresence(msg) {
  const peers = msg.clients || [];
  el('guestVal').textContent = String(msg.count || peers.length);
  const container = el('presence');
  container.innerHTML = '';

  for (const id of peers) {
    const row = document.createElement('div');
    row.className = 'peer' + (id === msg.hostId ? ' host' : '');
    const name = document.createElement('span');
    name.textContent = id === clientId ? 'You' : `Peer ${id}`;
    const role = document.createElement('span');
    role.textContent = id === msg.hostId ? 'HOST' : 'GUEST';
    row.append(name, role);
    container.append(row);
  }
}

function setRole(host) {
  isHost = host;
  sync.setHost(host);
  el('hostState').textContent = host ? 'HOST' : 'GUEST';
  el('hostState').className = host ? 'on' : '';
  el('syncTag').textContent = `ROOM ${roomCode} · ${host ? 'HOST' : 'GUEST'}`;
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}`);

  ws.onopen = () => {
    el('netState').textContent = 'ONLINE';
    el('netState').className = 'on';
    setStatus('Connected. Syncing clock with the room server…');
    send({ type: 'join', room: roomCode, clientId });
    sync.start();
  };

  ws.onclose = () => {
    el('netState').textContent = 'OFFLINE';
    el('netState').className = 'off';
    setStatus('Disconnected. Reconnecting…');
    sync.stop();
    setTimeout(connect, 1500);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'joined') {
      clientId = msg.clientId;
      sessionStorage.setItem('syncwatch-client', clientId);
      roomCode = msg.room;
      roomInput.value = roomCode;
      sync.version = -1;
      setRole(msg.hostId === clientId);
      sync.handleState(msg.state);
      setStatus(`Joined room ${roomCode}. Press PLAY to start the room.`);
      log(`Joined ${roomCode} as ${clientId}`);
      return;
    }

    if (msg.type === 'hostChanged') {
      setRole(msg.hostId === clientId);
      log(msg.hostId === clientId ? 'You are now the host' : 'Host changed');
      return;
    }

    if (msg.type === 'presence') {
      updatePresence(msg);
      return;
    }

    if (msg.type === 'pong') {
      sync.handlePong(msg);
      return;
    }

    if (msg.type === 'state') {
      sync.handleState(msg);
      return;
    }

    if (msg.type === 'stroke') {
      teles.applyRemote(msg.stroke);
      return;
    }

    if (msg.type === 'clearStrokes') {
      teles.clear(false);
      return;
    }

    if (msg.type === 'clipVoteCount') {
      consensus.handleCount(msg);
      return;
    }

    if (msg.type === 'clipConsensus') {
      consensus.handleConsensus(msg);
      return;
    }

    if (msg.type === 'clipReady') {
      log(`Peer ${msg.from} created a clip locally`);
    }
  };
}

el('joinBtn').addEventListener('click', () => {
  roomCode = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'DEMO';
  roomInput.value = roomCode;
  history.replaceState(null, '', `?room=${roomCode}`);
  if (ws && ws.readyState === 1) send({ type: 'join', room: roomCode, clientId });
  else connect();
});

el('playBtn').addEventListener('click', () => {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
});

video.addEventListener('play', () => {
  el('playBtn').textContent = 'PAUSE';
  sync.markLocalChange();
});

video.addEventListener('pause', () => {
  el('playBtn').textContent = 'PLAY';
  sync.markLocalChange();
});

seek.addEventListener('pointerdown', () => { isSeeking = true; });
seek.addEventListener('pointerup', () => { isSeeking = false; });
seek.addEventListener('input', () => {
  if (!video.duration) return;
  video.currentTime = (Number(seek.value) / 1000) * video.duration;
  el('timeLabel').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
});
seek.addEventListener('change', () => sync.markLocalChange());

video.addEventListener('timeupdate', () => {
  if (!isSeeking && video.duration) {
    seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
  }
  el('timeLabel').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
});

video.addEventListener('loadedmetadata', () => sync.markLocalChange());

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    video.src = tab.dataset.src;
    video.load();
    teles.clear(true);
    log(`Loaded sample: ${tab.textContent.trim()}`);
    setStatus(`Loaded ${tab.textContent.trim()}. Press PLAY to sync the room.`);
  });
});

el('penBtn').addEventListener('click', (e) => {
  const tool = teles.setTool('pen');
  e.currentTarget.classList.toggle('active', tool === 'pen');
  el('arrowBtn').classList.remove('active');
});

el('arrowBtn').addEventListener('click', (e) => {
  const tool = teles.setTool('arrow');
  e.currentTarget.classList.toggle('active', tool === 'arrow');
  el('penBtn').classList.remove('active');
});

el('clearBtn').addEventListener('click', () => {
  teles.clear(true);
  el('penBtn').classList.remove('active');
  el('arrowBtn').classList.remove('active');
  log('Canvas cleared for everyone');
});

el('clipBtn').addEventListener('click', () => {
  consensus.vote(video.currentTime);
  log('Voted to clip this moment');
  setStatus('Clip vote sent. Waiting for the room threshold…');
});

el('clipNowBtn').addEventListener('click', () => clipAt(video.currentTime));

new ResizeObserver(() => teles.resize()).observe(screen);

video.src = document.querySelector('.tab.active').dataset.src;
teles.resize();
connect();
