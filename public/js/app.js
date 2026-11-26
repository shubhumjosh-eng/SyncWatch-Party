import { SyncEngine } from './syncEngine.js';
import { Telestrator } from './telestrator.js';
import { ClipConsensus } from './clipConsensus.js';
import { RTCCall } from './rtcCall.js';

const el = (id) => document.getElementById(id);

const video = el('video');
const canvas = el('overlay');
const screen = el('screen');
const seek = el('seek');
const roomInput = el('roomInput');

const initialRoom = new URLSearchParams(location.search).get('room');
if (initialRoom) roomInput.value = initialRoom.toUpperCase();

const DEFAULT_SAMPLE = document.querySelector('.tab.active')?.dataset.src || '/samples/flower.mp4';
const DEFAULT_SAMPLE_NAME = document.querySelector('.tab.active')?.textContent.trim() || 'FLOWER';

let ws = null;
let clientId = sessionStorage.getItem('syncwatch-client') || `u${Math.random().toString(36).slice(2, 8)}`;
sessionStorage.setItem('syncwatch-client', clientId);
let roomCode = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'DEMO';
let isHost = false;
let isSeeking = false;
let ffmpegJob = 0;
let peerIds = [];
let callJoined = false;
let sharing = false;

const jobs = new Map();
const activeJobs = new Set();
const clips = [];
const MAX_CLIPS = 10;
let reelDuration = 0;
let screenRecorder = null;
let screenChunks = [];
let pendingScreenStream = null;
let sourceBeforeShare = null;
let localObjectUrl = null;
let reconnectTimer = null;
let currentSource = { kind: 'sample', src: '', name: 'FLOWER' };

