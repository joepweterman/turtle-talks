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

async function transcribe(wavPath, lang, baseDir, opts = {}) {
  const exe = findWhisperExe(baseDir);
  const modelName = opts.modelName || process.env.WHISPER_MODEL || 'ggml-medium.bin';
  const model = whisperDirs(baseDir)
    .map((d) => path.join(d, modelName))
    .find((p) => fs.existsSync(p));
  if (!exe || !model) {
    throw new Error(`whisper model ${modelName} not found (looked in ${path.join(baseDir, 'whisper')} and ~\\MeetingNotes\\whisper) — run "npm run setup" first.`);
  }
  const outBase = wavPath.replace(/\.wav$/i, '');
  const threads = Math.max(2, os.cpus().length - 2);
  await run(
    exe,
    ['-m', model, '-f', wavPath, '-l', lang, '-otxt', '-of', outBase, '-np', '-t', String(threads)],
    { cwd: path.dirname(exe) }, // so the exe finds its DLLs
  );
  const txtPath = `${outBase}.txt`;
  const text = fs.readFileSync(txtPath, 'utf8');
  fs.rmSync(txtPath, { force: true });
  return text.trim();
}

module.exports = { toWav, transcribe, findWhisperExe };
