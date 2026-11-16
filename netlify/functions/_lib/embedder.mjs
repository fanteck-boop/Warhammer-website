// Local sentence embeddings with transformers.js (all-MiniLM-L6-v2, 8-bit quantized, 384 dims).
// Used by the index build (passages) and by the rules function (queries), so both sides
// share one model and one pooling setup. The pipeline is created once per process and
// reused across warm function invocations.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const DIMS = 384;
const DTYPE = 'q8';
const WINDOW_WORDS = 160; // the model reads at most 256 word pieces; longer chunks are embedded in windows

let pipePromise = null;

async function getPipe() {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Function bundles are read-only; /tmp is the only writable place on Netlify.
      env.cacheDir = join(tmpdir(), 'muster-hf-cache');
      env.allowLocalModels = false;
      return pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE });
    })().catch(e => { pipePromise = null; throw e; }); // allow a retry on the next call
  }
  return pipePromise;
}

/** Starts loading the model without waiting for it (cold-start warm-up). */
export function warmUp() { getPipe().catch(() => {}); }

/** True once the model is loaded and queries can be embedded immediately. */
let ready = false;
export const isReady = () => ready;

const normalize = v => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
};

async function embedBatch(texts) {
  const pipe = await getPipe();
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  ready = true;
  const rows = out.tolist();
  return rows.map(r => Float32Array.from(r));
}

/** Embeds one search query. Returns a normalised Float32Array. */
export async function embedQuery(text) {
  return (await embedBatch([String(text).slice(0, 1000)]))[0];
}

/** Embeds passages. Long passages are split into word windows and the window vectors averaged. */
export async function embedPassages(texts, batchSize = 16) {
  const windows = [], owner = [];
  texts.forEach((t, i) => {
    const words = t.split(/\s+/);
    for (let s = 0; s < words.length; s += WINDOW_WORDS) {
      windows.push(words.slice(s, s + WINDOW_WORDS).join(' '));
      owner.push(i);
      if (s + WINDOW_WORDS >= words.length) break;
    }
  });
  const sums = texts.map(() => new Float32Array(DIMS));
  for (let b = 0; b < windows.length; b += batchSize) {
    const vecs = await embedBatch(windows.slice(b, b + batchSize));
    vecs.forEach((v, k) => { const s = sums[owner[b + k]]; for (let d = 0; d < DIMS; d++) s[d] += v[d]; });
  }
  return sums.map(normalize);
}