const COLORS = ['#56d6c4', '#f0b85a', '#ff7a7a', '#6aa9ff', '#d6a6ff', '#8bd450'];

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < String(id).length; i++) hash = (hash * 31 + String(id).charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function log(text) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString([], { hour12: false })}] ${text}`;
  el('log').prepend(line);
  while (el('log').children.length > 40) el('log').lastChild.remove();
}

function setStatus(text) {
  el('statusLine').textContent = text;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatStamp(seconds) {
  return `@${formatTime(seconds)}`;
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

const teles = new Telestrator({ canvas, send, onLog: log });

const consensus = new ClipConsensus({
  send,
  onCount: ({ count, need }) => {
    setStatus(`Clip votes: ${count}/${need}. A majority within 5 seconds triggers an automatic clip.`);
  },
  onConsensus: (msg) => {
    log(`Clip consensus reached by ${msg.voters} viewers`);
    setStatus(`Consensus at ${formatTime(msg.time)} - clipping on every device.`);
    clipAt(msg.time);
  }
});

function handleRtcStream({ id, kind, stream }) {
  renderCallTile(id, kind, stream, false);
  if (kind === 'screen' && currentSource.kind === 'screen' && id === currentSource.hostId) {
    attachScreenStream(stream, id);
  } else if (kind === 'screen') {
    pendingScreenStream = { id, stream };
  }
}

function removeCallTiles(peer, kind) {
  for (const tile of [...el('callTiles').children]) {
    if (tile.dataset.key === `${peer}:${kind}:remote`) tile.remove();
  }
  if (kind === 'screen' && pendingScreenStream && pendingScreenStream.id === peer) {
    pendingScreenStream = null;
  }
}

const rtc = new RTCCall({
  send,
  getPeers: () => peerIds.filter((id) => id !== clientId),
  getLocalId: () => clientId,
  onStream: handleRtcStream,
  onLog: log,
  onError: (error) => log(`RTC error: ${error.message}`),
  onPeerLeft: ({ id, kind }) => {
    removeCallTiles(id, kind);
    if (kind === 'screen' && currentSource.kind === 'screen' && currentSource.hostId === id) {
      pendingScreenStream = null;
      setSample(DEFAULT_SAMPLE, DEFAULT_SAMPLE_NAME, false);
      setStatus('Screen share ended. Restored the built-in sample.');
    }
  }
});

function renderCallTile(id, kind, stream, local) {
  const key = `${id}:${kind}:${local ? 'local' : 'remote'}`;
  const container = el('callTiles');
  let tile = container.querySelector(`[data-key="${key}"]`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.dataset.key = key;
    tile.style.setProperty('--tile-color', colorFor(id));
    const media = document.createElement('video');
    media.autoplay = true;
    media.playsInline = true;
    // Autoplay with audio is blocked by browsers. Start muted and expose an
    // explicit per-tile control so the user can opt in to remote audio.
    media.muted = true;
    const label = document.createElement('span');
    label.textContent = `${local ? 'YOU' : id.slice(0, 6)} ${kind.toUpperCase()}`;
    tile.append(media, label);
    if (!local) {
      const audio = document.createElement('button');
      audio.className = 'btn tiny ghost tile-audio';
      audio.textContent = 'AUDIO OFF';
      audio.addEventListener('click', () => {
        const unmute = media.muted;
        media.muted = !unmute;
        rtc.setRemoteAudioMuted(id, kind, !unmute);
        audio.textContent = unmute ? 'AUDIO ON' : 'AUDIO OFF';
      });
      tile.append(audio);
    }
    container.append(tile);
  }
  const media = tile.querySelector('video');
  if (media.srcObject !== stream) {
    media.srcObject = stream;
    media.play().catch(() => {});
  }
}

function attachScreenStream(stream, hostId) {
  if (currentSource.kind !== 'screen') return;
  if (hostId && currentSource.hostId && hostId !== currentSource.hostId) return;
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    video.muted = false;
    video.play().catch(() => {});
  }
  setStatus('Watching the host screen share live.');
}

const ffmpegWorker = (() => {
  try {
    return new Worker('/js/ffmpegWorker.js', { type: 'module' });
  } catch (error) {
    log(`Clipping unavailable in this browser: ${error.message}`);
    return null;
  }
})();

if (ffmpegWorker) ffmpegWorker.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'stage') {
    setStatus(`${msg.stage}...`);
    return;
  }
  if (msg.type === 'progress') {
    setStatus(`Encoding highlight - ${Math.round((msg.progress || 0) * 100)}%`);
    return;
  }
  if (msg.type === 'log') {
    if (msg.message.includes('error')) log(msg.message.slice(0, 120));
    return;
  }
  if (msg.type === 'error') {
    activeJobs.delete(msg.id);
    jobs.delete(msg.id);
    log(`Clip failed: ${msg.message}`);
    setStatus(`Clip failed: ${msg.message}`);
    return;
  }
  if (msg.type === 'done') {
    activeJobs.delete(msg.id);
    jobs.delete(msg.id);
    const blob = new Blob([msg.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const meta = msg.meta || jobs.get(msg.id) || {};
    if (meta.kind === 'reel') addReelCard(url, msg.id, blob, meta);
    else addClipCard(url, msg.id, meta.start || 0, meta.end || 0, blob);
    log(`Clip ${msg.id} ready (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    setStatus('Clip ready. Download it from the Clip Reel.');
    send({ type: 'clipReady', job: msg.id });
  }
};

if (ffmpegWorker) ffmpegWorker.onerror = (event) => {
  log(`FFmpeg worker error: ${event.message}`);
  setStatus('FFmpeg worker failed. Try reloading the page.');
};

function revokeCardUrls(container) {
  while (container.children.length > MAX_CLIPS) {
    const removed = container.lastChild;
    const href = removed.querySelector('a')?.href;
    if (href) URL.revokeObjectURL(href);
    removed.remove();
  }
}

