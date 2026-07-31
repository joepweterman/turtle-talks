function buildMarkdown(stamp, lang, transcript, summary) {
  const langName = lang === 'nl' ? 'Nederlands' : 'English';
  const noSummary = lang === 'nl'
    ? '_Geen samenvatting: geen lokale LLM (Ollama) actief en geen ANTHROPIC_API_KEY ingesteld. Transcript hieronder._'
    : '_No summary: no local LLM (Ollama) running and no ANTHROPIC_API_KEY set. Transcript below._';
  const transcriptHeading = lang === 'nl' ? 'Transcript' : 'Transcript';
  const body = summary
    ? `${summary.text.trim()}\n\n_Summary by ${summary.provider}._`
    : noSummary;
  return [
    `# Meeting notes — ${stamp} (${langName})`,
    '',
    `Audio: [${stamp}.webm](./${stamp}.webm)`,
    '',
    body,
    '',
    '---',
    '',
    `## ${transcriptHeading}`,
    '',
    `${(transcript || '').trim()}`,
    '',
  ].join('\n');
}

module.exports = { buildMarkdown };
