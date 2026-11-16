// Hybrid retrieval over the core rules index: BM25 (keywords) + cosine similarity on
// MiniLM embeddings (meaning), fused with Reciprocal Rank Fusion. Pure functions plus a
// lazily built in-memory index, so it runs the same in the Netlify function and in
// tools/eval-rules.mjs.
import { embedQuery } from './embedder.mjs';

export const GAMES = ['aos', '40k', 'mesbg'];
const BM25_K1 = 1.2, BM25_B = 0.75;
const RRF_K = 60;
const DEFAULTS = { k: 4, maxChars: 1500, wBm25: 2, wEmb: 1, pool: 30 }; // weights tuned with tools/eval-rules.mjs

const STOP = new Set(('a an and are as at be by can do does for from has have how i if in into is it its may my not of on or ' +
  'such than that the their them then there these they this to was what when where which while who will with would you your ' +
  'work works rule rules mean means').split(' '));

// Light stemming: enough to match "charges"/"charging"/"charged" to "charg".
const stem = w => w.length > 4 ? w.replace(/(ings?|ed|es|s)$/, '').replace(/(.)\1$/, '$1') : w;
export const tokenize = text => String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[\u2019']/g, '').split(/[^a-z0-9+]+/).filter(t => t && !STOP.has(t)).map(stem);

/** Builds search structures from the raw index JSON ({chunks:[{text, section, v}], sources}). */
export function buildSearchIndex(raw) {
  const chunks = raw.chunks.map(c => {
    // Heading words count twice: a chunk titled "Cover" is about cover.
    const head = c.section.split(' > ').slice(-2).join(' ');
    const terms = tokenize(head + ' ' + head + ' ' + (c.hint || '') + ' ' + c.text);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    let vec = null;
    if (c.v) {
      const b = Buffer.from(c.v, 'base64');
      const q = new Int8Array(b.buffer, b.byteOffset, b.length);
      let n = 0;
      for (const x of q) n += x * x;
      n = Math.sqrt(n) || 1;
      vec = Float32Array.from(q, x => x / n);
    }
    return { ...c, v: undefined, len: terms.length, tf, vec };
  });
  const df = new Map();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = chunks.reduce((a, c) => a + c.len, 0) / (chunks.length || 1);
  const sources = Object.fromEntries((raw.sources || []).map(s => [s.id, s]));
  return { chunks, df, avgLen, sources, N: chunks.length, model: raw.model };
}

function bm25Rank(idx, query, list) {
  const qt = [...new Set(tokenize(query))];
  const scored = list.map(c => {
    let s = 0;
    for (const t of qt) {
      const f = c.tf.get(t);
      if (!f) continue;
      const n = idx.df.get(t) || 0;
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
      s += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * c.len / idx.avgLen));
    }
    return { c, s };
  }).filter(x => x.s > 0);
  return scored.sort((a, b) => b.s - a.s);
}

function cosineRank(qvec, list) {
  return list.filter(c => c.vec).map(c => {
    let s = 0;
    for (let i = 0; i < qvec.length; i++) s += qvec[i] * c.vec[i];
    return { c, s };
  }).sort((a, b) => b.s - a.s);
}

// Reciprocal Rank Fusion: score = sum of w / (k + rank). Robust to the two scores
// having different scales, which is why it is used instead of adding raw scores.
function rrf(lists, pool) {
  const fused = new Map();
  for (const { ranked, w } of lists) {
    ranked.slice(0, pool).forEach(({ c }, i) => {
      const e = fused.get(c.id) || { c, s: 0 };
      e.s += w / (RRF_K + i + 1);
      fused.set(c.id, e);
    });
  }
  return [...fused.values()].sort((a, b) => b.s - a.s);
}

/**
 * Ranks chunks for a query. mode: 'hybrid' | 'bm25' | 'embed'.
 * qvec may be passed in (pre-computed query embedding); otherwise it is computed when needed.
 * Returns ranked chunk objects (full text), best first.
 */
export async function rank(idx, query, { game, mode = 'hybrid', qvec, pool = DEFAULTS.pool, wBm25 = DEFAULTS.wBm25, wEmb = DEFAULTS.wEmb } = {}) {
  const list = GAMES.includes(game) ? idx.chunks.filter(c => c.game === game) : idx.chunks;
  if (mode === 'bm25') return bm25Rank(idx, query, list).map(x => x.c);
  const v = qvec || await embedQuery(query);
  if (mode === 'embed') return cosineRank(v, list).map(x => x.c);
  return rrf([{ ranked: bm25Rank(idx, query, list), w: wBm25 }, { ranked: cosineRank(v, list), w: wEmb }], pool).map(x => x.c);
}

// Picks the most query-relevant run of sentences from a chunk, at most `budget` chars.
export function snippet(text, query, budget) {
  const clean = text.replace(/\s*\n\s*/g, ' ').trim();
  if (clean.length <= budget) return clean;
  // rule numbers like "13.08" must not end a sentence: hide their dots while splitting
  const sents = (clean.replace(/(\d)\.(?=\d)/g, '$1\u0001').match(/[^.!?]+[.!?]+["\u2019')\]]*\s*|[^.!?]+$/g) || [clean]).map(s => s.replace(/\u0001/g, '.'));
  const qt = new Set(tokenize(query));
  const score = s => tokenize(s).filter(t => qt.has(t)).length;
  let best = 0, bestScore = -1;
  // ties go to the longer sentence: the short one is usually an intro or heading
  sents.forEach((s, i) => { const sc = score(s); if (sc > bestScore || (sc === bestScore && s.length > sents[best].length)) { bestScore = sc; best = i; } });
  // start at the best sentence (never let a preceding one crowd it out), then extend forward, then backward
  let lo = best, hi = best, out = sents[best];
  if (out.length > budget) return out.slice(0, budget - 1).trim() + '…';
  while (hi + 1 < sents.length && (out + sents[hi + 1]).length <= budget) out += sents[++hi];
  while (lo > 0 && (sents[lo - 1] + out).length <= budget) out = sents[--lo] + out;
  return (lo > 0 ? '…' : '') + out.trim() + (hi + 1 < sents.length ? '' : '');
}

const shortSection = s => s.split(' > ').slice(-2).join(' > ');

/**
 * Full search: rank, then return the top k passages trimmed to maxChars in total,
 * each with its citation fields. Never throws on an embedding failure: it falls back to BM25.
 */
export async function searchRules(idx, query, opts = {}) {
  const { k = DEFAULTS.k, maxChars = DEFAULTS.maxChars, game } = opts;
  let mode = opts.mode || 'hybrid', ranked;
  try {
    ranked = await rank(idx, query, { ...opts, mode });
  } catch (e) {
    if (mode === 'bm25') throw e;
    mode = 'bm25';
    ranked = await rank(idx, query, { ...opts, mode });
  }
  const top = ranked.slice(0, k);
  const results = [];
  let left = maxChars;
  top.forEach((c, i) => {
    const src = idx.sources[c.source] || {};
    const meta = { source: src.cite || c.source, section: shortSection(c.section), page: c.page };
    const overhead = JSON.stringify(meta).length + 12;
    const share = Math.floor((left - overhead * (top.length - i)) / (top.length - i)); // split what is left fairly
    if (share < 120) return;
    const text = snippet(c.text, query, Math.max(share, Math.min(c.text.length, Math.floor(share * 1.3)))); // a chunk only a bit over budget is shown whole
    left -= text.length + overhead;
    results.push({ ...meta, text });
  });
  return { game: GAMES.includes(game) ? game : 'all', mode, results };
}
