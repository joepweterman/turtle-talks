#!/usr/bin/env node
// One-off: upgrade old-format notes ("# Meeting notes — <stamp> (Lang)") to the
// titled format, generating a short title from the transcript via Ollama.
const fs = require('fs');
const path = require('path');
const os = require('os');

const NOTES_DIR = path.join(os.homedir(), 'MeetingNotes');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

function prettyStamp(stamp) {
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]} · ${m[4]}:${m[5]}` : stamp;
}

async function genTitle(transcript, lang) {
  const prompt = lang === 'nl'
    ? `Geef alleen een korte beschrijvende titel van 3 tot 6 woorden in het Nederlands voor deze meeting, zonder aanhalingstekens of uitleg:\n\n${transcript.slice(0, 4000)}`
    : `Give only a short descriptive 3 to 6 word English title for this meeting, no quotes, no explanation:\n\n${transcript.slice(0, 4000)}`;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: 'user', content: prompt }], options: { temperature: 0.2 } }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.message.content.split(/\r?\n/)[0].replace(/^["'`#\s]+|["'`\s]+$/g, '').slice(0, 80);
}

async function main() {
  for (const f of fs.readdirSync(NOTES_DIR).filter((x) => x.endsWith('.md'))) {
    const p = path.join(NOTES_DIR, f);
    let md = fs.readFileSync(p, 'utf8');
    const head = md.match(/^# Meeting notes — (\S+) \((English|Nederlands)\)\r?\n/);
    if (!head) { console.log('skip (already titled):', f); continue; }
    const [, stamp, langName] = head;
    const lang = langName === 'Nederlands' ? 'nl' : 'en';
    const transcript = (md.split(/## Transcript/i)[1] || '').trim();
    let title = `Meeting ${prettyStamp(stamp)}`;
    if (transcript.length > 30) {
      try { title = await genTitle(transcript, lang); } catch (err) { console.error('title failed for', f, err.message); }
    }
    md = md.replace(head[0], `# ${title}\n`);
    md = md.replace(/\r?\nAudio: \[[^\]]+\]\(([^)]+)\)\r?\n/, `\n_${prettyStamp(stamp)} · ${langName} · [Audio]($1)_\n`);
    fs.writeFileSync(p, md, 'utf8');
    console.log('retitled:', f, '→', title);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