function addClipCard(url, job, start, end, blob) {
  const reel = el('clips');
  const empty = reel.querySelector('.empty');
  if (empty) empty.remove();

  clips.push({ blob, url, start, end, job });
  while (clips.length > MAX_CLIPS) {
    const removed = clips.shift();
    URL.revokeObjectURL(removed.url);
  }

  const card = document.createElement('div');
  card.className = 'clip-card';

  const row = document.createElement('div');
  row.className = 'clip-row';
  const meta = document.createElement('small');
  meta.textContent = `clip ${job} [${formatTime(start)} -> ${formatTime(end)}]`;
  const link = document.createElement('a');
  link.href = url;
  link.download = `syncwatch-highlight-${job}.mp4`;
  link.textContent = 'DOWNLOAD';
  row.append(meta, link);

  const seekBtn = document.createElement('button');
  seekBtn.className = 'btn tiny ghost';
  seekBtn.textContent = 'SEEK TO';
  seekBtn.addEventListener('click', () => seekTo(start));

  card.append(row, seekBtn);
  reel.prepend(card);
  revokeCardUrls(reel);
}

function addReelCard(url, job, blob, meta = {}) {
  const reel = el('clips');
  const card = document.createElement('div');
  card.className = 'clip-card';
  const row = document.createElement('div');
  row.className = 'clip-row';
  const label = document.createElement('small');
  const duration = Number(meta.end) || 0;
  label.textContent = `FULL REEL [${formatTime(0)} -> ${formatTime(duration || blob.size / 40000)}]`;
  const link = document.createElement('a');
  link.href = url;
  link.download = `syncwatch-reel-${job}.mp4`;
  link.textContent = 'DOWNLOAD REEL';
  row.append(label, link);
  card.append(row);
  reel.prepend(card);
  revokeCardUrls(reel);
}

