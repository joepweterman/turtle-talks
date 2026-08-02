// Learn from the user's edits: when "total talks" is corrected to
// "turtle talks", remember the pair and apply it to future transcripts.

function words(text) {
  return text.split(/\s+/).filter(Boolean);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[m][n];
}

// word-level LCS diff → replacement runs
function diffRuns(a, b) {
  const la = a.map((w) => w.toLowerCase());
  const lb = b.map((w) => w.toLowerCase());
  const m = la.length;
  const n = lb.length;
  const lcs = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = la[i] === lb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const runs = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (la[i] === lb[j]) { i++; j++; continue; }
    const si = i;
    const sj = j;
    while (i < m && j < n && la[i] !== lb[j]) {
      if (lcs[i + 1][j] >= lcs[i][j + 1]) i++; else j++;
    }
    runs.push({ from: a.slice(si, i), to: b.slice(sj, j), ai: si, aj: i, bi: sj, bj: j });
  }
  if (i < m || j < n) runs.push({ from: a.slice(i), to: b.slice(j), ai: i, aj: m, bi: j, bj: n });
  return runs;
}

function normalize(text) {
  return text.toLowerCase().replace(/[.,;:!?"'`]+$/g, '').trim();
}

// Extract plausible transcription fixes from an edit. Filters keep us from
// "learning" content rewrites: short phrases only, similar-sounding only.
function learnPairs(original, edited) {
  if (!original || !edited || original === edited) return [];
  const aw = words(original);
  const bw = words(edited);
  const pairs = [];
  for (const run of diffRuns(aw, bw)) {
    let from = run.from;
    let to = run.to;
    if (!from.length || !to.length) continue;
    if (from.length > 4 || to.length > 4) continue;
    if (Math.abs(from.length - to.length) > 1) continue;
    // a single replaced word ("total" → "Turtle") would over-correct real
    // uses of that word — extend with a matched neighbor for context
    if (from.length === 1 && to.length === 1) {
      if (run.aj < aw.length && run.bj < bw.length) {
        from = [...from, aw[run.aj]];
        to = [...to, bw[run.bj]];
      } else if (run.ai > 0 && run.bi > 0) {
        from = [aw[run.ai - 1], ...from];
        to = [bw[run.bi - 1], ...to];
      }
    }
    const fromText = from.join(' ').trim();
    const toText = to.join(' ').trim();
    if (fromText.length > 40 || toText.length > 40) continue;
    const nf = normalize(fromText);
    const nt = normalize(toText);
    if (nf === nt) continue; // punctuation/case only
    const dist = levenshtein(nf, nt) / Math.max(nf.length, nt.length);
    // transcription fixes sound alike — same first letter buys extra slack
    const limit = nf[0] === nt[0] ? 0.75 : 0.5;
    if (dist > limit) continue; // too different — probably a rewrite, not a fix
    pairs.push({ from: nf, to: toText.replace(/[.,;:!?]+$/g, '') });
  }
  return pairs;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyCorrections(text, pairs) {
  let out = text;
  for (const p of pairs || []) {
    if (!p.from || !p.to) continue;
    const re = new RegExp(`\\b${escapeRe(p.from)}\\b`, 'gi');
    out = out.replace(re, (match) => {
      // keep a leading capital if the original had one
      if (/^[A-ZÀ-Ž]/.test(match) && /^[a-zà-ž]/.test(p.to)) {
        return p.to[0].toUpperCase() + p.to.slice(1);
      }
      return p.to;
    });
  }
  return out;
}

// merge new pairs into an existing list (dedupe on `from`, cap length)
function mergePairs(existing, fresh) {
  const map = new Map((existing || []).map((p) => [p.from, p.to]));
  for (const p of fresh) map.set(p.from, p.to);
  return [...map.entries()].slice(-100).map(([from, to]) => ({ from, to }));
}

module.exports = { learnPairs, applyCorrections, mergePairs };
