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

function findWhisperExe(baseDir) {
  const dir = path.join(baseDir, 'whisper');
  if (!fs.existsSync(dir)) return null;
  // main.exe is a deprecation shim in recent releases — only use it as a last resort
  for (const name of ['whisper-cli.exe', 'main.exe']) {
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
  return null;
}

async function transcribe(wavPath, lang, baseDir) {
  const exe = findWhisperExe(baseDir);
  const model = path.join(baseDir, 'whisper', process.env.WHISPER_MODEL || 'ggml-medium.bin');
  if (!exe || !fs.existsSync(model)) {
    throw new Error(`whisper.cpp not set up in ${path.join(baseDir, 'whisper')} — run "npm run setup" first.`);
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
