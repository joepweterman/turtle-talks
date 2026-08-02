// Settings: defaults < .env (legacy) < settings.json (written by the UI).
const fs = require('fs');
const path = require('path');
const os = require('os');

const NOTES_DIR = path.join(os.homedir(), 'MeetingNotes');
const SETTINGS_FILE = path.join(NOTES_DIR, 'settings.json');

const DEFAULTS = {
  yourName: 'You',           // speaker label for the mic track
  vocabulary: '',            // names/jargon whisper should know, comma separated
  dictHotkey: 'Control+Alt+T',
  dictModel: 'ggml-small.bin',
  dictLang: 'auto',
  meetingModel: '',          // '' = auto (turbo, falls back to medium)
  summarizer: 'auto',        // auto | ollama | anthropic | none
  ollamaModel: 'llama3.1:8b',
  anthropicKey: '',
  anthropicModel: 'claude-opus-5',
  liveTranscription: true,
};

const ENV_MAP = {
  dictHotkey: 'DICTATE_HOTKEY',
  dictModel: 'DICTATE_MODEL',
  dictLang: 'DICTATE_LANG',
  meetingModel: 'WHISPER_MODEL',
  ollamaModel: 'OLLAMA_MODEL',
  anthropicKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'ANTHROPIC_MODEL',
};

let cache = null;

function load() {
  const cfg = { ...DEFAULTS };
  for (const [key, env] of Object.entries(ENV_MAP)) {
    if (process.env[env]) cfg[key] = process.env[env];
  }
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (saved[key] !== undefined && saved[key] !== null) cfg[key] = saved[key];
      }
    }
  } catch (err) {
    console.error('could not read settings.json:', err.message);
  }
  cache = cfg;
  return cfg;
}

function get() {
  return cache || load();
}

function set(patch) {
  const cfg = { ...get() };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined) cfg[key] = patch[key];
  }
  cache = cfg;
  let saved = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined) saved[key] = patch[key];
  }
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(saved, null, 2), 'utf8');
  return cfg;
}

// short hint fed to whisper so it recognizes personal names and jargon
function vocabPrompt() {
  const cfg = get();
  const parts = [cfg.vocabulary, cfg.yourName !== 'You' ? cfg.yourName : '']
    .filter(Boolean)
    .join(', ')
    .trim();
  return parts ? `Glossary: ${parts}.`.slice(0, 800) : '';
}

module.exports = { get, set, load, vocabPrompt, DEFAULTS, SETTINGS_FILE };
