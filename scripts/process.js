#!/usr/bin/env node
// Re-run the notes pipeline on an existing audio file (recovery / testing).
// Usage: node scripts/process.js <audio-file> <en|nl>
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectRoot = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(projectRoot, '.env'), quiet: true });
const { toWav, transcribe } = require('../lib/transcribe');
const { summarize } = require('../lib/summarize');
const { buildMarkdown } = require('../lib/notes');

async function main() {
  const [audioFile, lang] = process.argv.slice(2);
  if (!audioFile || !['en', 'nl'].includes(lang)) {
    console.error('Usage: node scripts/process.js <audio-file> <en|nl>');
    process.exit(1);
  }
  const audio = path.resolve(audioFile);
  const stamp = path.basename(audio).replace(/\.[^.]+$/, '');
  const outDir = path.dirname(audio);
  const wavPath = path.join(os.tmpdir(), `${stamp}.tmp.wav`);
  const mdPath = path.join(outDir, `${stamp}.md`);

  console.log('Converting to 16 kHz wav…');
  await toWav(audio, wavPath);
  console.log('Transcribing…');
  let transcript;
  try {
    transcript = await transcribe(wavPath, lang, projectRoot);
  } finally {
    fs.rmSync(wavPath, { force: true });
  }
  console.log('Summarizing…');
  let summary = null;
  try {
    summary = await summarize(transcript, lang);
  } catch (err) {
    console.error('Summary failed (keeping transcript):', err.message || err);
  }
  fs.writeFileSync(mdPath, buildMarkdown(stamp, lang, transcript, summary), 'utf8');
  console.log('Notes written:', mdPath);
}

main().catch((err) => { console.error(err); process.exit(1); });
