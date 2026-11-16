#!/usr/bin/env node
// Builds the rules RAG index from the official free PDFs in rules-src/.
//
//   node tools/build-rules-index.mjs
//
// Pipeline: PDF -> text lines per page (with font size and position) -> drop
// running headers, footers, page numbers and "SEE ALSO" sidebars -> detect
// section headings by font size -> chunk per section (about 300 to 600 tokens,
// small overlap) -> embed each chunk locally with all-MiniLM-L6-v2 (q8) ->
// store int8 vectors next to the chunk text in netlify/functions/_data/rules-index.json.
// BM25 statistics are computed at load time from the stored text, so they never drift.
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { getDocumentProxy } from 'unpdf';
import { embedPassages, MODEL_ID, DIMS } from '../netlify/functions/_lib/embedder.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'rules-src');
const OUT = join(ROOT, 'netlify', 'functions', '_data', 'rules-index.json');

// Chunk sizes in rough tokens (chars / 4 is close enough for English rules text).
const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 600;
const MIN_TOKENS = 40;      // a section shorter than this is merged into the next one
const OVERLAP_CHARS = 200;  // carried over between chunks of one long section

// ---------- text extraction ----------

// Some fonts in these PDFs have no Unicode map: ligatures and punctuation come out as
// control characters (C0 range). Known heading words are repaired, a control character
// between letters is a hyphen ("PILE<ctl>IN"), and garbled small-caps keywords are dropped.
const CTL = '[\u0001-\u001f\u007f]';
const REPAIRS = [
  [new RegExp(String.raw`TER${CTL}\s*(IN)?\b`, 'gi'), 'TERRAIN'],
  [new RegExp(String.raw`CHA${CTL}CTER`, 'gi'), 'CHARACTER'],
  [new RegExp(String.raw`CONT${CTL}\s*DICTORY`, 'gi'), 'CONTRADICTORY'],
  [new RegExp(String.raw`DIAG${CTL}\s*M?\b`, 'gi'), 'DIAGRAM'],
  [new RegExp(String.raw`P${CTL}YER`, 'gi'), 'PLAYER'],
  [new RegExp(String.raw`GENE${CTL}L`, 'gi'), 'GENERAL'],
  [new RegExp(String.raw`T${CTL}ITS`, 'gi'), 'TRAITS'],
  [new RegExp(String.raw`${CTL}NDOM`, 'gi'), 'RANDOM'],
  [new RegExp(String.raw`A${CTL}ACK`, 'gi'), 'ATTACK']
];
// Words split apart by kerning in display fonts (no control characters involved).
const SPLIT_WORDS = [
  [/\bSPEA\s?R\s?HEA\s?D\b/g, 'SPEARHEAD'],
  [/\bCHAR\s+ACTERISTICS\b/gi, 'CHARACTERISTICS'],
  [/\bCOMBAT\s+NGE\b/g, 'COMBAT RANGE'],
  [/\bNDOM\b/g, 'RANDOM'],
  [/fi (xed|lls?|ls)\b/g, 'fi$1'] // "fi xed": the fi ligature is followed by a space
];
const fixGlyphs = s => {
  if (!new RegExp(CTL).test(s)) return s;
  for (const [re, to] of REPAIRS) s = s.replace(re, to);
  s = s.replace(new RegExp(String.raw`([A-Za-z0-9])${CTL}+(?=[A-Za-z0-9])`, 'g'), '$1-');
  return s.split(' ').map(w => {
    const bad = (w.match(new RegExp(CTL, 'g')) || []).length;
    return bad && bad >= w.replace(new RegExp(CTL, 'g'), '').length ? '' : w.replace(new RegExp(CTL, 'g'), '');
  }).join(' ');
};

