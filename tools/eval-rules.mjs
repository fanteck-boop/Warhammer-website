#!/usr/bin/env node
// Retrieval eval for the rules RAG (no LLM calls).
//
//   node tools/eval-rules.mjs            # table for BM25, embeddings and hybrid
//   node tools/eval-rules.mjs --misses   # also list the questions hybrid misses at 4
//
// Each question lists the section(s) of the official document that answer it, as a
// regex tested against a chunk's section path. hit@k = one of the top k chunks is from
// an expected section. Section names come from the PDFs, not from the chunker output,
// so a chunk whose text landed under the wrong heading counts as a miss.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchIndex, rank } from '../netlify/functions/_lib/rules-search.mjs';
import { embedQuery } from '../netlify/functions/_lib/embedder.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const QUESTIONS = {
  '40k': [
    ['How does cover work?', /benefit of cover|terrain and visibility/],
    ['What is battle-shock?', /battle-shock/],
    ['Can I charge after advancing?', /charge phase|advance move/],
    ['How do objectives get controlled?', /level of control|objective/],
    ['How does the pile in work in the fight phase?', /pile.in/],
    ['How do hit rolls work?', /hit rolls/],
    ['What happens when my unit falls back?', /fall-back/],
    ['How does fire overwatch work?', /overwatch/],
    ['How does deep strike work?', /deep strike/],
    ['What is unit coherency?', /coherency/],
    ['What does devastating wounds do?', /devastating wounds/],
    ['How do saving throws and invulnerable saves work?', /save rolls|inflict damage/],
    ['How does feel no pain work?', /feel no pain/],
    ['How many command points do I get each turn?', /gain core cp|command phase/],
    ['How do units arrive from strategic reserves?', /strategic reserves/],
    ['How far can my unit charge?', /charge move|charge phase/],
    ['How does a leader join a bodyguard unit?', /attached units|leader/],
    ['How do mortal wounds work?', /mortal wounds/],
    ['What is engagement range?', /engagement/],
    ['How do units embark and disembark from transports?', /embark|transport/],
    ['How does heroic intervention work?', /heroic intervention/]
  ],
  aos: [
    ['How does cover work?', /universal terrain abilities|terrain overview|terrain types/],
    ['How does a charge work?', /universal core abilities|charge/],
    ['What does wholly within mean?', /wholly within/],
    ['How do pile-in moves work?', /pile-in/],
    ['How do objectives get controlled?', /objective/],
    ['How do ward saves work?', /ward save/],
    ['What is mortal damage?', /mortal damage/],
    ['How does unit coherency work?', /coherency/],
    ['How does strike-first work?', /strike-first/],
    ['How do I unbind a spell?', /unbind/],
    ['What is a wizard power level?', /power level|wizards/],
    ['How do I earn command points?', /command points|commands overview/],
    ['What does the all-out attack command do?', /commands/],
    ['What is combat range?', /combat range/],
    ['How does flying work when moving?', /flying/],
    ['What is a reinforced unit?', /reinforced/],
    ['How are reserve units set up?', /reserve units|setting up units/],
    ['How does healing work?', /healing/],
    ['How does visibility work?', /visibility/],
    ['How do battle tactics work?', /battle tactics/],
    ['What are the phases of a turn?', /turn phases|battle sequence/],
    ['What is a guarded hero?', /guarded hero/]
  ],
  mesbg: [
    ['How is priority decided each turn?', /priority/],
    ['How does moving work?', /move phase/],
    ['How does charging an enemy work?', /move phase/],
    ['How does shooting work?', /shoot phase/],
    ['What do I need to roll to wound?', /to wound|shoot phase|resolving a combat/],
    ['How is a fight resolved with a duel roll?', /fight phase|resolving a combat/],
    ['What happens to the loser of a fight?', /resolving a combat|fight phase/],
    ['How does line of sight work?', /line of sight/],
    ['What does a natural 6 mean?', /natural rolls/],
    ['How does a hero use might points?', /might, will and fate|heroes/],
    ['How does fate save a hero?', /might, will and fate|heroes/],
    ['How do cavalry models work?', /cavalry/],
    ['How do I cast a magical power?', /magical powers/],
    ['What does sorcerous blast do?', /sorcerous blast/],
    ['How do two-handed weapons work?', /weapons/],
    ['What do the profile characteristics mean?', /profiles|introduction/],
    ['How do courage tests work?', /courage/],
    ['What are the phases of a turn?', /turns|basic principles/],
    ['How do I measure distances?', /measuring/],
    ['How does a Fight work when two models are in combat, who strikes first?', /duel roll/],
    ['Who strikes first in a fight?', /duel roll|winner makes strikes/],
    ['What are active and passive special rules?', /special rules/],
    ['What does black dart do?', /black dart/],
    ['What is a control zone?', /move phase/]
  ]
};

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export async function evaluate(idx, opts = {}) {
  const rows = [], misses = [];
  for (const [game, qs] of Object.entries(QUESTIONS)) {
    if (!idx.chunks.some(c => c.game === game)) continue;
    const vecs = [];
    for (const [q] of qs) vecs.push(await embedQuery(q)); // embed once, reuse for both modes
    for (const mode of ['bm25', 'embed', 'hybrid']) {
      let h1 = 0, h4 = 0;
      for (let i = 0; i < qs.length; i++) {
        const [q, expect] = qs[i];
        const top = (await rank(idx, q, { ...opts, game, mode, qvec: vecs[i] })).slice(0, 4);
        const hit = top.findIndex(c => expect.test(c.section.toLowerCase()));
        if (hit === 0) h1++;
        if (hit >= 0) h4++;
        else if (mode === 'hybrid') misses.push({ game, q, got: top.map(c => c.section.split(' > ').slice(-1)[0]) });
      }
      rows.push({ game, mode, questions: qs.length, 'hit@1 %': pct(h1, qs.length), 'hit@4 %': pct(h4, qs.length) });
    }
  }
  return { rows, misses };
}

async function main() {
  const raw = JSON.parse(await readFile(join(ROOT, 'netlify', 'functions', '_data', 'rules-index.json'), 'utf8'));
  const idx = buildSearchIndex(raw);
  const { rows, misses } = await evaluate(idx);
  console.table(rows);
  if (process.argv.includes('--misses')) for (const m of misses) console.log(`[${m.game}] ${m.q}\n    got: ${m.got.join(' | ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e); process.exit(1); });
