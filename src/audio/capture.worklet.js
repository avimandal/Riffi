// Collects mono microphone audio off the main thread and posts it in
// batches, stamped with the audio-clock frame of the first sample.
const BATCH = 1024;

class RiffiCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BATCH);
    this.n = 0;
    this.firstFrame = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        if (this.n === 0) this.firstFrame = currentFrame + i;
        this.buf[this.n++] = ch[i];
        if (this.n === BATCH) {
          this.port.postMessage({ samples: this.buf, frame: this.firstFrame }, [this.buf.buffer]);
          this.buf = new Float32Array(BATCH);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('riffi-capture', RiffiCapture);
