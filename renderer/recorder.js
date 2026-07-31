// Hidden-window recorder: captures Windows system audio (WASAPI loopback)
// + microphone, mixes them with WebAudio, and streams Opus/WebM chunks to
// the main process so long recordings never sit in memory.
let ctx = null;
let recorder = null;
let streams = [];
let sendQueue = Promise.resolve();

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

window.__start = async (lang) => {
  try {
    let sys = null;
    try {
      sys = await getSystemAudio();
      sys.getVideoTracks().forEach((t) => t.stop());
    } catch (e) {
      window.api.log(`no system audio (${e.message}) — continuing with mic only`);
    }
    let mic = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      window.api.log(`no microphone (${e.message}) — check Windows mic privacy settings`);
    }
    streams = [sys, mic].filter(Boolean);
    const withAudio = streams.filter((s) => s.getAudioTracks().length > 0);
    if (withAudio.length === 0) {
      throw new Error('No audio sources available (system audio and microphone both failed)');
    }

    ctx = new AudioContext({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();
    for (const s of withAudio) {
      const src = ctx.createMediaStreamSource(s);
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      src.connect(gain).connect(dest);
    }

    recorder = new MediaRecorder(dest.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 64000,
    });
    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      // serialize chunk delivery so ordering is guaranteed
      sendQueue = sendQueue.then(async () => window.api.chunk(await ev.data.arrayBuffer()));
    };
    recorder.onstop = async () => {
      await sendQueue;
      cleanup();
      window.api.done();
    };
    recorder.start(1000);
    window.api.log(`recording started (${lang}), sources: ${withAudio.length}`);
  } catch (err) {
    cleanup();
    window.api.error(err.message || String(err));
  }
};

window.__stop = () => {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
};

function cleanup() {
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  if (ctx) { ctx.close(); ctx = null; }
  recorder = null;
}
