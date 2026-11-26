// Lightweight WebRTC signaling + stream manager.
// One RTCPeerConnection per peer per stream kind: 'cam' or 'screen'.
// Uses "perfect negotiation" so simultaneous offers (glare) cannot deadlock.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const VALID_KINDS = new Set(['cam', 'screen']);
const MAX_ID_LENGTH = 128;
const MAX_SDP_LENGTH = 256 * 1024;
const MAX_CANDIDATE_LENGTH = 4096;
const MAX_TOKEN_LENGTH = 256;
const MAX_PENDING_ICE = 64;

export class RTCCall {
  constructor({ send, getPeers, onStream, onLog, onError, onPeerLeft, localId, getLocalId } = {}) {
    this.send = typeof send === 'function' ? send : () => {};
    this.getPeers = typeof getPeers === 'function' ? getPeers : () => [];
    this.onStream = typeof onStream === 'function' ? onStream : null;
    this.onLog = typeof onLog === 'function' ? onLog : null;

    // Optional, backwards-compatible additions. app.js may set these as
    // properties at any time too (e.g. rtc.onPeerLeft = fn).
    this.onError = typeof onError === 'function' ? onError : null;
    this.onPeerLeft = typeof onPeerLeft === 'function' ? onPeerLeft : null;
    this.getLocalId = typeof getLocalId === 'function'
      ? getLocalId
      : (localId != null ? () => localId : null);

    // Remote audio can be muted without touching DOM elements owned by app.js.
    this.remoteMuted = false;

    this.connections = new Map();
    this.peerLeftEvents = new Set();
    this.localCam = null;
    this.localScreen = null;
    this.micMuted = false;
    this.camOff = false;
  }

  key(peer, kind) {
    return `${peer}:${kind}`;
  }

  log(text) {
    if (typeof this.onLog !== 'function') return;
    try {
      this.onLog(String(text).slice(0, 300));
    } catch {
      // Logging must never break signaling.
    }
  }

  error(label, err) {
    const message = err && err.message ? err.message : String(err);
    const wrapped = new Error(`${label}: ${message}`);
    if (typeof this.onError === 'function') {
      try {
        this.onError(wrapped);
      } catch {
        // Consumer callback failures must not create unhandled rejections.
      }
    }
    this.log(wrapped.message);
  }

  // Run a (possibly async) action and guarantee the returned promise settles
  // successfully. Every signaling entry point goes through here.
  run(action, label) {
    try {
      return Promise.resolve(action()).catch((err) => {
        this.error(label, err);
      });
    } catch (err) {
      this.error(label, err);
      return Promise.resolve();
    }
  }

  emitError(label, err) {
    this.error(label, err);
  }

