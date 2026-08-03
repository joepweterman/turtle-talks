// GPU transcription via OpenVINO (lib/ov-worker.py). Optional: only activates
// when ~\MeetingNotes\ov holds the venv + a converted whisper model (see
// scripts/setup-openvino.ps1). Dictation tries this first — a 14s utterance
// takes ~1-2s on the Arc iGPU vs ~4.3s for whisper.cpp small on the CPU —
// and falls back to whisper.cpp when the worker is missing, loading, or dead.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OV_DIR = path.join(os.homedir(), 'MeetingNotes', 'ov');
const PYTHON = path.join(OV_DIR, 'venv', 'Scripts', 'python.exe');
// medium: more accurate than whisper.cpp's small AND ~4x faster on GPU
const MODEL_PREFERENCE = ['whisper-medium-int8-ov', 'whisper-large-v3-int8-ov', 'whisper-base-int8-ov'];

function modelDir() {
  for (const m of MODEL_PREFERENCE) {
    const p = path.join(OV_DIR, m);
    if (fs.existsSync(path.join(p, 'openvino_encoder_model.xml'))) return p;
  }
  return null;
}

function available() {
  return fs.existsSync(PYTHON) && !!modelDir();
}

// worker script lives unpacked next to the asar when packaged
function workerScript() {
  return path.join(__dirname, 'ov-worker.py').replace('app.asar', 'app.asar.unpacked');
}

let proc = null;
let ready = false;
let dead = false; // crashed once → stay on whisper.cpp until next app start
let nextId = 1;
const pending = new Map(); // id → {resolve, timer}

function start() {
  if (proc || dead || !available()) return;
  const model = modelDir();
  proc = spawn(PYTHON, [workerScript(), model, 'GPU'], { windowsHide: true });
  console.log(`[ov] starting worker: ${path.basename(model)} on GPU`);
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) {
        ready = true;
        console.log(`[ov] model loaded in ${msg.load_s}s`);
        continue;
      }
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('error', () => {});
  proc.on('close', (code) => {
    if (!dead) console.log(`[ov] worker exited (${code}) — falling back to whisper.cpp`);
    ready = false;
    dead = true;
    proc = null;
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(null); }
    pending.clear();
  });
}

// Resolves with the transcript text; throws when the GPU path can't serve —
// callers catch and run whisper.cpp instead.
function transcribe(wavPath, lang, prompt, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!proc || !ready) return reject(new Error('ov worker not ready'));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('ov worker timeout'));
    }, timeoutMs);
    pending.set(id, {
      timer,
      resolve: (msg) => {
        if (msg && msg.ok) resolve(msg.text);
        else reject(new Error(msg ? msg.error : 'ov worker gone'));
      },
    });
    const req = { id, wav: wavPath, lang: lang && lang !== 'auto' ? lang : null, prompt: prompt || null };
    try { proc.stdin.write(`${JSON.stringify(req)}\n`); } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

module.exports = { start, transcribe, available, OV_DIR };