function buildScreenBuffer(seconds) {
  const cutoff = Date.now() - seconds * 1000;
  let selected = screenChunks.filter((chunk) => chunk.t >= cutoff);
  if (!selected.length) selected = screenChunks.slice(-5);
  if (!selected.length) return null;

  const size = selected.reduce((sum, chunk) => sum + chunk.data.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of selected) {
    bytes.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  const duration = Math.max(1, (selected[selected.length - 1].t - selected[0].t) / 1000);
  return { buffer: bytes.buffer, duration };
}

function clipAt(time) {
  if (!ffmpegWorker) {
    setStatus('Clipping is not supported in this browser.');
    return;
  }
  const requested = Number(el('clipDuration').value) || 8;
  const start = Math.max(0, time - 4);
  const end = start + requested;

  if (currentSource.kind === 'screen' && !sharing) {
    setStatus('Only the sharing device can clip the live screen.');
    return;
  }
  if (currentSource.kind === 'local' && !isHost) {
    setStatus('The host is playing a local file. Only the host can clip it.');
    return;
  }

  const job = ++ffmpegJob;
  jobs.set(job, { start, end });
  activeJobs.add(job);

  setStatus(`Preparing clip ${formatTime(start)} -> ${formatTime(end)}...`);
  log(`Clipping ${formatTime(start)} to ${formatTime(end)}`);

  if (currentSource.kind === 'screen' && screenChunks.length) {
    const buffered = buildScreenBuffer(requested + 4);
    if (!buffered) {
      activeJobs.delete(job);
      setStatus('Screen buffer is empty. Wait a moment and try again.');
      return;
    }
    ffmpegWorker.postMessage({
      id: job,
      cmd: 'clip',
      buffer: buffered.buffer,
      ext: 'webm',
      start: 0,
      duration: buffered.duration,
      meta: { start: Math.max(0, end - buffered.duration), end }
    }, [buffered.buffer]);
    return;
  }

  const src = currentSource.src || video.currentSrc || document.querySelector('.tab.active')?.dataset.src;
  if (!src) {
    activeJobs.delete(job);
    setStatus('Load a video first.');
    return;
  }
  ffmpegWorker.postMessage({
    id: job,
    cmd: 'clip',
    src: new URL(src, location.href).href,
    ext: currentSource.kind === 'local' ? currentSource.ext : undefined,
    start,
    duration: requested,
    meta: { start, end }
  });
}

function seekTo(seconds) {
  if (video.srcObject) return;
  if (!video.duration) return;
  video.currentTime = Math.min(Math.max(0, seconds), video.duration);
  sync.markLocalChange();
  setStatus(`Seeked to ${formatTime(seconds)}`);
}

function appendChat(msg) {
  const box = el('chatMessages');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = 'chat-line';

  const badge = document.createElement('span');
  badge.className = 'chat-badge';
  badge.style.setProperty('--chat-color', colorFor(msg.from));
  badge.textContent = `${String(msg.from).slice(0, 4)}:`;

  line.append(badge);

  const parts = String(msg.text || '').split(/(@\d{1,2}:\d{2})/g);
  for (const part of parts) {
    if (/^@\d{1,2}:\d{2}$/.test(part)) {
      const [minutes, seconds] = part.slice(1).split(':').map(Number);
      const button = document.createElement('button');
      button.className = 'chat-stamp';
      button.textContent = part;
      button.addEventListener('click', () => seekTo(minutes * 60 + seconds));
      line.append(button);
    } else if (part) {
      line.append(document.createTextNode(part));
    }
  }

  box.append(line);
  while (box.children.length > 50) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

function addReaction(emoji, time, from, local) {
  const duration = video.duration || 0;
  const marker = document.createElement('span');
  marker.className = 'reaction-marker';
  marker.textContent = emoji;
  marker.style.left = duration ? `${Math.min(99, (time / duration) * 100)}%` : '2%';
  const strip = el('reactionStrip');
  strip.append(marker);
  while (strip.children.length > 60) strip.firstChild.remove();

  const float = document.createElement('div');
  float.className = 'floating-reaction';
  float.textContent = emoji;
  float.style.left = `${18 + Math.random() * 60}%`;
  el('floatLayer').append(float);
  setTimeout(() => float.remove(), 1900);

  log(`${from.slice(0, 6)} reacted ${formatStamp(time)} ${emoji}`);
  if (local) send({ type: 'reaction', emoji, videoTime: time });
}

function updatePresence(msg) {
  peerIds = msg.clients || [];
  el('guestVal').textContent = String(msg.count || peerIds.length);
  const container = el('presence');
  container.innerHTML = '';

  for (const id of peerIds) {
    const row = document.createElement('div');
    row.className = 'peer' + (id === msg.hostId ? ' host' : '');
    row.style.setProperty('--peer-color', colorFor(id));
    const name = document.createElement('span');
    name.textContent = id === clientId ? 'You' : `Peer ${id.slice(0, 6)}`;
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
  el('syncTag').textContent = `ROOM ${roomCode} - ${host ? 'HOST' : 'GUEST'}`;
}

function setSample(src, name, broadcast = true) {
  stopScreenShare(false, false);
  video.srcObject = null;
  video.muted = false;
  video.src = src;
  video.load();
  sync.resetPlayback();
  currentSource = { kind: 'sample', src, name };
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.src === src);
  });
  if (broadcast && isHost) {
    send({ type: 'mediaSource', source: { kind: 'sample', src, name } });
  }
}

function loadUrl(rawUrl, broadcast = true) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    setStatus('Enter a direct http(s) .mp4 or .webm URL.');
    return;
  }
  stopScreenShare(false, false);
  if (localObjectUrl) {
    URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = null;
  }
  video.srcObject = null;
  video.muted = false;
  video.src = url;
  video.load();
  sync.resetPlayback();
  currentSource = { kind: 'url', src: url, name: url.split('/').pop() || 'remote video' };
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  setStatus(`Loading ${currentSource.name}`);
  log(`Loaded URL: ${url.slice(0, 100)}`);
  if (broadcast && isHost) {
    send({ type: 'mediaSource', source: { kind: 'url', url, name: currentSource.name } });
  }
}

