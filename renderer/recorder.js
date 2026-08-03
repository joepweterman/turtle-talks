// Hidden-window recorder.
// Meetings: records the microphone ("you") and Windows loopback audio ("them")
// as two separate tracks, rotated into standalone 1-minute webm segments so
// the main process can transcribe them live while the meeting continues.
// Shorter segments mean less audio still waiting to be transcribed when you
// press stop — that tail is what you wait for before the notes appear.
const CHUNK_MS = 60000;

let tracks = [];        // active TrackRecorder instances
let stopping = false;

class TrackRecorder {
  constructor(name, stream) {
    this.name = name;         // 'mic' | 'sys'
    this.stream = stream;
    this.index = -1;
    this.recorder = null;
    this.queue = Promise.resolve();
    this.timer = null;
    this.stopped = false;
    this.pending = 0;         // segments not yet fully flushed
    this.onAllFlushed = null;
  }

  startSegment() {
    this.index += 1;
    const index = this.index;
    window.api.segStart(this.name, index, Date.now());
    this.pending += 1;
    const rec = new MediaRecorder(this.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 64000,
    });
    this.recorder = rec;
    rec.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      this.queue = this.queue.then(async () => {
        window.api.segChunk(this.name, index, await ev.data.arrayBuffer());
      });
    };
    rec.onstop = async () => {
      await this.queue;
      window.api.segDone(this.name, index);
      this.pending -= 1;
      if (this.stopped && this.pending === 0 && this.onAllFlushed) this.onAllFlushed();
    };
    rec.start(1000);
  }

  rotate() {
    if (this.stopped || !this.recorder || this.recorder.state === 'inactive') return;
    this.recorder.stop();
    this.startSegment();
  }

  start() {
    this.startSegment();
    this.timer = setInterval(() => this.rotate(), CHUNK_MS);
  }

  stop() {
    return new Promise((resolve) => {
      this.stopped = true;
      clearInterval(this.timer);
      this.onAllFlushed = resolve;
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      else if (this.pending === 0) resolve();
    });
  }
}

async function getSystemAudio() {
  try {
    // Windows loopback via the legacy desktop-capture constraint
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: { mandatory: { chromeMediaSource: 'desktop' } },
    });
    window.api.log('system audio via desktop capture');
    return s;
  } catch (e) {
    window.api.log(`desktop capture failed (${e.message}), trying getDisplayMedia`);
    const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    window.api.log('system audio via getDisplayMedia loopback');
    return s;
  }
}

window.__start = async () => {
  try {
    stopping = false;
    tracks = [];
    let sys = null;
    try {
      sys = await getSystemAudio();
      sys.getVideoTracks().forEach((t) => t.stop());
    } catch (e) {
      window.api.log(`no system audio (${e.message}) — continuing with mic only`);
    }
    let mic = null;
    try {
      // echo cancellation keeps the speakers' sound out of the mic track,
      // which is what makes the you/them split work without a headset
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      window.api.log(`no microphone (${e.message}) — check Windows mic privacy settings`);
    }
    if (mic && mic.getAudioTracks().length) tracks.push(new TrackRecorder('mic', mic));
    if (sys && sys.getAudioTracks().length) tracks.push(new TrackRecorder('sys', sys));
    if (tracks.length === 0) {
      throw new Error('No audio sources available (system audio and microphone both failed)');
    }
    tracks.forEach((t) => t.start());
    window.api.log(`recording started, tracks: ${tracks.map((t) => t.name).join('+')}`);
  } catch (err) {
    cleanupMeeting();
    window.api.error(err.message || String(err));
  }
};

window.__stop = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all(tracks.map((t) => t.stop()));
  cleanupMeeting();
  window.api.done();
};

function cleanupMeeting() {
  tracks.forEach((t) => t.stream.getTracks().forEach((tr) => tr.stop()));
  tracks = [];
}

// ---------- dictation: mic only, independent of the meeting recorder ----------
// Records 16kHz mono Int16 PCM via an AudioWorklet so the main process can
// hand whisper a ready WAV — no webm decode between stop and transcription.
let dictStream = null;
let dictCtx = null;
let dictNode = null;

function dictCleanupAudio() {
  if (dictStream) dictStream.getTracks().forEach((t) => t.stop());
  if (dictCtx) dictCtx.close().catch(() => {});
  dictStream = null;
  dictCtx = null;
  dictNode = null;
}

window.__dictStart = async () => {
  try {
    dictStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    dictCtx = new AudioContext({ sampleRate: 16000 });
    await dictCtx.audioWorklet.addModule('pcm-worklet.js');
    dictNode = new AudioWorkletNode(dictCtx, 'pcm-capture');
    dictNode.port.onmessage = (ev) => {
      if (ev.data === 'flushed') {
        dictCleanupAudio();
        window.api.dictDone();
      } else {
        window.api.dictChunk(ev.data);
      }
    };
    dictCtx.createMediaStreamSource(dictStream).connect(dictNode);
    await dictCtx.resume();
    window.api.log('dictation started (16k pcm)');
  } catch (err) {
    dictCleanupAudio();
    window.api.dictError(err.message || String(err));
  }
};

window.__dictStop = () => {
  if (dictNode) dictNode.port.postMessage('flush');
};
