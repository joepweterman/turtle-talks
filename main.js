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

const { toWav, transcribe, transcribeSegments } = require('./lib/transcribe');
const { summarize } = require('./lib/summarize');
const { buildMarkdown, buildTurns, turnsToMarkdown, speakerLabels, fmtMs, filterEcho } = require('./lib/notes');
const { MeetingWatch } = require('./lib/meetingwatch');
const config = require('./lib/config');

const SELFTEST = process.argv.includes('--selftest');
const DICTTEST = process.argv.includes('--dicttest');
const NUDGETEST = process.argv.includes('--nudgetest');
const QUIT_AFTER_NOTES = SELFTEST || NUDGETEST;

// When installed, never write to a console: if the app inherits a terminal
// (e.g. launched from a shell), log lines would appear inside that terminal.
if (app.isPackaged && !SELFTEST && !DICTTEST && !NUDGETEST) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const cfg = () => config.get();
const hotkeyLabel = () => cfg().dictHotkey.replace(/Control/g, 'Ctrl');

let tray = null;
let win = null;
let overlay = null;
let nudgeWin = null;
let nudgeHideTimer = null;
let mainWin = null;
let quitting = false;
const watcher = new MeetingWatch();
let state = 'idle'; // meeting recorder: idle | recording | processing
let rec = null;     // active recording (see startRecording)
let dict = null;    // dictation in progress: { webmPath, stream }
let dictBusy = false;

function uiSend(channel, ...args) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, ...args);
}

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

