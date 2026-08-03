const cfgStore = require('./config');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
// ~3.2 chars per token, so 45k chars ≈ 14k tokens and still leaves room for the
// answer inside NUM_CTX. One pass beats map-reduce on both speed and quality;
// this covers meetings up to roughly an hour before splitting kicks in.
const OLLAMA_MAX_CHARS = 45000;
const NUM_CTX = 20480;
const PART_CHARS = 20000;
const MAX_PARTS = 10;

function prompts(lang, body, { context, digest } = {}) {
  const ctxEn = context ? `\nContext: the meeting window was titled "${context}".\n` : '';
  const ctxNl = context ? `\nContext: het venster van de meeting heette "${context}".\n` : '';
  const srcEn = digest
    ? 'Below are partial notes from consecutive parts of one long meeting. Combine them.'
    : 'Base everything on the transcript below. Speaker labels (bold names) tell you who said what.';
  const srcNl = digest
    ? 'Hieronder staan deelnotities van opeenvolgende delen van één lange vergadering. Combineer ze.'
    : 'Baseer alles op het transcript hieronder. De sprekerlabels (vetgedrukte namen) vertellen wie wat zei.';
  if (lang === 'nl') {
    return {
      system: 'Je bent een assistent die vergadernotities maakt. Antwoord uitsluitend in het Nederlands en uitsluitend met markdown, zonder inleiding of nawoord.',
      user: `${srcNl}${ctxNl}
Maak eerst een titelregel en dan precies drie secties.

De allereerste regel van je antwoord is:
TITEL: <korte beschrijvende titel van 3 tot 6 woorden>

Daarna:

## Samenvatting
Precies 5 bullets met de kern van het gesprek.

## Besluiten
Een bullet per genomen besluit. Schrijf "Geen besluiten genomen." als er geen zijn.

## Actiepunten
Een regel per actiepunt in de vorm "- [ ] taak — eigenaar". Gebruik de sprekernamen als eigenaar waar mogelijk, "onbekend" indien onduidelijk. Schrijf "Geen actiepunten." als er geen zijn.

${digest ? 'Deelnotities' : 'Transcript'}:

${body}`,
    };
  }
  return {
    system: 'You are a meeting-notes assistant. Reply only in English and only with markdown, no preamble or closing remarks.',
    user: `${srcEn}${ctxEn}
Produce a title line first, then exactly three sections.

The very first line of your reply is:
TITLE: <short descriptive title of 3 to 6 words>

Then:

## Summary
Exactly 5 bullets covering the core of the conversation.

## Decisions
One bullet per decision made. Write "No decisions made." if there are none.

## Action items
One line per action item in the form "- [ ] task — owner". Use the speaker names as owners where possible, "unknown" when unclear. Write "No action items." if there are none.

${digest ? 'Partial notes' : 'Transcript'}:

${body}`,
  };
}

function partPrompt(lang, part, i, n) {
  return lang === 'nl'
    ? `Dit is deel ${i} van ${n} van een vergadertranscript. Vat dit deel samen in maximaal 10 bullets: kernpunten, genomen besluiten en actiepunten (met eigenaar). Alleen bullets, geen inleiding.\n\n${part}`
    : `This is part ${i} of ${n} of a meeting transcript. Summarize this part in at most 10 bullets: key points, decisions made, and action items (with owner). Bullets only, no preamble.\n\n${part}`;
}

function splitChunks(text, size) {
  const lines = text.split('\n');
  const parts = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length > size && cur) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) parts.push(cur);
  return parts.slice(0, MAX_PARTS);
}

async function ollamaChat(model, system, user, timeoutMs = 600000, numCtx = NUM_CTX) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      options: { temperature: 0.2, num_ctx: numCtx },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  let text = data.message && data.message.content;
  // thinking models (qwen3 etc.) may prepend a <think> block — drop it
  if (text) text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('Ollama returned an empty response');
  return text;
}