  safeId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    const id = String(value).trim();
    if (!id || id.length > MAX_ID_LENGTH) return null;
    return id;
  }

  validKind(kind) {
    return VALID_KINDS.has(kind) ? kind : 'cam';
  }

  localId() {
    if (typeof this.getLocalId !== 'function') return null;
    try {
      return this.safeId(this.getLocalId());
    } catch (err) {
      this.error('getLocalId', err);
      return null;
    }
  }

  // Validate envelope fields (from/target) before touching a connection.
  envelopePeer(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const from = this.safeId(msg.from);
    if (!from) return null;
    const localId = this.localId();
    if (localId && from === localId) return null;
    if (msg.to !== undefined && msg.to !== null && msg.to !== '') {
      const to = this.safeId(msg.to);
      if (!to || (localId && to !== localId)) return null;
    }
    return from;
  }

  validateDescription(description) {
    if (!description || typeof description !== 'object') return null;
    if (description.type !== 'offer' && description.type !== 'answer') return null;
    if (typeof description.sdp !== 'string') return null;
    const sdp = description.sdp;
    if (!sdp || sdp.length > MAX_SDP_LENGTH) return null;
    return { type: description.type, sdp };
  }

  validateCandidate(candidate) {
    if (candidate === null || candidate === undefined) return null;
    let raw = candidate;
    if (typeof raw === 'string') raw = { candidate: raw };
    if (typeof raw !== 'object') return null;

    const sdp = raw.candidate === null || raw.candidate === undefined
      ? ''
      : raw.candidate;
    if (typeof sdp !== 'string' || sdp.length > MAX_CANDIDATE_LENGTH) return null;

    const init = { candidate: sdp };
    if (raw.sdpMid !== undefined && raw.sdpMid !== null) {
      if (typeof raw.sdpMid !== 'string' || raw.sdpMid.length > MAX_TOKEN_LENGTH) return null;
      init.sdpMid = raw.sdpMid;
    }
    if (raw.sdpMLineIndex !== undefined && raw.sdpMLineIndex !== null) {
      if (!Number.isInteger(raw.sdpMLineIndex) || raw.sdpMLineIndex < 0 || raw.sdpMLineIndex > 255) return null;
      init.sdpMLineIndex = raw.sdpMLineIndex;
    }
    if (raw.usernameFragment !== undefined && raw.usernameFragment !== null) {
      if (typeof raw.usernameFragment !== 'string' || raw.usernameFragment.length > MAX_TOKEN_LENGTH) return null;
      init.usernameFragment = raw.usernameFragment;
    }
    return init;
  }

  safeNote(note) {
    if (typeof note !== 'string' && typeof note !== 'number') return '';
    return String(note).replace(/[\r\n]+/g, ' ').slice(0, 200);
  }

  peerList() {
    let peers;
    try {
      peers = this.getPeers();
    } catch (err) {
      this.error('getPeers', err);
      return [];
    }
    if (!Array.isArray(peers)) return [];
    const localId = this.localId();
    return peers
      .map((peer) => this.safeId(peer))
      .filter((peer) => peer && peer !== localId);
  }

  sendSignal(payload) {
    const to = this.safeId(payload && payload.to);
    if (!to) return false;
    try {
      this.send({ ...payload, to });
      return true;
    } catch (err) {
      this.error('send', err);
      return false;
    }
  }

  // Deterministic roles: with a local id, one side is polite and the other
  // impolite. Without one we default to polite; two polite peers still resolve
  // glare, whereas two impolite peers would deadlock.
  isPolite(peer) {
    const localId = this.localId();
    if (!localId) return true;
    return String(localId) > String(peer);
  }

  createConnection(peer, kind) {
    const safePeer = this.safeId(peer);
    if (!safePeer) return null;
    const safeKind = this.validKind(kind);
    const key = this.key(safePeer, safeKind);
    if (this.connections.has(key)) return this.connections.get(key);
    this.peerLeftEvents.delete(key);

    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (err) {
      this.error('createConnection', err);
      return null;
    }

    const conn = {
      pc,
      peer: safePeer,
      kind: safeKind,
      key,
      polite: this.isPolite(safePeer),
      makingOffer: false,
      ignoreOffer: false,
      remoteReady: false,
      localTracksAdded: false,
      pendingIce: [],
      flushing: null,
      closed: false,
      peerLeftEmitted: false,
      localClose: false,
      remoteStreams: new Set()
    };
    this.connections.set(key, conn);

    pc.onnegotiationneeded = () => {
      this.run(() => {
        if (conn.closed || conn.makingOffer || pc.signalingState !== 'stable') return;
        return this.makeOffer(conn);
      }, 'negotiationneeded');
    };

    pc.onicecandidate = (event) => {
      if (!event || !event.candidate) return;
      const candidate = this.validateCandidate(event.candidate);
      if (!candidate) return;
      this.sendSignal({ type: 'rtc-ice', to: safePeer, kind: safeKind, candidate });
    };

    pc.ontrack = (event) => {
      if (!event || !event.track) return;
      const stream = (event.streams && event.streams[0]) || new MediaStream([event.track]);
      conn.remoteStreams.add(stream);
      if (this.remoteMuted) {
        for (const track of stream.getAudioTracks()) {
          try {
            track.enabled = false;
          } catch {
            // Ignore tracks that cannot be disabled.
          }
        }
      }
      if (typeof this.onStream !== 'function') return;
      try {
        this.onStream({ id: safePeer, kind: safeKind, stream });
      } catch (err) {
        this.error('onStream', err);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed') {
        this.log(`RTC connection to ${safePeer} (${safeKind}) failed`);
        this.emitPeerLeft(safePeer, safeKind, 'failed');
        this.closeConnection(safePeer, safeKind);
      } else if (state === 'closed' && !conn.localClose) {
        this.emitPeerLeft(safePeer, safeKind, 'closed');
      }
    };

    return conn;
  }

  addLocalTracks(pc, kind, conn) {
    const stream = kind === 'screen' ? this.localScreen : this.localCam;
    if (!stream || typeof stream.getTracks !== 'function') return false;
    const target = conn || [...this.connections.values()].find((c) => c.pc === pc);
    if (!target || target.localTracksAdded || target.closed) return true;
    try {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      target.localTracksAdded = true;
      return true;
    } catch (err) {
      this.error('addLocalTracks', err);
      return false;
    }
  }

  async makeOffer(conn) {
    if (!conn || conn.closed || conn.pc.signalingState === 'closed') return;
    if (conn.makingOffer || conn.pc.signalingState !== 'stable') return;

    conn.makingOffer = true;
    try {
      this.addLocalTracks(conn.pc, conn.kind, conn);
      const description = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(description);
      const local = this.validateDescription(conn.pc.localDescription);
      if (!local) {
        this.log(`Dropped invalid local offer for ${conn.peer}`);
        return;
      }
      this.sendSignal({
        type: 'rtc-offer',
        to: conn.peer,
        kind: conn.kind,
        description: local
      });
      this.log(`Offered ${conn.kind} stream to ${conn.peer}`);
    } finally {
      conn.makingOffer = false;
    }
  }

  offer(peer, kind) {
    const conn = this.createConnection(peer, kind);
    if (!conn) return Promise.resolve();
    return this.run(() => this.makeOffer(conn), 'offer');
  }

  processOffer(msg) {
    const from = this.envelopePeer(msg);
    const kind = this.validKind(msg.kind);
    const description = this.validateDescription(msg.description);
    if (!from || !description || description.type !== 'offer') {
      this.log('Dropped invalid rtc-offer');
      return Promise.resolve();
    }

    return (async () => {
      const conn = this.createConnection(from, kind);
      if (!conn || conn.closed) return;

      const collision = conn.makingOffer || conn.pc.signalingState !== 'stable';
      conn.ignoreOffer = !conn.polite && collision;
      if (conn.ignoreOffer) {
        this.log(`Ignored colliding ${kind} offer from ${from} (impolite peer)`);
        return;
      }

      if (collision && conn.polite && conn.pc.signalingState !== 'stable') {
        try {
          await conn.pc.setRemoteDescription({ type: 'rollback' });
        } catch (err) {
          this.error('rollback', err);
          return;
        }
      }

      await conn.pc.setRemoteDescription(description);
      conn.remoteReady = true;
      conn.ignoreOffer = false;

      const localStream = kind === 'screen' ? this.localScreen : this.localCam;
      if (localStream) {
        this.addLocalTracks(conn.pc, kind, conn);
      } else {
        try {
          for (const transceiver of conn.pc.getTransceivers()) {
            if (transceiver.receiver && transceiver.direction !== 'recvonly') {
              transceiver.direction = 'recvonly';
            }
          }
        } catch (err) {
          this.error('recvonly', err);
        }
      }

      await this.flushIce(conn);

      const answer = await conn.pc.createAnswer();
      await conn.pc.setLocalDescription(answer);
      const local = this.validateDescription(conn.pc.localDescription);
      if (local) {
        this.sendSignal({ type: 'rtc-answer', to: from, kind, description: local });
      }
      this.log(`Answered ${kind} offer from ${from}`);
    })();
  }

  handleOffer(msg) {
    return this.run(() => this.processOffer(msg), 'handleOffer');
  }

  processAnswer(msg) {
    const from = this.envelopePeer(msg);
    const kind = this.validKind(msg.kind);
    const description = this.validateDescription(msg.description);
    if (!from || !description || description.type !== 'answer') {
      this.log('Dropped invalid rtc-answer');
      return Promise.resolve();
    }
    const conn = this.connections.get(this.key(from, kind));
    if (!conn || conn.closed) return Promise.resolve();

    return (async () => {
      if (conn.pc.signalingState !== 'have-local-offer') {
        this.log(`Ignored ${kind} answer from ${from} in state ${conn.pc.signalingState}`);
        return;
      }
      await conn.pc.setRemoteDescription(description);
      conn.remoteReady = true;
      conn.ignoreOffer = false;
      await this.flushIce(conn);
    })();
  }

  handleAnswer(msg) {
    return this.run(() => this.processAnswer(msg), 'handleAnswer');
  }

  processIce(msg) {
    const from = this.envelopePeer(msg);
    const kind = this.validKind(msg.kind);
    const candidate = this.validateCandidate(msg.candidate);
    if (!from || !candidate) {
      this.log('Dropped invalid rtc-ice');
      return Promise.resolve();
    }
    const conn = this.connections.get(this.key(from, kind));
    if (!conn || conn.closed) return Promise.resolve();

    if (!conn.remoteReady || !conn.pc.remoteDescription) {
      if (conn.pendingIce.length >= MAX_PENDING_ICE) conn.pendingIce.shift();
      conn.pendingIce.push(candidate);
      return Promise.resolve();
    }
    return this.addIce(conn, candidate);
  }

  handleIce(msg) {
    return this.run(() => this.processIce(msg), 'handleIce');
  }

  addIce(conn, candidate) {
    if (!conn || conn.closed || conn.pc.signalingState === 'closed') return Promise.resolve();
    return Promise.resolve(conn.pc.addIceCandidate(candidate)).catch(() => {
      // Stale candidates are expected during glare/rollback.
      if (!conn.ignoreOffer) this.log(`Dropped ICE candidate from ${conn.peer}`);
    });
  }

  flushIce(conn) {
    if (!conn || conn.flushing) return conn ? conn.flushing : Promise.resolve();
    conn.flushing = this.run(() => {
      const queued = conn.pendingIce.slice(0, MAX_PENDING_ICE);
      conn.pendingIce.length = 0;
      return (async () => {
        for (const candidate of queued) {
          if (conn.closed) break;
          await this.addIce(conn, candidate);
        }
      })();
    }, 'flushIce').then(() => {
      conn.flushing = null;
    });
    return conn.flushing;
  }

  closeConnection(peer, kind) {
    const safePeer = this.safeId(peer);
    if (!safePeer) return;
    const key = this.key(safePeer, this.validKind(kind));
    const conn = this.connections.get(key);
    if (!conn) return;
    conn.closed = true;
    conn.localClose = true;
    conn.pendingIce.length = 0;
    try {
      conn.pc.close();
    } catch (err) {
      this.error('closeConnection', err);
    }
    this.connections.delete(key);
  }

  emitPeerLeft(peer, kind, reason) {
    const key = this.key(peer, kind);
    if (this.peerLeftEvents.has(key)) return;
    this.peerLeftEvents.add(key);
    const conn = this.connections.get(key);
    if (conn) conn.peerLeftEmitted = true;
    if (typeof this.onPeerLeft !== 'function') return;
    try {
      this.onPeerLeft({ id: peer, from: peer, kind, reason });
    } catch (err) {
      this.error('onPeerLeft', err);
    }
  }

  handleLeave(msg) {
    return this.run(() => {
      const from = this.envelopePeer(msg);
      if (!from) {
        this.log('Dropped invalid rtc-leave');
        return;
      }
      const kind = this.validKind(msg.kind);
      this.emitPeerLeft(from, kind, 'signal');
      this.closeConnection(from, kind);
      this.log(`${from} left the ${kind} stream`);
    }, 'handleLeave');
  }

  handleSignal(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return Promise.resolve();
    }
    const type = msg.type;
    if (type === 'rtc-offer') return this.handleOffer(msg);
    if (type === 'rtc-answer') return this.handleAnswer(msg);
    if (type === 'rtc-ice') return this.handleIce(msg);
    if (type === 'rtc-leave') return this.handleLeave(msg);
    if (type === 'rtc-meta') {
      return this.run(() => {
        const from = this.envelopePeer(msg);
        if (from) this.log(`${from}: ${this.safeNote(msg.note) || 'RTC update'}`);
      }, 'rtc-meta');
    }
    return Promise.resolve();
  }

  async joinCall() {
    try {
      if (!this.localCam) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('getUserMedia is not available');
        }
        this.localCam = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        this.log('Camera and microphone connected');
      }
      for (const peer of this.peerList()) await this.offer(peer, 'cam');
      return this.localCam;
    } catch (err) {
      this.error('joinCall', err);
      throw err;
    }
  }

  toggleMic() {
    if (!this.localCam) return false;
    this.micMuted = !this.micMuted;
    for (const track of this.localCam.getAudioTracks()) track.enabled = !this.micMuted;
    return this.micMuted;
  }

  toggleCam() {
    if (!this.localCam) return false;
    this.camOff = !this.camOff;
    for (const track of this.localCam.getVideoTracks()) track.enabled = !this.camOff;
    return this.camOff;
  }

  stopTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch (err) {
        this.error('stopTracks', err);
      }
    }
  }

  async startScreenShare(stream) {
    if (!stream || typeof stream.getTracks !== 'function') {
      const err = new Error('Invalid screen stream');
      this.error('startScreenShare', err);
      throw err;
    }
    try {
      if (this.localScreen && this.localScreen !== stream) this.stopTracks(this.localScreen);
      this.localScreen = stream;
      for (const peer of this.peerList()) {
        this.sendSignal({ type: 'rtc-leave', to: peer, kind: 'screen' });
        this.closeConnection(peer, 'screen');
      }
      for (const peer of this.peerList()) await this.offer(peer, 'screen');
      this.log('Screen stream shared with the room');
    } catch (err) {
      this.error('startScreenShare', err);
      throw err;
    }
  }

  stopScreenShare() {
    for (const peer of this.peerList()) {
      this.sendSignal({ type: 'rtc-leave', to: peer, kind: 'screen' });
      this.closeConnection(peer, 'screen');
    }
    // Stop any screen sender tracks, including ones retained on a connection
    // whose localScreen reference was already cleared.
    for (const conn of [...this.connections.values()]) {
      if (conn.kind !== 'screen') continue;
      for (const sender of conn.pc.getSenders()) {
        if (sender.track) this.stopTracks(new MediaStream([sender.track]));
      }
      this.closeConnection(conn.peer, 'screen');
    }
    if (this.localScreen) {
      this.stopTracks(this.localScreen);
      this.localScreen = null;
    }
    this.log('Screen share stopped');
  }

  leave() {
    const peers = this.peerList();
    for (const peer of peers) {
      this.sendSignal({ type: 'rtc-leave', to: peer, kind: 'cam' });
      this.sendSignal({ type: 'rtc-leave', to: peer, kind: 'screen' });
    }
    for (const conn of [...this.connections.values()]) {
      for (const sender of conn.pc.getSenders()) {
        if (sender.track) this.stopTracks(new MediaStream([sender.track]));
      }
      conn.closed = true;
      conn.localClose = true;
      conn.pendingIce.length = 0;
      try {
        conn.pc.close();
      } catch (err) {
        this.error('leave', err);
      }
    }
    this.connections.clear();
    this.peerLeftEvents.clear();
    this.stopTracks(this.localCam);
    this.stopTracks(this.localScreen);
    this.localCam = null;
    this.localScreen = null;
    this.micMuted = false;
    this.camOff = false;
    this.remoteMuted = false;
    this.log('Left the call');
  }

  // Public helper: mute/unmute audio on known remote streams for a peer.
  // app.js still owns the <video> elements and should set video.muted too.
  setRemoteAudioMuted(peer, kind, muted) {
    const conn = this.connections.get(this.key(this.safeId(peer), this.validKind(kind)));
    this.remoteMuted = !!muted;
    if (!conn) return false;
    const streams = new Set(conn.remoteStreams);
    try {
      for (const receiver of conn.pc.getReceivers()) {
        if (receiver.track) streams.add(new MediaStream([receiver.track]));
      }
    } catch (err) {
      this.error('setRemoteAudioMuted', err);
    }
    let changed = false;
    for (const stream of streams) {
      for (const track of stream.getAudioTracks()) {
        try {
          track.enabled = !this.remoteMuted;
          changed = true;
        } catch (err) {
          this.error('setRemoteAudioMuted', err);
        }
      }
    }
    return changed;
  }
}