const tidy = s => SPLIT_WORDS.reduce((t, [re, to]) => t.replace(re, to), fixGlyphs(s.replace(/[\u0000\u200b]/g, '')))
  .replace(/\s*\uFFFD(\s*\uFFFD)+\s*/g, ' ')      // dot leaders rendered as missing glyphs
  .replace(/\uFFFD/g, '.')                        // a lone missing glyph is a full stop in these files
  .replace(/\(\s*\)/g, '')                        // empty "( )" left by page-reference icons
  .replace(/(\w) - (\w)/g, '$1-$2')               // "six - sided" -> "six-sided"
  .replace(/\s+([.,;:!?)\u2019'])/g, '$1')
  .replace(/([(\u2018])\s+/g, '$1')
  .replace(/\s{2,}/g, ' ')
  .trim();

// One page -> lines of {text, size, x, y}. Items on the same baseline that touch
// horizontally are joined; identical items drawn twice (shadow layers) are skipped.
async function pageLines(page) {
  const { items } = await page.getTextContent();
  const seen = new Set();
  const lines = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    const size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10;
    const key = it.str + '|' + Math.round(x) + '|' + Math.round(y);
    if (seen.has(key)) continue;
    seen.add(key);
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) < 2 && Math.abs(last.size - size) < 0.6 && x >= last.x && x - last.xEnd < 15) {
      last.text += (last.text.endsWith(' ') || it.str.startsWith(' ') ? '' : ' ') + it.str;
      last.xEnd = Math.max(last.xEnd, x + (it.width || 0));
    } else {
      lines.push({ text: it.str, size, x, y, xEnd: x + (it.width || 0) });
    }
  }
  return lines.map(l => ({ ...l, text: tidy(l.text) })).filter(l => l.text);
}

const isUpper = t => { const letters = t.replace(/[^A-Za-z]/g, ''); return letters.length >= 2 && letters.replace(/[^A-Z]/g, '').length / letters.length >= 0.8; };
const numbered = t => /^\d{1,2}(\.\d{1,2}){0,3}\s+[A-Z][A-Z'\u2019&,\- ]{2,}$/.test(t);
const titleCase = t => t.toLowerCase().replace(/(^|[\s\-(>])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(And|Or|Of|The|In|To|A|An|On|For)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());

async function extract(file, range) {
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)));
  const first = range ? range[0] : 1, last = range ? Math.min(range[1], pdf.numPages) : pdf.numPages;
  const pages = [];
  for (let p = first; p <= last; p++) {
    const page = await pdf.getPage(p);
    const { height } = page.getViewport({ scale: 1 });
    pages.push({ index: p, height, lines: await pageLines(page) });
  }
  return pages;
}

// Running headers/footers: text at the top or bottom 9% of a page that repeats on
// at least a fifth of the pages (digits normalised so "Page 3" equals "Page 4").
function stripEdges(pages) {
  const edge = (l, h) => l.y > h * 0.91 || l.y < h * 0.09;
  const norm = t => t.replace(/\d+/g, '#').toLowerCase();
  const count = new Map();
  for (const pg of pages) {
    const keys = new Set(pg.lines.filter(l => edge(l, pg.height)).map(l => norm(l.text)));
    keys.forEach(k => count.set(k, (count.get(k) || 0) + 1));
  }
  const minRepeat = Math.max(2, Math.ceil(pages.length * 0.2));
  for (const pg of pages) {
    pg.printed = null;
    pg.lines = pg.lines.filter(l => {
      if (!edge(l, pg.height)) return true;
      if (/^\d{1,3}$/.test(l.text)) { pg.printed = pg.printed || Number(l.text); return false; } // page number
      return (count.get(norm(l.text)) || 0) < minRepeat || pages.length < 3;
    });
  }
}

