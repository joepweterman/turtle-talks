const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ffmpegPath() {
  // ffmpeg-static resolves inside app.asar when packaged; the binary is unpacked
  return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-800)}`));
    });
  });
}

async function toWav(input, output) {
  await run(ffmpegPath(), ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output]);
}

// whisper/ can live next to the source (dev) or in ~\MeetingNotes (installed app)
function whisperDirs(baseDir) {
  const dirs = [path.join(baseDir, 'whisper'), path.join(os.homedir(), 'MeetingNotes', 'whisper')];
  return [...new Set(dirs)].filter((d) => fs.existsSync(d));
}

function findWhisperExe(baseDir) {
  // main.exe is a deprecation shim in recent releases — only use it as a last resort
  for (const name of ['whisper-cli.exe', 'main.exe']) {
    for (const dir of whisperDirs(baseDir)) {
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name.toLowerCase() === name) return full;
        }
      }
    }
  }
  return null;
}

function findFile(baseDir, names) {
  for (const name of names) {
    for (const dir of whisperDirs(baseDir)) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function buildArgs(wavPath, lang, baseDir, opts) {
  const exe = findWhisperExe(baseDir);
  // large-v3-turbo (quantized) is both faster and more accurate than medium
  const candidates = opts.modelName
    ? [opts.modelName]
    : (process.env.WHISPER_MODEL ? [process.env.WHISPER_MODEL] : ['ggml-large-v3-turbo-q5_0.bin', 'ggml-medium.bin']);
  const model = findFile(baseDir, candidates);
  if (!exe || !model) {
    throw new Error(`whisper model ${candidates.join(' / ')} not found (looked in ${path.join(baseDir, 'whisper')} and ~\\MeetingNotes\\whisper) — run "npm run setup" first.`);
  }
  const outBase = wavPath.replace(/\.wav$/i, '');
  const threads = opts.threads || Math.max(2, os.cpus().length - 2);
  const args = ['-m', model, '-f', wavPath, '-l', lang, '-of', outBase, '-np', '-t', String(threads)];
  if (opts.beam) args.push('-bs', String(opts.beam)); // greedy (1) is ~1.5-2x faster than the beam-5 default
  if (opts.suppressNonSpeech) args.push('-sns'); // suppress [MUSIC] etc — for dictation
  if (opts.prompt) args.push('--prompt', opts.prompt); // vocabulary hint (names, jargon)
  if (opts.vad) {
    const vadModel = findFile(baseDir, ['ggml-silero-v5.1.2.bin']);
    if (vadModel) args.push('--vad', '--vad-model', vadModel); // skip silence — big win on meetings
  }
  return { exe, args, outBase };
}

async function transcribe(wavPath, lang, baseDir, opts = {}) {
  const { exe, args, outBase } = buildArgs(wavPath, lang, baseDir, opts);
  await run(exe, [...args, '-otxt'], { cwd: path.dirname(exe) }); // cwd so the exe finds its DLLs
  const txtPath = `${outBase}.txt`;
  const text = fs.readFileSync(txtPath, 'utf8');
  fs.rmSync(txtPath, { force: true });
  return text.trim();
}

// Timestamped variant: returns [{fromMs, toMs, text}] for speaker interleaving.
async function transcribeSegments(wavPath, lang, baseDir, opts = {}) {
  const { exe, args, outBase } = buildArgs(wavPath, lang, baseDir, opts);
  await run(exe, [...args, '-oj'], { cwd: path.dirname(exe) });
  const jsonPath = `${outBase}.json`;
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  fs.rmSync(jsonPath, { force: true });
  return (data.transcription || [])
    .map((s) => ({ fromMs: s.offsets.from, toMs: s.offsets.to, text: s.text.trim() }))
    .filter((s) => s.text);
}

module.exports = { toWav, transcribe, transcribeSegments, findWhisperExe, findFile };
