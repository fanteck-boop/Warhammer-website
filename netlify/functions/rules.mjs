// POST /api/rules: the search_rules tool. Runs hybrid retrieval (BM25 + MiniLM
// embeddings) over the indexed official core rules and returns short cited passages.
// It never calls an LLM, so it costs no Groq tokens, but it gets the same origin
// check, size cap and per-visitor rate limit as /api/chat.
import { getStore } from '@netlify/blobs';
import rawIndex from './_data/rules-index.json' with { type: 'json' };
import { fail, json, readJsonRequest, rateLimit, rateLimitedResponse, clientIp, intEnv } from './_lib/guard.mjs';
import { buildSearchIndex, searchRules, GAMES } from './_lib/rules-search.mjs';
import { embedQuery } from './_lib/embedder.mjs';

const MAX_BODY = 2048;
const MAX_QUERY = 300;
// First call in a fresh container downloads and loads the model (several seconds).
// Rather than make the visitor wait, answer with BM25 alone if the embedding is not
// ready in time; the model keeps loading and later calls are fully hybrid.
const EMBED_WAIT_MS = 2500;

let index = null;
const getIndex = () => (index ||= buildSearchIndex(rawIndex));

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('embed timeout')), ms).unref?.())]);

export function createRulesHandler(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || console;
  const embed = deps.embedQuery || embedQuery;
  const openStore = () => deps.store || getStore({ name: 'rate-limits', consistency: 'strong' });

  return async function rulesHandler(req, context) {
    const parsed = await readJsonRequest(req, env, MAX_BODY);
    if (parsed.response) return parsed.response;
    const { query, game } = parsed.data;
    if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY) return fail(400, 'bad_request', 'query must be a non-empty string of at most 300 characters.');
    if (game != null && !GAMES.includes(game)) return fail(400, 'bad_request', 'game must be aos, 40k or mesbg.');

    let rl;
    try {
      rl = await rateLimit(openStore(), {
        scope: 'rules', ip: clientIp(req, context),
        perVisitor: intEnv(env.RULES_RATE_LIMIT, 120), windowMs: intEnv(env.CHAT_RATE_WINDOW_MIN, 10, 1, 1440) * 60000,
        dailyCap: intEnv(env.RULES_DAILY_CAP, 2000)
      });
    } catch (e) {
      log.error('rules: rate limiter unavailable', e && e.name);
      return fail(503, 'rate_limiter_unavailable', 'Rules search is temporarily unavailable. Please try again later.');
    }
    if (!rl.ok) return rateLimitedResponse(rl);

    try {
      const q = query.trim();
      let qvec = null;
      try { qvec = await withTimeout(embed(q), EMBED_WAIT_MS); } catch (e) { log.warn('rules: keyword-only search, embedding not ready:', e && e.message); }
      // 3 passages of about 600 chars each keep the JSON under the widget's 2500-char rules result cap.
      const out = await searchRules(getIndex(), q, { game, mode: qvec ? 'hybrid' : 'bm25', qvec, k: 3, maxChars: 2000 });
      if (!out.results.length) out.note = 'No passage in the indexed core rules matches. Say so; do not guess.';
      return json(200, out);
    } catch (e) {
      log.error('rules: search failed', e && e.name);
      return fail(500, 'search_failed', 'Rules search failed.');
    }
  };
}

export default createRulesHandler();

export const config = { path: '/api/rules' };