// Most common font size, weighted by characters: that is the body text.
function bodySize(pages) {
  const w = new Map();
  pages.forEach(pg => pg.lines.forEach(l => w.set(l.size, (w.get(l.size) || 0) + l.text.length)));
  return [...w.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 9;
}

// Turns pages into a flat list of sections: {path: [..headings], page, text}.
function sectionize(pages, docTitle) {
  const body = bodySize(pages);
  const isHeading = l => l.text.length <= 70 && /[A-Za-z]{3}/.test(l.text) && !/^\d+$/.test(l.text) &&
    ((l.size >= body * 1.12 && isUpper(l.text)) || (numbered(l.text) && l.size >= body));
  const numberedDoc = pages.reduce((n, pg) => n + pg.lines.filter(l => numbered(l.text) && l.size >= body).length, 0) >= 20;
  const CHAPTER_SIZE = body * 2.5; // chapter titles stay on the path, smaller unnumbered titles do not
  const sections = [];
  let stack = [];          // [{title, raw, size, num?, depth?}]
  let cur = null;
  // Phase diagram labels such as "1 Start of Phase 2 Shoot 3 End" are not real sections.
  const STEP_LABEL = /\b1\.? [A-Za-z].*\b2\.? [A-Za-z]/;
  const pathOf = () => stack.filter(s => !STEP_LABEL.test(s.title)).map(s => (s.num ? s.num + ' ' : '') + s.title);
  const open = (pageNo) => { cur = { path: pathOf(), page: pageNo, parts: [] }; sections.push(cur); };
  for (const pg of pages) {
    const pageNo = pg.printed || pg.index;
    let sidebarX = null;   // "SEE ALSO" sidebars only list cross references: drop them
    let prev = null;
    for (const l of pg.lines) {
      if (/^see also$/i.test(l.text)) { sidebarX = l.x - 5; continue; }
      if (sidebarX != null && l.x >= sidebarX) continue;
      if (/^\u25ba/.test(l.text)) continue; // "\u25ba Rule name" lines are cross references
      if (/^\d{2}(\.\d{2})?$/.test(l.text) && l.size < body * 1.12) { // 40k section numbers and inline refs
        if (prev && prev.heading && Math.abs(prev.y - l.y) < 2 && !/^\d/.test(stack[stack.length - 1]?.title || '')) {
          stack[stack.length - 1].num = l.text;
          cur.path = pathOf();
        }
        continue;
      }
      if (isHeading(l) && STEP_LABEL.test(l.text)) continue; // a whole diagram label on one line
      if (isHeading(l)) {
        // A heading that continues the previous heading line (same size, next line down).
        if (prev && prev.heading && Math.abs(prev.size - l.size) < 0.6 && prev.y - l.y > 0 && prev.y - l.y < l.size * 1.6) {
          const top = stack[stack.length - 1];
          top.raw += ' ' + l.text;
          top.title = titleCase(top.num && numberedDoc ? top.raw.slice(top.num.length + 1) : top.raw);
          cur.path = pathOf();
          prev = { ...l, heading: true };
          continue;
        }
        const num = numbered(l.text) ? l.text.split(/\s+/)[0] : null;
        if (num && numberedDoc) {
          // Numbered rules (AoS "2.1 MEASURING DISTANCES"): the number is the real hierarchy.
          // Drop decorative box titles and any numbered section at the same or a deeper level.
          const depth = num.replace(/\.0$/, '').split('.').length;
          while (stack.length && (stack[stack.length - 1].size < CHAPTER_SIZE && (!stack[stack.length - 1].num || stack[stack.length - 1].depth >= depth))) stack.pop();
          stack.push({ title: titleCase(l.text.slice(num.length + 1)), raw: l.text, size: l.size, num, depth });
        } else {
          while (stack.length && stack[stack.length - 1].size <= l.size + 0.3) stack.pop();
          stack.push({ title: titleCase(l.text), raw: l.text, size: l.size });
        }
        open(pageNo);
        prev = { ...l, heading: true };
        continue;
      }
      if (!cur) { stack = [{ title: docTitle, raw: docTitle, size: 999 }]; open(pageNo); }
      // New paragraph when the vertical gap is large or the line starts a bullet.
      const gap = prev && !prev.heading ? prev.y - l.y : 0;
      const para = !cur.parts.length || gap > l.size * 1.7 || gap < 0 || /^[\u25aa\u2022\u25ba\-]/.test(l.text);
      if (para) cur.parts.push(l.text);
      else {
        const lastP = cur.parts[cur.parts.length - 1];
        cur.parts[cur.parts.length - 1] = /-$/.test(lastP) && !/ -$/.test(lastP) ? lastP.slice(0, -1) + l.text : lastP + ' ' + l.text;
      }
      prev = l;
    }
  }
  return sections.map(s => ({ path: s.path.filter(t => !STEP_LABEL.test(t)), page: s.page, text: s.parts.join('\n').trim() })).filter(s => s.text.length > 0);
}

// ---------- chunking ----------

function splitLong(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?\n]+[.!?]*["\u2019')\]]*\s*|\n+/g) || [text];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && (buf + s).length > maxChars) {
      out.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - OVERLAP_CHARS)).replace(/^\S*\s/, ''); // overlap: tail of the previous chunk
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// The MESBG guide sets its rule names as inline ALL-CAPS run-in headings ("DUEL ROLL To see who wins...")
// inside one big section, so the key rule ended up in a 2000-char chunk with no label of its own.
// Split at those headings and add the heading to the section path.
const RUN_IN = /(^|\n|[.!?]["’)]?\s+)([A-Z][A-Z’'-]{2,}(?: [A-Z][A-Z’'-]*){0,4}) (?=[A-Z][a-z])/g;
function splitRunIn(sections) {
  const out = [];
  for (const sec of sections) {
    const marks = [...sec.text.matchAll(RUN_IN)].map(m => ({ at: m.index + m[1].length, title: m[2] }));
    if (!marks.length) { out.push(sec); continue; }
    if (marks[0].at > 0) out.push({ ...sec, text: sec.text.slice(0, marks[0].at).trim() });
    marks.forEach((m, i) => {
      const text = sec.text.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : undefined).trim();
      out.push({ path: sec.path.concat(titleCase(m.title)), page: sec.page, text });
    });
  }
  return out.filter(x => x.text);
}

// Search hints: plain words players use that the rule text itself never says. Stored on the chunk and
// indexed with it (BM25 and embedding), never shown to the model.
const HINTS = [
  [/duel roll$/i, 'how does a fight work: two models in combat, resolve the fight, who strikes first, who wins the fight, roll dice, highest roll wins'],
  [/winner makes strikes$/i, 'fight combat who strikes first winner strikes after the duel roll']
];
const hintFor = (game, path) => game === 'mesbg' ? (HINTS.find(([re]) => re.test(path.join(' > '))) || [])[1] : undefined;

function chunkSections(sections, source) {
  if (source.game === 'mesbg') sections = splitRunIn(sections);
  const chunks = [];
  let carry = null; // tiny section waiting to be merged into the next one
  for (const s of sections) {
    let sec = s;
    if (carry) { sec = { path: carry.path, page: carry.page, text: carry.text + '\n' + s.path[s.path.length - 1] + ': ' + s.text }; carry = null; }
    if (sec.text.length < MIN_TOKENS * CHARS_PER_TOKEN) { carry = sec; continue; }
    for (const part of splitLong(sec.text, MAX_TOKENS * CHARS_PER_TOKEN)) {
      { const hint = hintFor(source.game, sec.path); chunks.push({ id: `${source.id}-${chunks.length + 1}`, game: source.game, source: source.id, section: sec.path.join(' > '), page: sec.page, text: part, ...(hint ? { hint } : {}) }); }
    }
  }
  if (carry) chunks.push({ id: `${source.id}-${chunks.length + 1}`, game: source.game, source: source.id, section: carry.path.join(' > '), page: carry.page, text: carry.text });
  return chunks;
}

// ---------- vectors ----------

// Normalised float vector -> int8 (per-vector scale) -> base64. Ranking only needs
// the direction, and the loader renormalises, so the scale itself is not stored.
function toInt8Base64(vec) {
  let max = 0;
  for (const v of vec) max = Math.max(max, Math.abs(v));
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.round((vec[i] / (max || 1)) * 127);
  return Buffer.from(q.buffer).toString('base64');
}

// ---------- main ----------

async function listSources() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'rules', 'sources.json'), 'utf8'));
  const list = manifest.sources.map(s => ({ ...s, path: join(SRC_DIR, s.file) }));
  // Extra PDFs the owner dropped into rules-src/ (e.g. their own copy of a rules manual).
  // The file name prefix picks the game: 40k-*.pdf, aos-*.pdf or mesbg-*.pdf.
  if (existsSync(SRC_DIR)) {
    for (const f of await readdir(SRC_DIR)) {
      if (!/\.pdf$/i.test(f) || list.some(s => s.file === f)) continue;
      const game = (/^(40k|aos|mesbg)[-_]/i.exec(f) || [])[1];
      if (!game) { console.warn(`skip ${f}: name it 40k-..., aos-... or mesbg-... so the game is known`); continue; }
      const name = titleCase(basename(f, '.pdf').replace(/^(40k|aos|mesbg)[-_]/i, '').replace(/[-_]+/g, ' '));
      list.push({ id: 'local-' + basename(f, '.pdf').toLowerCase().replace(/[^a-z0-9]+/g, '-'), game: game.toLowerCase(), title: name, cite: name, file: f, path: join(SRC_DIR, f), local: true });
    }
  }
  return list;
}

