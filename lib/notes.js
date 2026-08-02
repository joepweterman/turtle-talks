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

module.exports = { buildMarkdown, prettyStamp };
