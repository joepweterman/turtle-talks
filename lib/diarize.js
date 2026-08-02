// Local speaker diarization via sherpa-onnx (fully offline).
// Used when several people share one microphone: splits the mic track into
// speaker_00 / speaker_01 / … segments. Binaries + models live in
// ~\MeetingNotes\diarize (see scripts/setup-diarize.ps1).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIARIZE_DIR = path.join(os.homedir(), 'MeetingNotes', 'diarize');

function findFileRec(dir, test) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (test(entry.name)) return full;
    }
  }
  return null;
}

function findParts() {
  const exe = findFileRec(DIARIZE_DIR, (n) => n.toLowerCase() === 'sherpa-onnx-offline-speaker-diarization.exe');
  const seg = findFileRec(DIARIZE_DIR, (n) => n === 'model.onnx');
  const emb = findFileRec(DIARIZE_DIR, (n) => n.toLowerCase() === 'embedding.onnx');
  return exe && seg && emb ? { exe, seg, emb } : null;
}

function available() {
  return !!findParts();
}

// Returns [{fromMs, toMs, spk}] or [] when unavailable/failed.
function diarizeTrack(wavPath) {
  return new Promise((resolve) => {
    const parts = findParts();
    if (!parts) return resolve([]);
    const child = spawn(parts.exe, [
      `--segmentation.pyannote-model=${parts.seg}`,
      `--embedding.model=${parts.emb}`,
      '--clustering.cluster-threshold=0.4',
      wavPath,
    ], { windowsHide: true, cwd: path.dirname(parts.exe) });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) {
        console.error('diarization failed:', err.slice(-400));
        return resolve([]);
      }
      const segs = [];
      // sherpa prints lines like: "0.318 -- 4.625 speaker_00"
      for (const line of `${out}\n${err}`.split(/\r?\n/)) {
        const m = line.match(/([\d.]+)\s*--\s*([\d.]+)\s+speaker_(\d+)/);
        if (m) segs.push({ fromMs: Math.round(+m[1] * 1000), toMs: Math.round(+m[2] * 1000), spk: +m[3] });
      }
      resolve(segs);
    });
  });
}

// Assign a speaker number to each whisper part by maximum time overlap.
function assignSpeakers(parts, diarSegs) {
  for (const p of parts) {
    let best = null;
    let bestOverlap = 0;
    for (const d of diarSegs) {
      const overlap = Math.min(p.concatToMs, d.toMs) - Math.max(p.concatFromMs, d.fromMs);
      if (overlap > bestOverlap) { bestOverlap = overlap; best = d.spk; }
    }
    if (best !== null) p.spk = best;
  }
  return parts;
}

module.exports = { diarizeTrack, assignSpeakers, available, DIARIZE_DIR };