async function main() {
  const sources = await listSources();
  const chunks = [];
  const report = [];
  for (const src of sources) {
    if (!existsSync(src.path)) { console.warn(`missing ${src.file}: download it from ${src.url || '(local file)'} into rules-src/`); continue; }
    const pages = await extract(src.path, src.pages);
    stripEdges(pages);
    const sections = sectionize(pages, src.cite);
    const cs = chunkSections(sections, src);
    chunks.push(...cs);
    const toks = cs.map(c => c.text.length / CHARS_PER_TOKEN);
    report.push({ source: src.id, game: src.game, pages: pages.length, sections: sections.length, chunks: cs.length,
      avg_tokens: Math.round(toks.reduce((a, b) => a + b, 0) / (toks.length || 1)), max_tokens: Math.round(Math.max(0, ...toks)) });
  }
  if (!chunks.length) { console.error('No chunks built. Are the PDFs in rules-src/? See rules-src/README.md.'); process.exit(1); }

  if (process.argv.includes('--dump')) { // inspect chunking without embedding
    console.table(report);
    const j = process.argv.indexOf('--json');
    if (j > 0) await writeFile(process.argv[j + 1], JSON.stringify(chunks, null, 1));
    chunks.forEach(c => console.log(`[${c.id}] p.${c.page} ${c.section} (${c.text.length} chars)\n  ${c.text.slice(0, 160).replace(/\n/g, ' / ')}`));
    return;
  }
  console.log(`embedding ${chunks.length} chunks with ${MODEL_ID} ...`);
  const t0 = Date.now();
  const vecs = await embedPassages(chunks.map(c => c.section.split(' > ').slice(-2).join(': ') + '\n' + (c.hint ? c.hint + '\n' : '') + c.text));
  console.log(`embedded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const index = {
    format: 1,
    model: MODEL_ID,
    dims: DIMS,
    built: new Date().toISOString(),
    sources: sources.filter(s => existsSync(s.path)).map(({ id, game, title, cite, url, version, date, local }) => ({ id, game, title, cite, url: url || null, version: version || null, date: date || null, local: !!local })),
    chunks: chunks.map((c, i) => ({ ...c, v: toInt8Base64(vecs[i]) }))
  };
  const json = JSON.stringify(index);
  await writeFile(OUT, json);
  const size = (await stat(OUT)).size;
  console.table(report);
  console.log(`wrote ${OUT}`);
  console.log(`index size: ${(size / 1024).toFixed(0)} KB raw, ${(gzipSync(json).length / 1024).toFixed(0)} KB gzipped, ${chunks.length} chunks`);
}

main().catch(e => { console.error(e); process.exit(1); });