function loadFile(file, broadcast = true) {
  if (!file || !/video\/(mp4|webm)/.test(file.type || '')) {
    setStatus('Choose an .mp4 or .webm file.');
    return;
  }
  stopScreenShare(false, false);
  if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
  video.srcObject = null;
  video.muted = false;
  const url = URL.createObjectURL(file);
  localObjectUrl = url;
  video.src = url;
  video.load();
  sync.resetPlayback();
  currentSource = {
    kind: 'local',
    src: url,
    name: file.name,
    size: file.size,
    ext: file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : 'mp4'
  };
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  setStatus(`Loaded local file ${file.name}. Only you can access this file; peers see a notice.`);
  log(`Loaded local file ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
  if (broadcast && isHost) {
    send({ type: 'mediaSource', source: { kind: 'local', name: file.name, size: file.size } });
  }
}

function handleMediaSource(msg) {
  if (msg.from === clientId) return;
  const source = msg.source || {};
  if (source.kind === 'sample') {
    setSample(source.src, source.name || 'SAMPLE', false);
    setStatus('Host switched to a built-in sample.');
  } else if (source.kind === 'url') {
    loadUrl(source.url, false);
    setStatus('Host switched to a direct video URL.');
  } else if (source.kind === 'local') {
    pendingScreenStream = null;
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
    sync.resetPlayback();
    currentSource = { kind: 'local', src: '', name: source.name };
    setStatus(`Host is playing a local file: ${source.name}. Peers cannot access local files.`);
  } else if (source.kind === 'screen') {
    const pending = pendingScreenStream;
    pendingScreenStream = null;
    currentSource = { kind: 'screen', hostId: msg.from };
    video.pause();
    video.srcObject = null;
    sync.resetPlayback();
    setStatus('Host is sharing their screen. Waiting for the live stream...');
    if (pending && pending.id === msg.from) attachScreenStream(pending.stream, msg.from);
  }
}

async function startScreenShare() {
  if (!isHost) {
    setStatus('Only the room host can share a screen.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    setStatus('Screen sharing is not supported in this browser.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true
    });
    sharing = true;
    sourceBeforeShare = { ...currentSource };
    pendingScreenStream = null;
    el('shareBtn').textContent = 'STOP SHARE';
    currentSource = { kind: 'screen', hostId: clientId };

    video.src = '';
    video.removeAttribute('src');
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    try {
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';
      screenChunks = [];
      screenRecorder = new MediaRecorder(stream, { mimeType });
      screenRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size) {
          event.data.arrayBuffer().then((buffer) => {
            screenChunks.push({ t: Date.now(), data: new Uint8Array(buffer) });
            const cutoff = Date.now() - 30000;
            screenChunks = screenChunks.filter((chunk) => chunk.t >= cutoff).slice(-200);
          });
        }
      };
      screenRecorder.start(2000);
      log('Rolling screen clip buffer started');
    } catch (error) {
      log(`MediaRecorder unavailable: ${error.message}`);
    }

    await rtc.startScreenShare(stream);
    send({ type: 'mediaSource', source: { kind: 'screen', hostId: clientId } });
    setStatus('Sharing your screen. Audio is muted locally to prevent echo.');

    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => stopScreenShare(true);
    }
  } catch (error) {
    log(`Screen share failed: ${error.message}`);
    setStatus(`Screen share failed: ${error.message}`);
  }
}

function stopScreenShare(fromBrowser = false, restore = true) {
  if (!sharing) return;
  sharing = false;
  el('shareBtn').textContent = 'SHARE SCREEN';
  if (screenRecorder && screenRecorder.state !== 'inactive') screenRecorder.stop();
  screenRecorder = null;
  screenChunks = [];
  pendingScreenStream = null;
  rtc.stopScreenShare();
  video.srcObject = null;
  video.muted = false;

  if (restore) {
    const previous = sourceBeforeShare;
    sourceBeforeShare = null;
    if (previous && previous.kind === 'sample') setSample(previous.src, previous.name, isHost);
    else if (previous && previous.kind === 'url') loadUrl(previous.src, isHost);
    else setSample(DEFAULT_SAMPLE, DEFAULT_SAMPLE_NAME, isHost);
  }
  if (fromBrowser) log('Screen share stopped from browser controls');
  setStatus('Screen share stopped. Normal playback restored.');
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}`);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    el('netState').textContent = 'ONLINE';
    el('netState').className = 'on';
    setStatus('Connected. Syncing clock with the room server...');
    send({ type: 'join', room: roomCode, clientId });
    sync.start();
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    el('netState').textContent = 'OFFLINE';
    el('netState').className = 'off';
    setStatus('Disconnected. Reconnecting...');
    sync.stop();
    reconnectTimer = setTimeout(connect, 1500);
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
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
      if (msg.mediaSource && msg.hostId !== clientId) {
        handleMediaSource({ from: msg.hostId, source: msg.mediaSource });
      }
      setStatus(`Joined room ${roomCode}. Press PLAY to start the room.`);
      log(`Joined ${roomCode} as ${clientId}`);
      return;
    }

    if (msg.type === 'hostChanged') {
      setRole(msg.hostId === clientId);
      if (msg.hostId === clientId && currentSource.kind === 'screen' && !sharing) {
        setSample(DEFAULT_SAMPLE, DEFAULT_SAMPLE_NAME, true);
        setStatus('You are now the host. The previous screen share has ended.');
      }
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
      if (currentSource.kind !== 'screen') sync.handleState(msg);
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

    if (msg.type === 'chat') {
      appendChat(msg);
      return;
    }

    if (msg.type === 'reaction') {
      addReaction(msg.emoji, msg.videoTime, msg.from, false);
      return;
    }

    if (msg.type === 'mediaSource') {
      handleMediaSource(msg);
      return;
    }

    if (msg.type === 'rtc-peer-left') {
      removeCallTiles(msg.from, msg.kind);
      if (msg.kind === 'screen' && currentSource.kind === 'screen' && currentSource.hostId === msg.from) {
        pendingScreenStream = null;
        setSample(DEFAULT_SAMPLE, DEFAULT_SAMPLE_NAME, false);
        setStatus('The sharer disconnected. Screen share ended.');
      }
      return;
    }

    if (msg.type.startsWith('rtc-')) {
      rtc.handleSignal(msg);
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
  if (currentSource.kind === 'screen') {
    setStatus('Screen share is live; play/pause is controlled by the sharing browser.');
    return;
  }
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
seek.addEventListener('pointercancel', () => { isSeeking = false; });
seek.addEventListener('keydown', () => { isSeeking = true; });
seek.addEventListener('keyup', () => { isSeeking = false; });
seek.addEventListener('input', () => {
  if (!video.duration || video.srcObject) return;
  video.currentTime = (Number(seek.value) / 1000) * video.duration;
  el('timeLabel').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
});
seek.addEventListener('change', () => sync.markLocalChange());

video.addEventListener('timeupdate', () => {
  if (!isSeeking && video.duration && !video.srcObject) {
    seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
  }
  el('timeLabel').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;
});

video.addEventListener('loadedmetadata', () => {
  sync.markLocalChange();
  if (currentSource.kind === 'local') {
    log(`Local file duration ${formatTime(video.duration)}`);
  }
});

video.addEventListener('error', () => {
  if (currentSource.kind === 'url') {
    setStatus('Remote URL could not be loaded. Check that it is a direct .mp4/.webm link.');
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => setSample(tab.dataset.src, tab.textContent.trim(), true));
});

el('loadUrlBtn').addEventListener('click', () => loadUrl(el('urlInput').value, true));
el('urlInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadUrl(el('urlInput').value, true);
});

el('fileInput').addEventListener('change', (event) => {
  loadFile(event.target.files[0], true);
});

screen.addEventListener('dragover', (event) => {
  event.preventDefault();
  screen.classList.add('dragover');
});
screen.addEventListener('dragleave', () => screen.classList.remove('dragover'));
screen.addEventListener('drop', (event) => {
  event.preventDefault();
  screen.classList.remove('dragover');
  loadFile(event.dataTransfer.files[0], true);
});

el('shareBtn').addEventListener('click', () => {
  if (sharing) stopScreenShare(false);
  else startScreenShare();
});

el('penBtn').addEventListener('click', (event) => {
  const tool = teles.setTool('pen');
  event.currentTarget.classList.toggle('active', tool === 'pen');
  el('arrowBtn').classList.remove('active');
});

el('arrowBtn').addEventListener('click', (event) => {
  const tool = teles.setTool('arrow');
  event.currentTarget.classList.toggle('active', tool === 'arrow');
  el('penBtn').classList.remove('active');
});

document.querySelectorAll('.swatch').forEach((swatch) => {
  swatch.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
    swatch.classList.add('active');
    teles.setColor(swatch.dataset.color);
  });
});

