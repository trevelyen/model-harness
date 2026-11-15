// Microphone audio out of the audio thread: mono float32 in blocks of 20 ms.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(Math.round(sampleRate / 50));
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0][0];
    if (!channel) return true;
    let at = 0;
    while (at < channel.length) {
      const take = Math.min(channel.length - at, this.block.length - this.filled);
      this.block.set(channel.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
