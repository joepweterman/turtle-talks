const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
// Ollama context is capped; keep the transcript within ~16k tokens for local models
const OLLAMA_MAX_CHARS = 60000;

function prompts(lang, transcript) {
  if (lang === 'nl') {
    return {
      system: 'Je bent een assistent die vergadernotities maakt. Antwoord uitsluitend in het Nederlands en uitsluitend met markdown, zonder inleiding of nawoord.',
      user: `Maak op basis van het transcript hieronder eerst een titelregel en dan precies drie secties.

De allereerste regel van je antwoord is:
TITEL: <korte beschrijvende titel van 3 tot 6 woorden, bijv. "Overleg over de Ajax-wedstrijd">

Daarna:

## Samenvatting
Precies 5 bullets met de kern van het gesprek.

## Besluiten
Een bullet per genomen besluit. Schrijf "Geen besluiten genomen." als er geen zijn.

## Actiepunten
Een regel per actiepunt in de vorm "- [ ] taak — eigenaar". Gebruik "onbekend" als de eigenaar onduidelijk is. Schrijf "Geen actiepunten." als er geen zijn.

Transcript:

${transcript}`,
    };
  }
  return {
    system: 'You are a meeting-notes assistant. Reply only in English and only with markdown, no preamble or closing remarks.',
    user: `From the transcript below, produce a title line first, then exactly three sections.

The very first line of your reply is:
TITLE: <short descriptive title of 3 to 6 words, e.g. "Launch planning for Friday release">

Then:

## Summary
Exactly 5 bullets covering the core of the conversation.

## Decisions
One bullet per decision made. Write "No decisions made." if there are none.

## Action items
One line per action item in the form "- [ ] task — owner". Use "unknown" when the owner is unclear. Write "No action items." if there are none.

Transcript:

${transcript}`,
  };
}

async function tryOllama(transcript, lang) {
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
  let model = process.env.OLLAMA_MODEL;
  if (!model) {
    const preferred = ['llama3.1', 'qwen2.5', 'llama3.2', 'mistral', 'gemma'];
    model = available.find((n) => preferred.some((p) => n.startsWith(p))) || available[0];
  }
  const { system, user } = prompts(lang, transcript.slice(0, OLLAMA_MAX_CHARS));
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
      options: { temperature: 0.2, num_ctx: 16384 },
    }),
    signal: AbortSignal.timeout(600000), // local models can be slow
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  let text = data.message && data.message.content;
  // thinking models (qwen3 etc.) may prepend a <think> block — drop it
  if (text) text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('Ollama returned an empty response');
  return { text, provider: `Ollama (${model})` };
}

async function tryAnthropic(transcript, lang) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
  const { system, user } = prompts(lang, transcript);
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
    const m = lines[i].match(/^\s*\**\s*TITE?L\s*:\s*\**\s*(.+?)\s*\**\s*$/i);
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
async function summarize(transcript, lang) {
  if (!transcript || transcript.trim().length < 20) return null;
  try {
    const local = await tryOllama(transcript, lang);
    if (local) return extractTitle(local);
  } catch (err) {
    console.error('Ollama summary failed, trying Anthropic:', err.message || err);
  }
  return extractTitle(await tryAnthropic(transcript, lang));
}

module.exports = { summarize };
