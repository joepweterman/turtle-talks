// Captures mono Float32 audio, converts to Int16 PCM and posts it to the
// renderer in ~0.5s batches. 'flush' → posts the remainder, then 'flushed'.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.len = 0;
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage('flushed');
    };
  }

  flush() {
    if (this.len === 0) return;
    const out = new Int16Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    this.chunks = [];
    this.len = 0;
    this.port.postMessage(out.buffer, [out.buffer]);
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      const i16 = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.chunks.push(i16);
      this.len += i16.length;
      if (this.len >= 8192) this.flush(); // ~0.5s at 16kHz
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
