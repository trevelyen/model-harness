// Plays the service's audio as it arrives. Chunks queue up and are played in
// order; after running dry it waits for a little audio before resuming, so a
// late chunk costs one short gap instead of a string of clicks. For a service
// that sends audio as fast as it plays, a queue that has grown too long drops
// its oldest audio to stay close to live; one that sends ahead (`ahead`) keeps
// it all. The message 'clear' drops everything queued: the person cut in.
const PRIME_SECONDS = 0.04;
const MAX_SECONDS = 0.6;

class Playback extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.max = options.processorOptions?.ahead ? Infinity : MAX_SECONDS * sampleRate;
    this.chunks = [];
    this.offset = 0; // samples of chunks[0] already played
    this.queued = 0;
    this.primed = false;
    this.port.onmessage = (event) => {
      if (event.data === 'clear') {
        this.chunks = [];
        this.offset = this.queued = 0;
        this.primed = false;
        return;
      }
      this.chunks.push(event.data);
      this.queued += event.data.length;
      while (this.queued > this.max && this.chunks.length > 1) {
        this.queued -= this.chunks.shift().length - this.offset;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.primed) {
      if (this.queued < PRIME_SECONDS * sampleRate) return true;
      this.primed = true;
    }
    let at = 0;
    while (at < out.length && this.chunks.length) {
      const chunk = this.chunks[0];
      const take = Math.min(out.length - at, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + take), at);
      at += take;
      this.offset += take;
      this.queued -= take;
      if (this.offset === chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    if (at < out.length) this.primed = false;
    return true;
  }
}

registerProcessor('playback', Playback);
