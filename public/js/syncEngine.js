// Clock-sync and playback reconciliation.
// The host is the only source of playback truth; guests correct toward it.

export class SyncEngine {
  constructor({ send, getVideo, onTelemetry }) {
    this.send = send;
    this.getVideo = getVideo;
    this.onTelemetry = onTelemetry;
    this.isHost = false;
    this.offset = 0;
    this.rtt = 0;
    this.drift = 0;
    this.hasOffset = false;
    this.version = -1;
    this.pingTimer = null;
    this.stateTimer = null;
    this.lastSeekAt = 0;
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  start() {
    this.ping();
    if (!this.pingTimer) this.pingTimer = setInterval(() => this.ping(), 2000);
  }

  stop() {
    clearInterval(this.pingTimer);
    clearInterval(this.stateTimer);
    this.pingTimer = null;
    this.stateTimer = null;
  }

  setHost(value) {
    this.isHost = !!value;
    clearInterval(this.stateTimer);
    this.stateTimer = null;
    if (this.isHost) {
      this.broadcastState();
      this.stateTimer = setInterval(() => this.broadcastState(), 1000);
    }
  }

  ping() {
    const t0 = Date.now();
    this.send({ type: 'ping', t0 });
  }

  handlePong(msg) {
    const { t0, t1, t2 } = msg;
    const t3 = Date.now();
    const sampleOffset = ((t1 - t0) + (t2 - t3)) / 2;
    const sampleRtt = Math.max(0, t3 - t0 - (t2 - t1));

    if (!this.hasOffset) {
      this.offset = sampleOffset;
      this.hasOffset = true;
    } else {
      this.offset = this.offset * 0.8 + sampleOffset * 0.2;
    }
    this.rtt = this.rtt ? this.rtt * 0.7 + sampleRtt * 0.3 : sampleRtt;
    this.emit();
  }

  broadcastState() {
    const video = this.getVideo();
    if (!video) return;
    this.send({
      type: 'state',
      playing: !video.paused,
      currentTime: video.currentTime,
      updatedAt: this.serverNow()
    });
  }

  markLocalChange() {
    if (this.isHost) this.broadcastState();
  }

  handleState(state) {
    if (this.isHost || !state) return;
    if (typeof state.version === 'number') {
      if (state.version <= this.version) return;
      this.version = state.version;
    }

    const video = this.getVideo();
    if (!video) return;

    const elapsed = state.playing ? Math.max(0, this.serverNow() - state.updatedAt) / 1000 : 0;
    const target = Math.max(0, state.currentTime + elapsed);
    const error = target - video.currentTime;
    this.drift = error;
    this.emit();

    if (Math.abs(error) > 0.4 && Date.now() - this.lastSeekAt > 900) {
      video.currentTime = target;
      this.lastSeekAt = Date.now();
    }

    const rate = state.playing ? clamp(1 + error * 0.08, 0.9, 1.1) : 1;
    if (Math.abs(video.playbackRate - rate) > 0.008) video.playbackRate = rate;

    if (state.playing && video.paused) video.play().catch(() => {});
    if (!state.playing && !video.paused) video.pause();
  }

  emit() {
    this.onTelemetry({
      offset: Math.round(this.offset),
      rtt: Math.round(this.rtt),
      drift: Math.round(this.drift * 1000)
    });
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
