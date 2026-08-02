const { app, Tray, Menu, BrowserWindow, ipcMain, Notification, shell, nativeImage, session, desktopCapturer, globalShortcut, clipboard, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const NOTES_DIR = path.join(os.homedir(), 'MeetingNotes');
// When packaged, whisper/ and .env live next to the notes in ~\MeetingNotes.
// In dev they live in the project folder.
const BASE_DIR = app.isPackaged ? NOTES_DIR : __dirname;
require('dotenv').config({ path: path.join(BASE_DIR, '.env'), quiet: true });

const { toWav, transcribe } = require('./lib/transcribe');
const { summarize } = require('./lib/summarize');
const { buildMarkdown } = require('./lib/notes');

const SELFTEST = process.argv.includes('--selftest');
const DICTTEST = process.argv.includes('--dicttest');

const DICT_HOTKEY = process.env.DICTATE_HOTKEY || 'Control+Alt+Space';
const DICT_LANG = process.env.DICTATE_LANG || 'auto'; // auto-detect NL vs EN per utterance
const DICT_MODEL = process.env.DICTATE_MODEL || 'ggml-small.bin';

let tray = null;
let win = null;
let overlay = null;
let state = 'idle'; // meeting recorder: idle | recording | processing
let rec = null;     // { stamp, lang, webmPath, stream }
let dict = null;    // dictation in progress: { webmPath, stream }
let dictBusy = false;

const icons = {};
function icon(name) {
  if (!icons[name]) icons[name] = nativeImage.createFromPath(path.join(__dirname, 'assets', `tray-${name}.png`));
  return icons[name];
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function notify(title, body, openPath) {
  const n = new Notification({ title, body });
  if (openPath) n.on('click', () => shell.openPath(openPath));
  n.show();
}

function setState(next) {
  state = next;
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const items = [];
  if (state === 'idle') {
    tray.setImage(icon('idle'));
    tray.setToolTip('Turtle Talks — idle');
    items.push(
      { label: 'Start recording (English)', click: () => startRecording('en') },
      { label: 'Start opname (Nederlands)', click: () => startRecording('nl') },
      { type: 'separator' },
    );
  } else if (state === 'recording') {
    tray.setImage(icon('rec'));
    tray.setToolTip(`Turtle Talks — recording (${rec.lang})`);
    items.push(
      { label: rec.lang === 'nl' ? 'Aan het opnemen (Nederlands)…' : 'Recording (English)…', enabled: false },
      { label: rec.lang === 'nl' ? 'Stop en maak notities' : 'Stop and make notes', click: () => stopRecording() },
      { type: 'separator' },
    );
  } else {
    tray.setImage(icon('busy'));
    tray.setToolTip('Turtle Talks — making notes…');
    items.push({ label: 'Transcribing & summarizing…', enabled: false }, { type: 'separator' });
  }
  items.push(
    { label: `Dictate anywhere: ${DICT_HOTKEY.replace(/Control/g, 'Ctrl')}`, click: () => toggleDictation() },
    { type: 'separator' },
    { label: 'Open notes folder', click: () => { fs.mkdirSync(NOTES_DIR, { recursive: true }); shell.openPath(NOTES_DIR); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- meeting recorder ----------

function startRecording(lang) {
  if (state !== 'idle') return;
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  let stamp = timestamp();
  let webmPath = path.join(NOTES_DIR, `${stamp}.webm`);
  if (fs.existsSync(webmPath)) {
    stamp = `${stamp}-${String(new Date().getSeconds()).padStart(2, '0')}`;
    webmPath = path.join(NOTES_DIR, `${stamp}.webm`);
  }
  rec = { stamp, lang, webmPath, stream: fs.createWriteStream(webmPath) };
  setState('recording');
  // userGesture=true so getDisplayMedia is allowed without a click in the hidden window
  win.webContents.executeJavaScript(`window.__start(${JSON.stringify(lang)})`, true)
    .catch((e) => failRecording(String(e && e.message ? e.message : e)));
}

function stopRecording() {
  if (state !== 'recording') return;
  setState('processing');
  win.webContents.executeJavaScript('window.__stop()', true)
    .catch((e) => console.error('stop failed:', e));
}

function failRecording(msg) {
  console.error('Recording error:', msg);
  if (rec) { try { rec.stream.close(); } catch {} }
  rec = null;
  notify('Turtle Talks — recording failed', msg);
  setState('idle');
  if (SELFTEST) { console.log('[selftest] FAILED'); app.exit(1); }
}

ipcMain.on('rec:chunk', (e, data) => { if (rec) rec.stream.write(Buffer.from(data)); });
ipcMain.on('rec:error', (e, msg) => failRecording(msg));
ipcMain.on('rec:log', (e, msg) => console.log('[recorder]', msg));
ipcMain.on('rec:done', async () => {
  if (!rec) return;
  const job = rec;
  rec = null;
  await new Promise((res) => job.stream.end(res));
  console.log('Recording saved:', job.webmPath);
  try {
    await processRecording(job);
  } catch (err) {
    console.error('Processing failed:', err);
    notify('Turtle Talks — failed', String(err.message || err), NOTES_DIR);
    if (SELFTEST) { app.exit(1); }
  }
  setState('idle');
  if (SELFTEST) { console.log('[selftest] DONE'); setTimeout(() => app.quit(), 500); }
});

async function processRecording(job) {
  const base = path.join(NOTES_DIR, job.stamp);
  const mdPath = `${base}.md`;
  const wavPath = `${base}.tmp.wav`;
  let transcript;
  try {
    console.log('Converting to 16 kHz wav…');
    await toWav(job.webmPath, wavPath);
    console.log('Transcribing with whisper.cpp (medium on CPU can take a while)…');
    transcript = await transcribe(wavPath, job.lang, BASE_DIR);
  } finally {
    fs.rmSync(wavPath, { force: true });
  }
  console.log('Summarizing…');
  let summary = null;
  try {
    summary = await summarize(transcript, job.lang);
  } catch (err) {
    console.error('Summary failed (keeping transcript):', err.message || err);
  }
  fs.writeFileSync(mdPath, buildMarkdown(job.stamp, job.lang, transcript, summary), 'utf8');
  console.log('Notes written:', mdPath);
  notify('Meeting notes ready', path.basename(mdPath), mdPath);
}

// ---------- dictation (Wispr Flow-style) ----------

function createOverlay() {
  overlay = new BrowserWindow({
    width: 340,
    height: 64,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    show: false,
    hasShadow: false,
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile('renderer/overlay.html');
}

function overlayShow(mode, extra) {
  if (!overlay) return;
  const wa = screen.getPrimaryDisplay().workArea;
  overlay.setBounds({
    x: Math.round(wa.x + (wa.width - 340) / 2),
    y: wa.y + wa.height - 64 - 24,
    width: 340,
    height: 64,
  });
  overlay.webContents.executeJavaScript(`setMode(${JSON.stringify(mode)}, ${JSON.stringify(extra || '')})`).catch(() => {});
  overlay.showInactive();
}

function overlayHide(delay = 0) {
  setTimeout(() => { if (overlay) overlay.hide(); }, delay);
}

function toggleDictation() {
  if (dictBusy) return; // still transcribing the previous one
  if (dict) {
    win.webContents.executeJavaScript('window.__dictStop()', true).catch(() => {});
  } else {
    startDictation();
  }
}

function startDictation() {
  dict = { webmPath: path.join(os.tmpdir(), `dictate-${Date.now()}.webm`) };
  dict.stream = fs.createWriteStream(dict.webmPath);
  overlayShow('listening', DICT_HOTKEY.replace(/Control/g, 'Ctrl'));
  win.webContents.executeJavaScript('window.__dictStart()', true).catch((e) => {
    console.error('dictation start failed:', e);
    cancelDictation();
    overlayShow('error', 'microphone unavailable');
    overlayHide(2000);
    if (DICTTEST) setTimeout(() => app.exit(1), 500);
  });
}

function cancelDictation() {
  if (dict) {
    try { dict.stream.close(); } catch {}
    fs.rmSync(dict.webmPath, { force: true });
  }
  dict = null;
}

function sendPaste() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      "$w = New-Object -ComObject wscript.shell; $w.SendKeys('^v')",
    ], { windowsHide: true });
    ps.on('close', resolve);
    ps.on('error', resolve);
  });
}

function cleanDictation(raw) {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\[[A-Z_ ]+\]/g, '')      // [BLANK_AUDIO], [MUSIC], …
    .replace(/\s{2,}/g, ' ')
    .trim();
}

ipcMain.on('dict:chunk', (e, data) => { if (dict) dict.stream.write(Buffer.from(data)); });
ipcMain.on('dict:error', (e, msg) => {
  console.error('dictation error:', msg);
  cancelDictation();
  overlayShow('error', msg);
  overlayHide(2200);
  if (DICTTEST) setTimeout(() => app.exit(1), 500);
});
ipcMain.on('dict:done', async () => {
  if (!dict) return;
  const job = dict;
  dict = null;
  dictBusy = true;
  const wavPath = job.webmPath.replace(/\.webm$/, '.wav');
  try {
    await new Promise((res) => job.stream.end(res));
    overlayShow('transcribing');
    await toWav(job.webmPath, wavPath);
    const raw = await transcribe(wavPath, DICT_LANG, BASE_DIR, { modelName: DICT_MODEL });
    const text = cleanDictation(raw);
    if (!text) {
      overlayShow('empty');
      overlayHide(1500);
    } else if (DICTTEST) {
      console.log('[dicttest] TEXT:', text);
      overlayHide();
    } else {
      clipboard.writeText(text); // stays in clipboard as fallback
      await sendPaste();
      overlayShow('done');
      overlayHide(900);
    }
  } catch (err) {
    console.error('dictation failed:', err);
    overlayShow('error', String(err.message || err).slice(0, 60));
    overlayHide(2500);
  } finally {
    fs.rmSync(job.webmPath, { force: true });
    fs.rmSync(wavPath, { force: true });
    dictBusy = false;
    if (DICTTEST) setTimeout(() => app.quit(), 400);
  }
});

// ---------- app lifecycle ----------

app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('will-quit', () => globalShortcut.unregisterAll());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    app.setAppUserModelId('com.joep.turtletalks');
    // Fallback path: auto-approve getDisplayMedia with Windows loopback audio
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      });
    });
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
      },
    });
    win.loadFile('renderer/recorder.html');
    createOverlay();
    tray = new Tray(icon('idle'));
    updateTray();

    const ok = globalShortcut.register(DICT_HOTKEY, toggleDictation);
    if (!ok) {
      console.error(`could not register dictation hotkey ${DICT_HOTKEY} (already in use?)`);
      notify('Turtle Talks', `Dictation hotkey ${DICT_HOTKEY} is taken by another app — set DICTATE_HOTKEY in .env`);
    }

    if (SELFTEST) {
      const secs = Number(process.env.SELFTEST_SECONDS || 15);
      win.webContents.once('did-finish-load', () => {
        console.log(`[selftest] recording ${secs}s (${process.env.SELFTEST_LANG || 'en'})…`);
        startRecording(process.env.SELFTEST_LANG || 'en');
        setTimeout(() => stopRecording(), secs * 1000);
      });
    }
    if (DICTTEST) {
      const secs = Number(process.env.SELFTEST_SECONDS || 8);
      win.webContents.once('did-finish-load', () => {
        console.log(`[dicttest] dictating ${secs}s (lang=${DICT_LANG}, model=${DICT_MODEL})…`);
        toggleDictation();
        setTimeout(() => toggleDictation(), secs * 1000);
      });
    }
  });
}