el('fadeToggle').addEventListener('change', (event) => {
  teles.setAutoFade(event.target.checked);
  log(`Auto-fade ${event.target.checked ? 'on' : 'off'}`);
});

el('clearBtn').addEventListener('click', () => {
  teles.clear(true);
  el('penBtn').classList.remove('active');
  el('arrowBtn').classList.remove('active');
  log('Canvas cleared for everyone');
});

document.querySelectorAll('.reaction').forEach((button) => {
  button.addEventListener('click', () => {
    addReaction(button.dataset.emoji, video.currentTime || 0, clientId, true);
  });
});

el('chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = el('chatInput');
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'chat', text, videoTime: video.currentTime || 0 });
  input.value = '';
});

el('clipBtn').addEventListener('click', () => {
  consensus.vote(video.currentTime || 0);
  log('Voted to clip this moment');
  setStatus('Clip vote sent. Waiting for the room threshold...');
});

el('clipNowBtn').addEventListener('click', () => clipAt(video.currentTime || 0));

el('stitchBtn').addEventListener('click', async () => {
  if (!ffmpegWorker) {
    setStatus('Clipping is not supported in this browser.');
    return;
  }
  if (clips.length < 2) {
    setStatus('Add at least two clips to the reel before stitching.');
    return;
  }
  const job = ++ffmpegJob;
  const buffers = [];
  reelDuration = clips.reduce((sum, clip) => sum + Math.max(0, clip.end - clip.start), 0);
  for (const clip of clips) buffers.push(await clip.blob.arrayBuffer());
  activeJobs.add(job);
  setStatus('Stitching the highlight reel...');
  ffmpegWorker.postMessage(
    { id: job, cmd: 'stitch', buffers, meta: { kind: 'reel', end: reelDuration } },
    buffers
  );
});

