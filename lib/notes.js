function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function wordSet(text) {
  return new Set(
    text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 1),
  );
}

// Without a headset the microphone also hears the speakers, so "them" shows up
// on both tracks. Drop mic segments whose words are mostly contained in
// overlapping system-audio segments — the system track is the clean source.
function filterEcho(segments) {
  const sys = segments.filter((s) => s.track === 'sys');
  if (sys.length === 0) return segments;
  return segments.filter((seg) => {
    if (seg.track !== 'mic') return true;
    const win = sys.filter((s) => s.fromMs < seg.toMs + 4000 && s.toMs > seg.fromMs - 4000);
    if (win.length === 0) return true;
    const micWords = wordSet(seg.text);
    if (micWords.size === 0) return false;
    const sysWords = wordSet(win.map((s) => s.text).join(' '));
    let common = 0;
    for (const w of micWords) if (sysWords.has(w)) common += 1;
    return common / micWords.size < 0.7;
  });
}

// Merge timestamped segments from both tracks into speaker turns.
// segments: [{track: 'mic'|'sys', fromMs, toMs, text}] with absolute offsets.
function buildTurns(segments) {
  const sorted = [...segments].sort((a, b) => a.fromMs - b.fromMs);
  const turns = [];
  for (const seg of sorted) {
    const last = turns[turns.length - 1];
    if (last && last.track === seg.track) {
      last.text += ` ${seg.text}`;
    } else {
      turns.push({ track: seg.track, fromMs: seg.fromMs, text: seg.text });
    }
  }
  return turns;
}

function speakerLabels(lang, yourName) {
  return {
    mic: yourName && yourName !== 'You' ? yourName : (lang === 'nl' ? 'Jij' : 'You'),
    sys: lang === 'nl' ? 'Gesprekspartner' : 'Them',
  };
}

function turnsToMarkdown(turns, lang, yourName) {
  const labels = speakerLabels(lang, yourName);
  const spoken = new Set(turns.map((t) => t.track));
  if (spoken.size <= 1) {
    // one-sided recording (e.g. in-person meeting) — labels add nothing
    return turns.map((t) => t.text).join('\n');
  }
  return turns
    .map((t) => `**${labels[t.track]} · ${fmtMs(t.fromMs)}** ${t.text}`)
    .join('\n\n');
}

function prettyStamp(stamp) {
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
  if (!m) return stamp;
  return `${m[3]}-${m[2]}-${m[1]} · ${m[4]}:${m[5]}`;
}

function buildMarkdown(stamp, lang, transcript, summary) {
  const langName = lang === 'nl' ? 'Nederlands' : 'English';
  const title = (summary && summary.title) || `Meeting ${prettyStamp(stamp)}`;
  const noSummary = lang === 'nl'
    ? '_Geen samenvatting: geen lokale LLM (Ollama) actief en geen ANTHROPIC_API_KEY ingesteld. Transcript hieronder._'
    : '_No summary: no local LLM (Ollama) running and no ANTHROPIC_API_KEY set. Transcript below._';
  const body = summary
    ? `${summary.text.trim()}\n\n_Summary by ${summary.provider}._`
    : noSummary;
  return [
    `# ${title}`,
    '',
    `_${prettyStamp(stamp)} · ${langName} · [Audio](./${stamp}.webm)_`,
    '',
    body,
    '',
    '---',
    '',
    '## Transcript',
    '',
    `${(transcript || '').trim()}`,
    '',
  ].join('\n');
}

module.exports = { buildMarkdown, prettyStamp, buildTurns, turnsToMarkdown, speakerLabels, fmtMs, filterEcho };
