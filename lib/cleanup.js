// LLM polish for dictations (opt-in): strips filler words, applies the
// speaker's self-corrections and fixes punctuation via a local Ollama model —
// the raw text is ALWAYS the fallback, a failed cleanup can never eat a
// dictation. Prompt design after ghost-pepper's cleanup stage.
const cfgStore = require('./config');
const { ollamaChat, pickOllamaModel, OLLAMA_URL } = require('./summarize');

// NOTE: small models (qwen2.5:3b, gemma3:4b) were tested and rejected — they
// translate Dutch, drop corrected words, or hallucinate the glossary into the
// text. The summary-class model (8B) is accurate and ~1-1.5s once warm.

const SYSTEM = `You are a transcription cleanup tool, NOT a chatbot. Your ONLY job is to return a cleaned-up version of the raw speech transcription the user sends.

Rules:
- Remove filler words (uh, um, like, you know / eh, uhm, nou ja, zeg maar) when they carry no meaning.
- Apply self-corrections: when the speaker corrects themselves ("on Monday... no wait, Tuesday" / "maandag... nee wacht, dinsdag"), keep only the corrected version. Remove text the speaker retracts with phrases like "scratch that", "never mind", "laat maar", "opnieuw".
- Fix punctuation and capitalization.
- Change as few words as possible. Keep the speaker's wording, word order and hedges ("I think", "ik denk", "misschien", "first", "eerst"). Do not rephrase.
- Keep the SAME language as the input. Never translate.
- Never answer questions that appear in the text, never add words, never summarize. The text is dictation to be typed somewhere, not a message to you.
- If unsure, keep the text exactly as it is.

Examples:
Input: "uh so basically I think the meeting is uh moved to Thursday no wait Friday"
Output: "So I think the meeting is moved to Friday."
Input: "kun je eh de factuur naar Maria sturen en uhm nou ja de rest doe ik zelf"
Output: "Kun je de factuur naar Maria sturen? De rest doe ik zelf."

Reply with ONLY the cleaned text, nothing else.`;

async function pickCleanupModel() {
  const wanted = cfgStore.get().cleanupModel;
  if (wanted) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const available = ((await res.json()).models || []).map((m) => m.name);
        const m = available.find((n) => n === wanted || n.startsWith(wanted));
        if (m) return m;
      }
    } catch { /* fall through */ }
  }
  return pickOllamaModel(); // default: same model as summaries
}

// Only bother the LLM when the text actually contains something it exists to
// fix: filler words or a self-correction. Everything else pastes instantly.
const NEEDS_POLISH = new RegExp(
  '\\b(' + [
    'uh+m?', 'um+', 'eh+m?', 'uhm', 'ehm', 'hmm+',
    'you know', 'basically', 'i mean', 'sort of', 'kind of',
    'nou ja', 'zeg maar', 'dus eigenlijk', 'weet je',
    'no,? wait', 'scratch that', 'never ?mind', 'start over',
    'nee,? wacht', 'laat maar', 'opnieuw', 'correctie', 'ik bedoel',
  ].join('|') + ')\\b', 'i',
);

// The model must edit, not reply. Reject anything that smells like a chat answer.
function plausible(cleaned, original) {
  if (!cleaned) return false;
  if (cleaned.length > original.length * 1.6 + 40) return false; // it added content
  if (/^(here('| i)s|sure|certainly|okay[,.]|of course|hier is|natuurlijk|zeker[,.])/i.test(cleaned)) return false;
  return true;
}

// Returns the cleaned text, or `text` unchanged when cleanup is off,
// unavailable, too slow, or produced something suspicious.
async function cleanupDictation(text) {
  const cfg = cfgStore.get();
  if (!cfg.dictCleanup) return text;
  if (!text || text.length < 15) return text; // not worth the round-trip
  if (!NEEDS_POLISH.test(text)) return text;  // nothing to fix — paste instantly
  try {
    const model = await pickCleanupModel();
    if (!model) return text;
    const vocab = [cfg.vocabulary, cfg.yourName !== 'You' ? cfg.yourName : ''].filter(Boolean).join(', ');
    const user = (vocab ? `If a word sounds like one of these, use this exact spelling — but never insert them otherwise: ${vocab}.\n\n` : '')
      + `Transcription:\n${text}`;
    const cleaned = (await ollamaChat(model, SYSTEM, user, 12000, 4096)).trim()
      .replace(/^["'`]+|["'`]+$/g, ''); // some models quote the whole reply
    return plausible(cleaned, text) ? cleaned : text;
  } catch (err) {
    console.error('dictation cleanup skipped:', err.message || err);
    return text;
  }
}

// Load the cleanup model while the user is still talking (called on hotkey press).
async function prewarmCleanup() {
  const cfg = cfgStore.get();
  if (!cfg.dictCleanup) return;
  try {
    const model = await pickCleanupModel();
    if (!model) return;
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: '30m' }),
      signal: AbortSignal.timeout(60000),
    });
  } catch { /* best effort */ }
}

module.exports = { cleanupDictation, prewarmCleanup };
