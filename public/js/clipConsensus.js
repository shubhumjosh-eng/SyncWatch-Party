// Sliding-window "Clip That" consensus.
// The server counts unique voters inside a 5 second window and broadcasts
// a consensus event when the room threshold is reached.

export class ClipConsensus {
  constructor({ send, onCount, onConsensus }) {
    this.send = send;
    this.onCount = onCount;
    this.onConsensus = onConsensus;
  }

  vote(time) {
    this.send({ type: 'clipVote', time: Number(time) || 0 });
  }

  handleCount(msg) {
    this.onCount(msg);
  }

  handleConsensus(msg) {
    this.onConsensus(msg);
  }
}