el('joinCallBtn').addEventListener('click', async () => {
  if (callJoined) {
    rtc.leave();
    callJoined = false;
    el('callTiles').innerHTML = '';
    pendingScreenStream = null;
    if (currentSource.kind === 'screen' && !sharing) {
      setSample(DEFAULT_SAMPLE, DEFAULT_SAMPLE_NAME, false);
    }
    el('joinCallBtn').textContent = 'JOIN CALL';
    el('muteBtn').disabled = true;
    el('camBtn').disabled = true;
    return;
  }
  try {
    const stream = await rtc.joinCall();
    renderCallTile(clientId, 'cam', stream, true);
    callJoined = true;
    el('joinCallBtn').textContent = 'LEAVE CALL';
    el('muteBtn').disabled = false;
    el('camBtn').disabled = false;
    setStatus('Call joined. Local preview is muted.');
  } catch (error) {
    log(`Could not join call: ${error.message}`);
    setStatus(`Could not join call: ${error.message}`);
  }
});

el('muteBtn').addEventListener('click', () => {
  const muted = rtc.toggleMic();
  el('muteBtn').textContent = muted ? 'UNMUTE' : 'MIC MUTE';
});

el('camBtn').addEventListener('click', () => {
  const off = rtc.toggleCam();
  el('camBtn').textContent = off ? 'CAM ON' : 'CAM TOGGLE';
});

if ('ResizeObserver' in window) new ResizeObserver(() => teles.resize()).observe(screen);
else window.addEventListener('resize', () => teles.resize());

window.addEventListener('beforeunload', () => {
  sync.stop();
  rtc.leave();
  for (const clip of clips) URL.revokeObjectURL(clip.url);
  if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
  for (const link of el('clips').querySelectorAll('a[href^="blob:"]')) {
    URL.revokeObjectURL(link.href);
  }
});

currentSource.src = DEFAULT_SAMPLE;
video.src = currentSource.src;
teles.resize();
connect();