// Ask Ollama to load the model into memory without generating anything.
// Called when a recording stops, so the (cold) model load overlaps the last
// segments' transcription instead of adding to the wait for notes.
async function prewarm() {
  const mode = cfgStore.get().summarizer || 'auto';
  if (mode === 'anthropic' || mode === 'none') return;
  try {
    const model = await pickOllamaModel();
    if (!model) return;
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: '15m' }),
      signal: AbortSignal.timeout(120000),
    });
  } catch { /* best effort — summarize() loads the model itself if this failed */ }
}

async function pickOllamaModel() {
  let tags;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    tags = await res.json();
  } catch {
    return null; // Ollama not running
  }
  const available = (tags.models || []).map((m) => m.name);
  if (available.length === 0) return null;
  const wanted = cfgStore.get().ollamaModel;
  if (wanted && available.some((n) => n === wanted || n.startsWith(wanted))) return wanted;
  const preferred = ['llama3.1', 'qwen2.5', 'llama3.2', 'mistral', 'gemma'];
  return available.find((n) => preferred.some((p) => n.startsWith(p))) || available[0];
}

async function tryOllama(transcript, lang, context, onProgress) {
  const model = await pickOllamaModel();
  if (!model) return null;
  let body = transcript;
  let digest = false;
  if (transcript.length > OLLAMA_MAX_CHARS) {
    // map-reduce: summarize parts, then combine — much better than truncating
    const parts = splitChunks(transcript, PART_CHARS);
    const partNotes = [];
    for (let i = 0; i < parts.length; i++) {
      if (onProgress) onProgress(`Summarizing part ${i + 1}/${parts.length}…`);
      const sys = lang === 'nl'
        ? 'Je vat delen van vergadertranscripten samen. Antwoord uitsluitend in het Nederlands met markdown bullets.'
        : 'You summarize parts of meeting transcripts. Reply only in English with markdown bullets.';
      partNotes.push(await ollamaChat(model, sys, partPrompt(lang, parts[i], i + 1, parts.length), 420000));
    }
    body = partNotes.join('\n\n');
    digest = true;
  }
  if (onProgress) onProgress('Summarizing…');
  const { system, user } = prompts(lang, body, { context, digest });
  const text = await ollamaChat(model, system, user);
  return { text, provider: `Ollama (${model})` };
}

async function tryAnthropic(transcript, lang, context) {
  const cfg = cfgStore.get();
  const apiKey = cfg.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = cfg.anthropicModel || 'claude-opus-5';
  const { system, user } = prompts(lang, transcript, { context });
  // Server-side refusal fallback: if a safety classifier declines, the API
  // retries the same request on Anthropic's recommended fallback model.
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to summarize this transcript');
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text) throw new Error('Claude returned an empty response');
  return { text, provider: response.model };
}

// pull the "TITLE:/TITEL:" line off the top of the summary
function extractTitle(result) {
  if (!result) return result;
  const lines = result.text.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    const m = lines[i].match(/^\s*\**\s*TIT(?:LE|EL)\s*:\s*\**\s*(.+?)\s*\**\s*$/i);
    if (m) {
      result.title = m[1].replace(/^["'`]|["'`]$/g, '').replace(/\.+$/, '').trim();
      lines.splice(i, 1);
      result.text = lines.join('\n').trim();
      break;
    }
  }
  return result;
}

// Returns { text, provider, title? } or null when no summarizer is available.
async function summarize(transcript, lang, opts = {}) {
  if (!transcript || transcript.trim().length < 20) return null;
  const mode = cfgStore.get().summarizer || 'auto';
  if (mode === 'none') return null;
  if (mode !== 'anthropic') {
    try {
      const local = await tryOllama(transcript, lang, opts.context, opts.onProgress);
      if (local) return extractTitle(local);
    } catch (err) {
      console.error('Ollama summary failed:', err.message || err);
    }
    if (mode === 'ollama') return null;
  }
  return extractTitle(await tryAnthropic(transcript, lang, opts.context));
}

module.exports = { summarize, prewarm, ollamaChat, pickOllamaModel, OLLAMA_URL };
