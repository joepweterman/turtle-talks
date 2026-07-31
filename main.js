const { app, Tray, Menu, BrowserWindow, ipcMain, Notification, shell, nativeImage, session, desktopCapturer } = require('electron');
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

let tray = null;
let win = null;
let state = 'idle'; // idle | recording | processing
let rec = null;     // { stamp, lang, webmPath, stream }

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
    tray.setToolTip('MeetingNotes — idle');
    items.push(
      { label: 'Start recording (English)', click: () => startRecording('en') },
      { label: 'Start opname (Nederlands)', click: () => startRecording('nl') },
      { type: 'separator' },
    );
  } else if (state === 'recording') {
    tray.setImage(icon('rec'));
    tray.setToolTip(`MeetingNotes — recording (${rec.lang})`);
    items.push(
      { label: rec.lang === 'nl' ? 'Aan het opnemen (Nederlands)…' : 'Recording (English)…', enabled: false },
      { label: rec.lang === 'nl' ? 'Stop en maak notities' : 'Stop and make notes', click: () => stopRecording() },
      { type: 'separator' },
    );
  } else {
    tray.setImage(icon('busy'));
    tray.setToolTip('MeetingNotes — making notes…');
    items.push({ label: 'Transcribing & summarizing…', enabled: false }, { type: 'separator' });
  }
  items.push(
    { label: 'Open notes folder', click: () => { fs.mkdirSync(NOTES_DIR, { recursive: true }); shell.openPath(NOTES_DIR); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

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
  notify('MeetingNotes — recording failed', msg);
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
    notify('MeetingNotes — failed', String(err.message || err), NOTES_DIR);
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

app.on('window-all-closed', () => { /* keep running in the tray */ });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    app.setAppUserModelId('com.joep.meetingnotes');
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
    tray = new Tray(icon('idle'));
    updateTray();

    if (SELFTEST) {
      const secs = Number(process.env.SELFTEST_SECONDS || 15);
      win.webContents.once('did-finish-load', () => {
        console.log(`[selftest] recording ${secs}s (${process.env.SELFTEST_LANG || 'en'})…`);
        startRecording(process.env.SELFTEST_LANG || 'en');
        setTimeout(() => stopRecording(), secs * 1000);
      });
    }
  });
}
