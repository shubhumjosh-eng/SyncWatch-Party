// Lightweight WebRTC signaling + stream manager.
// One RTCPeerConnection per peer per stream kind: 'cam' or 'screen'.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export class RTCCall {
  constructor({ send, getPeers, onStream, onLog }) {
    this.send = send;
    this.getPeers = getPeers;
    this.onStream = onStream;
    this.onLog = onLog;
    this.connections = new Map();
    this.localCam = null;
    this.localScreen = null;
    this.micMuted = false;
    this.camOff = false;
  }

  key(peer, kind) {
    return `${peer}:${kind}`;
  }

  log(text) {
    if (this.onLog) this.onLog(text);
  }

  createConnection(peer, kind) {
    const key = this.key(peer, kind);
    if (this.connections.has(key)) return this.connections.get(key);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const conn = { pc, kind, pendingIce: [], remoteReady: false };
    this.connections.set(key, conn);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({ type: 'rtc-ice', to: peer, kind, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (this.onStream) this.onStream({ id: peer, kind, stream });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.closeConnection(peer, kind);
    };

    return conn;
  }

  addLocalTracks(pc, kind) {
    const stream = kind === 'screen' ? this.localScreen : this.localCam;
    if (!stream) return false;
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    return true;
  }

  async offer(peer, kind) {
    const conn = this.createConnection(peer, kind);
    if (conn.pc.signalingState !== 'stable') return;
    this.addLocalTracks(conn.pc, kind);

    const description = await conn.pc.createOffer();
    await conn.pc.setLocalDescription(description);
    this.send({ type: 'rtc-offer', to: peer, kind, description: conn.pc.localDescription });
    this.log(`Offered ${kind} stream to ${peer}`);
  }

  async handleOffer(msg) {
    const kind = msg.kind || 'cam';
    const conn = this.createConnection(msg.from, kind);
    await conn.pc.setRemoteDescription(msg.description);
    conn.remoteReady = true;

    if (kind === 'cam' && this.localCam) {
      this.addLocalTracks(conn.pc, kind);
    } else {
      for (const transceiver of conn.pc.getTransceivers()) {
        if (transceiver.receiver) transceiver.direction = 'recvonly';
      }
    }

    await this.flushIce(conn);
    const answer = await conn.pc.createAnswer();
    await conn.pc.setLocalDescription(answer);
    this.send({ type: 'rtc-answer', to: msg.from, kind, description: conn.pc.localDescription });
    this.log(`Answered ${kind} offer from ${msg.from}`);
  }

  async handleAnswer(msg) {
    const kind = msg.kind || 'cam';
    const conn = this.connections.get(this.key(msg.from, kind));
    if (!conn) return;
    await conn.pc.setRemoteDescription(msg.description);
    conn.remoteReady = true;
    await this.flushIce(conn);
  }

  async handleIce(msg) {
    const kind = msg.kind || 'cam';
    const conn = this.connections.get(this.key(msg.from, kind));
    if (!conn) return;
    if (!conn.remoteReady) {
      conn.pendingIce.push(msg.candidate);
      return;
    }
    try {
      await conn.pc.addIceCandidate(msg.candidate);
    } catch {
      this.log(`Dropped ICE candidate from ${msg.from}`);
    }
  }

  async flushIce(conn) {
    while (conn.pendingIce.length) {
      const candidate = conn.pendingIce.shift();
      try {
        await conn.pc.addIceCandidate(candidate);
      } catch {
        // Ignore stale candidates.
      }
    }
  }

  closeConnection(peer, kind) {
    const key = this.key(peer, kind);
    const conn = this.connections.get(key);
    if (!conn) return;
    conn.pc.close();
    this.connections.delete(key);
  }

  handleLeave(msg) {
    const kind = msg.kind || 'cam';
    this.closeConnection(msg.from, kind);
    this.log(`${msg.from} left the ${kind} stream`);
  }

  handleSignal(msg) {
    if (msg.type === 'rtc-offer') return this.handleOffer(msg);
    if (msg.type === 'rtc-answer') return this.handleAnswer(msg);
    if (msg.type === 'rtc-ice') return this.handleIce(msg);
    if (msg.type === 'rtc-leave') return this.handleLeave(msg);
    if (msg.type === 'rtc-meta') this.log(`${msg.from}: ${msg.note || 'RTC update'}`);
  }

  async joinCall() {
    if (!this.localCam) {
      this.localCam = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      this.log('Camera and microphone connected');
    }
    for (const peer of this.getPeers()) await this.offer(peer, 'cam');
    return this.localCam;
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

  async startScreenShare(stream) {
    this.localScreen = stream;
    for (const peer of this.getPeers()) await this.offer(peer, 'screen');
    this.log('Screen stream shared with the room');
  }

  stopScreenShare() {
    if (!this.localScreen) return;
    for (const peer of this.getPeers()) {
      this.send({ type: 'rtc-leave', to: peer, kind: 'screen' });
      this.closeConnection(peer, 'screen');
    }
    for (const track of this.localScreen.getTracks()) track.stop();
    this.localScreen = null;
    this.log('Screen share stopped');
  }

  leave() {
    for (const peer of this.getPeers()) this.send({ type: 'rtc-leave', to: peer, kind: 'cam' });
    for (const [key, conn] of [...this.connections]) {
      conn.pc.close();
      this.connections.delete(key);
    }
    if (this.localCam) {
      for (const track of this.localCam.getTracks()) track.stop();
      this.localCam = null;
    }
    this.log('Left the call');
  }
}
