// Shared request guards for the public API functions: same-origin check, capped body
// reading, JSON responses and a privacy-preserving rate limiter on Netlify Blobs.
import { createHmac, randomBytes } from 'node:crypto';

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
});

/** A JSON error. Messages are fixed strings written here, never text from upstream services. */
export const fail = (status, code, message, headers) => json(status, { error: { code, message } }, headers);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Allowed browser origins: the origin the request was sent to, the site URLs Netlify
 * provides (URL, DEPLOY_PRIME_URL, DEPLOY_URL), extra ones from ALLOWED_ORIGINS
 * (comma separated), and localhost on any port for `netlify dev`.
 * Note: this stops other websites from using the API from a visitor's browser. It is not
 * authentication (a script can fake the header), which is why the rate limits exist.
 */
export function originAllowed(req, env) {
  const raw = req.headers.get('origin') || req.headers.get('referer');
  if (!raw) return false;
  let origin;
  try { origin = new URL(raw).origin; } catch { return false; }
  const allowed = new Set();
  try { allowed.add(new URL(req.url).origin); } catch { /* ignore */ }
  for (const v of [env.URL, env.DEPLOY_PRIME_URL, env.DEPLOY_URL, ...(env.ALLOWED_ORIGINS || '').split(',')]) {
    if (!v || !v.trim()) continue;
    try { allowed.add(new URL(v.trim()).origin); } catch { /* ignore bad entries */ }
  }
  if (allowed.has(origin)) return true;
  const u = new URL(origin);
  return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
}

/** Reads the body as text, refusing anything over maxBytes without buffering it all. */
export async function readBody(req, maxBytes) {
  const declared = Number(req.headers.get('content-length'));
  if (declared > maxBytes) return { tooLarge: true };
  if (!req.body) return { text: '' };
  const reader = req.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); return { tooLarge: true }; }
    parts.push(value);
  }
  return { text: Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf8') };
}

/** Validates method, origin, content type and size, then parses JSON. Returns {data} or {response}. */
export async function readJsonRequest(req, env, maxBytes) {
  if (req.method !== 'POST') return { response: fail(405, 'method_not_allowed', 'Use POST.', { Allow: 'POST' }) };
  if (!originAllowed(req, env)) return { response: fail(403, 'forbidden_origin', 'This API only accepts requests from the Muster Roll site.') };
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) return { response: fail(415, 'unsupported_media_type', 'Send JSON.') };
  const { text, tooLarge } = await readBody(req, maxBytes);
  if (tooLarge) return { response: fail(413, 'too_large', 'The request is too large.') };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return { data };
  } catch {
    return { response: fail(400, 'bad_json', 'The request body is not valid JSON.') };
  }
}

/** Client IP as Netlify reports it. Only ever used as input to a keyed hash. */
export const clientIp = (req, context) => (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';

const dayOf = now => new Date(now).toISOString().slice(0, 10);
const secsToMidnight = now => Math.max(1, Math.ceil((Date.parse(dayOf(now) + 'T00:00:00Z') + 86400000 - now) / 1000));

/**
 * Sliding-window rate limit per visitor plus a daily cap for the whole site, stored as ONE
 * blob per scope: { day, salt, total, visitors: { <hash>: [timestamps] } }.
 *
 * Privacy: the IP is never stored. The key is HMAC-SHA256(daily random salt, IP). On the
 * first request of a new UTC day the whole blob, salt included, is overwritten, so a hash
 * can never be linked to an IP or to the previous day, and nothing is kept past 24 hours.
 * Writes use the blob ETag (compare-and-swap) so concurrent requests cannot lose counts.
 */
export async function rateLimit(store, { scope, ip, now = Date.now(), perVisitor, windowMs, dailyCap }) {
  const key = 'rate-' + scope;
  for (let attempt = 0; attempt < 5; attempt++) {
    const found = await store.getWithMetadata(key, { type: 'json' });
    const today = dayOf(now);
    let doc = found && found.data;
    if (!doc || doc.day !== today || typeof doc.salt !== 'string') doc = { day: today, salt: randomBytes(16).toString('hex'), total: 0, visitors: {} };
    const visitor = createHmac('sha256', doc.salt).update(String(ip)).digest('hex').slice(0, 32);
    for (const [h, list] of Object.entries(doc.visitors)) { // drop timestamps outside the window
      const keep = list.filter(t => now - t < windowMs);
      if (keep.length) doc.visitors[h] = keep; else delete doc.visitors[h];
    }
    const mine = doc.visitors[visitor] || [];
    if (doc.total >= dailyCap) return { ok: false, reason: 'daily', retryAfter: secsToMidnight(now) };
    if (mine.length >= perVisitor) return { ok: false, reason: 'visitor', retryAfter: Math.max(1, Math.ceil((mine[0] + windowMs - now) / 1000)) };
    doc.visitors[visitor] = mine.concat(now);
    doc.total += 1;
    // The local `netlify dev` Blobs sandbox returns no ETag on reads; there a plain write is used.
    const res = !found ? await store.setJSON(key, doc, { onlyIfNew: true })
      : found.etag ? await store.setJSON(key, doc, { onlyIfMatch: found.etag })
        : await store.setJSON(key, doc);
    if (res && res.modified !== false) return { ok: true, remaining: perVisitor - doc.visitors[visitor].length };
  }
  return { ok: false, reason: 'busy', retryAfter: 2 };
}

export const rateLimitedResponse = r => fail(429, 'rate_limited',
  r.reason === 'daily' ? 'The chat has reached its daily limit. Please try again tomorrow.'
    : r.reason === 'busy' ? 'The server is busy. Please try again in a moment.'
      : 'Too many requests. Please wait a little before asking again.',
  { 'Retry-After': String(r.retryAfter) });

export const intEnv = (v, def, min = 1, max = 1e6) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : def; };

/** Deletes rate-limit blobs that belong to an earlier UTC day. Returns how many were removed. */
export async function purgeStaleRateLimits(store, scopes, now = Date.now()) {
  let removed = 0;
  for (const scope of scopes) {
    const doc = await store.get('rate-' + scope, { type: 'json' });
    if (doc && doc.day !== dayOf(now)) { await store.delete('rate-' + scope); removed++; }
  }
  return removed;
}