function ffmpegPath() {
  return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-500)}`))));
  });
}

function runPs(command) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('close', () => resolve(out.trim()));
    ps.on('error', () => resolve(''));
  });
}

function setState(next) {
  state = next;
  updateTray();
  uiSend('ui:state', { state, recLang: rec ? rec.lang : null });
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
    items.push({ label: 'Making notes…', enabled: false }, { type: 'separator' });
  }
  items.push(
    { label: 'Open Turtle Talks', click: () => showMainWindow() },
    { label: `Dictate anywhere: ${hotkeyLabel()}`, click: () => toggleDictation() },
    { type: 'separator' },
    { label: 'Open notes folder', click: () => { fs.mkdirSync(NOTES_DIR, { recursive: true }); shell.openPath(NOTES_DIR); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- meeting recorder: two tracks, live-transcribed in segments ----------

async function meetingWindowTitle() {
  const out = await runPs(
    "Get-Process ms-teams,Teams,Zoom,chrome,msedge,firefox,slack,Discord,Webex -ErrorAction SilentlyContinue | Where-Object MainWindowTitle | Select-Object -ExpandProperty MainWindowTitle",
  );
  const titles = out.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  return titles[0] ? titles[0].slice(0, 100) : '';
}

function startRecording(lang) {
  if (state !== 'idle') return;
  hideNudge();
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  let stamp = timestamp();
  if (fs.existsSync(path.join(NOTES_DIR, `${stamp}.webm`)) || fs.existsSync(path.join(NOTES_DIR, `${stamp}.md`))) {
    stamp = `${stamp}-${String(new Date().getSeconds()).padStart(2, '0')}`;
  }
  rec = {
    stamp,
    lang,
    startedAt: Date.now(),
    segs: new Map(),      // "track:index" → {file, stream, startMs, track, index}
    results: [],          // transcribed: {track, fromMs, toMs, text} absolute ms
    liveQueue: Promise.resolve(),
    context: '',
  };
  meetingWindowTitle().then((t) => { if (rec) rec.context = t; });
  setState('recording');
  uiSend('ui:live', []);
  // userGesture=true so getDisplayMedia is allowed without a click in the hidden window
  win.webContents.executeJavaScript('window.__start()', true)
    .catch((e) => failRecording(String(e && e.message ? e.message : e)));
}

function stopRecording() {
  if (state !== 'recording') return;
  setState('processing');
  uiSend('ui:progress', 'Finishing transcription…');
  win.webContents.executeJavaScript('window.__stop()', true)
    .catch((e) => console.error('stop failed:', e));
}

function failRecording(msg) {
  console.error('Recording error:', msg);
  if (rec) {
    for (const seg of rec.segs.values()) { try { seg.stream.close(); } catch {} }
  }
  rec = null;
  notify('Turtle Talks — recording failed', msg);
  setState('idle');
  if (QUIT_AFTER_NOTES) { console.log('[selftest] FAILED'); app.exit(1); }
}

function segKey(track, index) { return `${track}:${index}`; }

ipcMain.on('rec:seg-start', (e, track, index, startMs) => {
  if (!rec) return;
  const file = path.join(NOTES_DIR, `${rec.stamp}.${track}.${String(index).padStart(3, '0')}.webm`);
  rec.segs.set(segKey(track, index), {
    file,
    track,
    index,
    startMs: startMs - rec.startedAt,
    stream: fs.createWriteStream(file),
  });
});

ipcMain.on('rec:seg-chunk', (e, track, index, data) => {
  if (!rec) return;
  const seg = rec.segs.get(segKey(track, index));
  if (seg) seg.stream.write(Buffer.from(data));
});

ipcMain.on('rec:seg-done', (e, track, index) => {
  if (!rec) return;
  const seg = rec.segs.get(segKey(track, index));
  if (!seg) return;
  const job = rec; // bind to this recording
  const closed = new Promise((res) => seg.stream.end(res));
  job.liveQueue = job.liveQueue.then(async () => {
    await closed;
    try {
      await transcribeSegment(job, seg);
    } catch (err) {
      console.error(`segment ${seg.track}:${seg.index} failed:`, err.message || err);
    }
  });
});

async function transcribeSegment(job, seg) {
  const wav = `${seg.file}.wav`;
  try {
    await toWav(seg.file, wav);
    const parts = await transcribeSegments(wav, job.lang, BASE_DIR, {
      modelName: cfg().meetingModel || undefined,
      vad: true,
      beam: 1,
      prompt: config.vocabPrompt() || undefined,
      threads: state === 'recording' ? 4 : undefined, // leave CPU for the ongoing call
    });
    for (const p of parts) {
      job.results.push({ track: seg.track, fromMs: seg.startMs + p.fromMs, toMs: seg.startMs + p.toMs, text: p.text });
    }
    pushLive(job);
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

function pushLive(job) {
  if (rec !== job || state !== 'recording') return;
  const labels = speakerLabels(job.lang, cfg().yourName);
  const turns = buildTurns(filterEcho(job.results)).slice(-40).map((t) => ({
    label: labels[t.track],
    time: fmtMs(t.fromMs),
    text: t.text,
    track: t.track,
  }));
  uiSend('ui:live', turns);
}

ipcMain.on('rec:error', (e, msg) => failRecording(msg));
ipcMain.on('rec:log', (e, msg) => console.log('[recorder]', msg));
ipcMain.on('rec:done', async () => {
  if (!rec) return;
  const job = rec;
  rec = null;
  try {
    await processRecording(job);
  } catch (err) {
    console.error('Processing failed:', err);
    notify('Turtle Talks — failed', String(err.message || err), NOTES_DIR);
    if (QUIT_AFTER_NOTES) { app.exit(1); }
  }
  setState('idle');
  if (QUIT_AFTER_NOTES) { console.log('[selftest] DONE'); setTimeout(() => app.quit(), 500); }
});

async function mixAudio(job) {
  const finalPath = path.join(NOTES_DIR, `${job.stamp}.webm`);
  const byTrack = {};
  for (const seg of job.segs.values()) {
    if (!fs.existsSync(seg.file) || fs.statSync(seg.file).size === 0) continue;
    (byTrack[seg.track] = byTrack[seg.track] || []).push(seg);
  }
  const trackFiles = [];
  const temp = [];
  for (const track of ['mic', 'sys']) {
    const segs = (byTrack[track] || []).sort((a, b) => a.index - b.index);
    if (segs.length === 0) continue;
    if (segs.length === 1) {
      trackFiles.push(segs[0].file);
    } else {
      const list = path.join(NOTES_DIR, `${job.stamp}.${track}.txt`);
      fs.writeFileSync(list, segs.map((s) => `file '${s.file.replace(/\\/g, '/')}'`).join('\n'));
      const out = path.join(NOTES_DIR, `${job.stamp}.${track}.webm`);
      await runCmd(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
      temp.push(list, out);
      trackFiles.push(out);
    }
  }
  if (trackFiles.length === 0) throw new Error('no audio was recorded');
  if (trackFiles.length === 1) {
    fs.copyFileSync(trackFiles[0], finalPath);
  } else {
    await runCmd(ffmpegPath(), [
      '-y', '-i', trackFiles[0], '-i', trackFiles[1],
      '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[a]',
      '-map', '[a]', '-c:a', 'libopus', '-b:a', '64000', finalPath,
    ]);
  }
  // raw segments are no longer needed once the mixed file exists
  for (const seg of job.segs.values()) fs.rmSync(seg.file, { force: true });
  for (const f of temp) fs.rmSync(f, { force: true });
  return finalPath;
}

async function processRecording(job) {
  const mdPath = path.join(NOTES_DIR, `${job.stamp}.md`);
  console.log('Waiting for live transcription to finish…');
  await job.liveQueue;
  console.log('Mixing audio…');
  uiSend('ui:progress', 'Mixing audio…');
  await mixAudio(job);
  const turns = buildTurns(filterEcho(job.results));
  const transcript = turnsToMarkdown(turns, job.lang, cfg().yourName);
  console.log('Summarizing…');
  uiSend('ui:progress', 'Summarizing…');
  let summary = null;
  try {
    summary = await summarize(transcript, job.lang, {
      context: job.context,
      onProgress: (t) => uiSend('ui:progress', t),
    });
  } catch (err) {
    console.error('Summary failed (keeping transcript):', err.message || err);
  }
  fs.writeFileSync(mdPath, buildMarkdown(job.stamp, job.lang, transcript, summary), 'utf8');
  console.log('Notes written:', mdPath);
  uiSend('ui:progress', '');
  uiSend('ui:notes-changed', path.basename(mdPath));
  const n = new Notification({ title: 'Meeting notes ready', body: path.basename(mdPath) });
  n.on('click', () => { showMainWindow(); uiSend('ui:select-note', path.basename(mdPath)); });
  n.show();
}

// ---------- main window ----------

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1060,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Turtle Talks',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: '#f3efe6',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.removeMenu();
  mainWin.loadFile('renderer/app.html');
  mainWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWin.hide(); } // stay alive in the tray
  });
}

function showMainWindow() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function listWhisperModels() {
  const dirs = [path.join(BASE_DIR, 'whisper'), path.join(NOTES_DIR, 'whisper')];
  const models = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/^ggml-.*\.bin$/i.test(f) && !/silero/i.test(f)) models.add(f);
    }
  }
  return [...models].sort();
}

ipcMain.handle('ui:get-state', () => ({
  state,
  recLang: rec ? rec.lang : null,
  hotkey: hotkeyLabel(),
  dictHistory,
}));

ipcMain.handle('ui:get-settings', () => ({
  settings: config.get(),
  models: listWhisperModels(),
}));

ipcMain.handle('ui:save-settings', (e, patch) => {
  const before = config.get();
  const next = config.set(patch);
  if (next.dictHotkey !== before.dictHotkey) {
    globalShortcut.unregister(before.dictHotkey);
    const ok = globalShortcut.register(next.dictHotkey, toggleDictation);
    if (!ok) {
      config.set({ dictHotkey: before.dictHotkey });
      globalShortcut.register(before.dictHotkey, toggleDictation);
      return { ok: false, error: `Hotkey ${next.dictHotkey} could not be registered (taken by another app?)` };
    }
  }
  updateTray();
  uiSend('ui:state', { state, recLang: rec ? rec.lang : null });
  return { ok: true, settings: config.get() };
});

ipcMain.handle('ui:list-notes', () => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  return fs.readdirSync(NOTES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const st = fs.statSync(path.join(NOTES_DIR, f));
      let lang = '';
      let title = '';
      try {
        const head = fs.readFileSync(path.join(NOTES_DIR, f), 'utf8').slice(0, 400);
        if (head.includes('Nederlands')) lang = 'NL';
        else if (head.includes('English')) lang = 'EN';
        const m = head.match(/^# (.+)$/m);
        if (m) title = m[1].trim();
      } catch {}
      return { file: f, mtime: st.mtimeMs, lang, title: title || f.replace(/\.md$/, '') };
    })
    .sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle('ui:read-note', (e, file) => {
  const p = path.join(NOTES_DIR, path.basename(String(file)));
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
});

ipcMain.handle('ui:save-note', (e, payload) => {
  const file = path.basename(String(payload.file));
  if (!file.endsWith('.md')) return false;
  fs.writeFileSync(path.join(NOTES_DIR, file), String(payload.content), 'utf8');
  return true;
});

ipcMain.on('ui:start', (e, lang) => startRecording(lang === 'nl' ? 'nl' : 'en'));
ipcMain.on('ui:stop', () => stopRecording());
ipcMain.on('ui:open-folder', () => { fs.mkdirSync(NOTES_DIR, { recursive: true }); shell.openPath(NOTES_DIR); });
ipcMain.on('ui:open-rel', (e, rel) => {
  const p = path.join(NOTES_DIR, path.basename(String(rel)));
  if (fs.existsSync(p)) shell.openPath(p);
});

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
  overlayShow('listening', hotkeyLabel());
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

const USER32 = `using System;
using System.Runtime.InteropServices;
public class U {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}`;

// remember which window the user was dictating into, so a slow transcription
// can't paste into whatever happens to be focused later
function getForegroundWindow() {
  return runPs(`Add-Type '${USER32}'; [U]::GetForegroundWindow()`);
}

function sendPaste(hwnd) {
  const activate = hwnd && /^\d+$/.test(hwnd)
    ? `Add-Type '${USER32}'; [U]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null; Start-Sleep -Milliseconds 150; `
    : '';
  return runPs(`${activate}$w = New-Object -ComObject wscript.shell; $w.SendKeys('^v')`);
}

// whisper's classic hallucinations on (near-)silence
const HALLUCINATIONS = [
  /^thanks? (you )?for watching[.!]?$/i,
  /^bedankt voor het kijken[.!]?$/i,
  /amara\.org/i,
  /^ondertitel(s|d|ing)? /i,
  /^untertitel/i,
  /^sous-?titr/i,
  /^sottotitoli/i,
];

function cleanDictation(raw) {
  const text = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\[[A-Z_ ]+\]/g, '')      // [BLANK_AUDIO], [MUSIC], …
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length < 2) return '';
  if (HALLUCINATIONS.some((re) => re.test(text))) return '';
  return text;
}

// dictation history: kept in memory (newest first) and persisted as JSONL
const DICT_LOG = path.join(NOTES_DIR, 'dictations.jsonl');
const dictHistory = []; // {ts, text, pasted}
try {
  if (fs.existsSync(DICT_LOG)) {
    const lines = fs.readFileSync(DICT_LOG, 'utf8').trim().split('\n').slice(-300);
    for (const line of lines.reverse()) {
      try { dictHistory.push(JSON.parse(line)); } catch {}
    }
  }
} catch (err) { console.error('could not load dictation history:', err); }

function pushDictHistory(entry) {
  dictHistory.unshift(entry);
  if (dictHistory.length > 300) dictHistory.pop();
  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.appendFileSync(DICT_LOG, JSON.stringify(entry) + '\n');
  } catch (err) { console.error('could not save dictation history:', err); }
  uiSend('ui:dict', dictHistory);
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
    const hwndPromise = getForegroundWindow(); // where the user was when they stopped
    await new Promise((res) => job.stream.end(res));
    overlayShow('transcribing');
    await toWav(job.webmPath, wavPath);
    const raw = await transcribe(wavPath, cfg().dictLang, BASE_DIR, {
      modelName: cfg().dictModel,
      suppressNonSpeech: true,
      beam: 1,
      prompt: config.vocabPrompt() || undefined,
    });
    const text = cleanDictation(raw);
    if (!text) {
      overlayShow('empty');
      overlayHide(1500);
    } else if (DICTTEST) {
      console.log('[dicttest] TEXT:', text);
      pushDictHistory({ ts: Date.now(), text, pasted: false });
      overlayHide();
    } else {
      clipboard.writeText(text); // stays in clipboard as fallback
      let pasted = false;
      if (clipboard.readText() === text) { // never paste anything that isn't our transcript
        await sendPaste(await hwndPromise);
        pasted = true;
      }
      pushDictHistory({ ts: Date.now(), text, pasted });
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

// ---------- meeting-detected nudge (Granola-style) ----------

function createNudge() {
  nudgeWin = new BrowserWindow({
    width: 360,
    height: 130,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // clickable, but never steals keyboard focus from the meeting
    resizable: false,
    movable: false,
    show: false,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  nudgeWin.setAlwaysOnTop(true, 'screen-saver');
  nudgeWin.loadFile('renderer/nudge.html');
}

function showNudge(mode, appName) {
  if (!nudgeWin) return;
  const wa = screen.getPrimaryDisplay().workArea;
  nudgeWin.setBounds({ x: wa.x + wa.width - 360 - 12, y: wa.y + 12, width: 360, height: 130 });
  nudgeWin.webContents.executeJavaScript(`setNudge(${JSON.stringify(mode)}, ${JSON.stringify(appName || '')})`).catch(() => {});
  nudgeWin.showInactive();
  clearTimeout(nudgeHideTimer);
  nudgeHideTimer = setTimeout(hideNudge, 30000);
}

function hideNudge() {
  clearTimeout(nudgeHideTimer);
  if (nudgeWin) nudgeWin.hide();
}

ipcMain.on('nudge:action', (e, action, arg) => {
  hideNudge();
  if (action === 'start') startRecording(arg === 'nl' ? 'nl' : 'en');
  else if (action === 'stop') stopRecording();
  // 'dismiss' → just hidden
});

watcher.on('meeting-start', (apps) => {
  console.log('[nudge] meeting detected:', apps.join(', '));
  if (state === 'idle') showNudge('start', apps[0]);
});
watcher.on('meeting-stop', () => {
  console.log('[nudge] meeting ended');
  if (state === 'recording') showNudge('stop');
  else hideNudge();
});

// ---------- app lifecycle ----------

app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('will-quit', () => { if (app.isReady()) globalShortcut.unregisterAll(); });
app.on('before-quit', () => { quitting = true; });
app.on('second-instance', () => showMainWindow());

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
    createNudge();
    createMainWindow();
    tray = new Tray(icon('idle'));
    tray.on('click', () => showMainWindow());
    updateTray();

    const TESTMODE = SELFTEST || DICTTEST || NUDGETEST;
    if (!TESTMODE) showMainWindow();
    if (process.argv.includes('--shot')) {
      setTimeout(async () => {
        const wc = mainWin.webContents;
        const snap = async (name) => {
          fs.writeFileSync(path.join(os.tmpdir(), name), (await wc.capturePage()).toPNG());
          console.log('[shot]', name);
        };
        await snap('tt-window.png');
        await wc.executeJavaScript(`openSettings()`);
        await new Promise((r) => setTimeout(r, 400));
        await snap('tt-settings.png');
        app.quit();
      }, 3500);
    }

    const ok = globalShortcut.register(cfg().dictHotkey, toggleDictation);
    if (!ok) {
      console.error(`could not register dictation hotkey ${cfg().dictHotkey} (already in use?)`);
      notify('Turtle Talks', `Dictation hotkey ${hotkeyLabel()} is taken by another app — change it in Settings`);
    }

    if (!SELFTEST && !DICTTEST) watcher.start();

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
        console.log(`[dicttest] dictating ${secs}s (lang=${cfg().dictLang}, model=${cfg().dictModel})…`);
        toggleDictation();
        setTimeout(() => toggleDictation(), secs * 1000);
      });
    }
    if (NUDGETEST) {
      // when the nudge appears, click its real English button, record, stop
      watcher.on('meeting-start', () => {
        setTimeout(() => {
          console.log('[nudgetest] clicking English notes button…');
          nudgeWin.webContents.executeJavaScript("document.getElementById('btn-en').click()").catch((e) => {
            console.error('[nudgetest] click failed:', e);
            app.exit(1);
          });
          setTimeout(() => stopRecording(), Number(process.env.SELFTEST_SECONDS || 10) * 1000);
        }, 2000);
      });
    }
  });
}
