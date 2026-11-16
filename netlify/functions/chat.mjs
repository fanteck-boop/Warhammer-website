// POST /api/chat: a narrow proxy from the Muster Roll chat widget to Groq.
// The Groq key lives only in the GROQ_API_KEY environment variable. This function is
// deliberately NOT a general proxy: model, token limit and sampling are pinned here,
// messages and tools are rebuilt from an allowlist, and every visitor is rate limited.
import { getStore } from '@netlify/blobs';
import { fail, json, readJsonRequest, rateLimit, rateLimitedResponse, clientIp, intEnv } from './_lib/guard.mjs';
import { TOOL_SCHEMAS } from './_lib/tool-schemas.mjs';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const PINNED = Object.freeze({
  model: 'qwen/qwen3.8-27b',
  max_completion_tokens: 500,
  temperature: 0.4,
  reasoning_effort: 'none',
  reasoning_format: 'hidden'
});
export const LIMITS = Object.freeze({
  bodyBytes: 30 * 1024,
  messages: 24,
  contentChars: 12000,
  toolCallsPerMessage: 3,
  argumentChars: 2000,
  idChars: 64
});
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const UPSTREAM_TIMEOUT_MS = 9000; // Netlify ends synchronous functions after 10 s

const bad = message => ({ error: message });
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/** Rebuilds the request from an allowlist. Returns {payload} or {error}. Unknown fields are dropped. */
export function sanitizeChatRequest(body) {
  const { messages, tools, tool_choice: toolChoice } = body;
  if (!Array.isArray(messages) || !messages.length) return bad('messages must be a non-empty array');
  if (messages.length > LIMITS.messages) return bad('too many messages');
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || !ROLES.has(m.role)) return bad('unsupported message role');
    if (m.role === 'system' && i !== 0) return bad('only the first message may be a system message');
    const content = m.content == null ? '' : m.content;
    if (!isStr(content, LIMITS.contentChars)) return bad('message content must be a string');
    const clean = { role: m.role, content };
    if (m.role === 'tool') {
      if (!isStr(m.tool_call_id, LIMITS.idChars) || !m.tool_call_id) return bad('tool messages need a tool_call_id');
      clean.tool_call_id = m.tool_call_id;
    }
    if (m.role === 'assistant' && m.tool_calls != null) {
      if (!Array.isArray(m.tool_calls) || !m.tool_calls.length || m.tool_calls.length > LIMITS.toolCallsPerMessage) return bad('invalid tool_calls');
      clean.tool_calls = [];
      for (const c of m.tool_calls) {
        const fn = c && c.function;
        if (!fn || !Object.hasOwn(TOOL_SCHEMAS, fn.name)) return bad('unknown tool in tool_calls');
        if (!isStr(c.id, LIMITS.idChars) || !c.id || !isStr(fn.arguments == null ? '' : fn.arguments, LIMITS.argumentChars)) return bad('invalid tool call');
        clean.tool_calls.push({ id: c.id, type: 'function', function: { name: fn.name, arguments: fn.arguments == null ? '' : fn.arguments } });
      }
    }
    out.push(clean);
  }
  if (out[out.length - 1].role === 'assistant' && !out[out.length - 1].tool_calls) return bad('the last message cannot be an assistant reply');
  const payload = { ...PINNED, messages: out };
  if (tools != null) {
    if (!Array.isArray(tools) || tools.length > Object.keys(TOOL_SCHEMAS).length) return bad('invalid tools');
    const names = [];
    for (const t of tools) {
      const name = t && (t.function ? t.function.name : t.name);
      if (!Object.hasOwn(TOOL_SCHEMAS, name)) return bad('unknown tool');
      if (!names.includes(name)) names.push(name);
    }
    if (names.length) {
      payload.tools = names.map(n => TOOL_SCHEMAS[n]); // server copy, never the client's definition
      if (toolChoice != null && toolChoice !== 'auto' && toolChoice !== 'none') return bad('tool_choice must be auto or none');
      payload.tool_choice = toolChoice || 'auto';
    }
  }
  return { payload };
}

/** Only the fields the widget uses go back to the browser. */
function shapeReply(data) {
  const ch = (data && Array.isArray(data.choices) && data.choices[0]) || {};
  const msg = ch.message || {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(c => c && c.function && Object.hasOwn(TOOL_SCHEMAS, c.function.name)).slice(0, LIMITS.toolCallsPerMessage)
    .map(c => ({ id: String(c.id || '').slice(0, LIMITS.idChars), type: 'function', function: { name: c.function.name, arguments: String(c.function.arguments || '').slice(0, LIMITS.argumentChars) } })) : [];
  const message = { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' };
  if (calls.length) message.tool_calls = calls;
  const usage = data && data.usage ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens } : undefined;
  return { choices: [{ message, finish_reason: typeof ch.finish_reason === 'string' ? ch.finish_reason : null }], usage };
}

/**
 * Factory so tests can inject fakes. deps: { env, fetch, store, log }.
 * store: a Netlify Blobs store (or an in-memory stand-in with getWithMetadata/setJSON).
 */
export function createChatHandler(deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetch || ((...a) => fetch(...a));
  const log = deps.log || console;
  const openStore = () => deps.store || getStore({ name: 'rate-limits', consistency: 'strong' });

  return async function chatHandler(req, context) {
    const parsed = await readJsonRequest(req, env, LIMITS.bodyBytes);
    if (parsed.response) return parsed.response;
    const key = env.GROQ_API_KEY;
    if (!key) return fail(503, 'not_configured', 'The AI chat is not set up on this server yet (GROQ_API_KEY is missing).');

    const checked = sanitizeChatRequest(parsed.data);
    if (checked.error) return fail(400, 'bad_request', 'Invalid chat request: ' + checked.error + '.');

    let rl;
    try {
      rl = await rateLimit(openStore(), {
        scope: 'chat', ip: clientIp(req, context),
        perVisitor: intEnv(env.CHAT_RATE_LIMIT, 60), windowMs: intEnv(env.CHAT_RATE_WINDOW_MIN, 10, 1, 1440) * 60000,
        dailyCap: intEnv(env.CHAT_DAILY_CAP, 1000)
      });
    } catch (e) {
      log.error('chat: rate limiter unavailable', e && e.name); // never the request or the key
      return fail(503, 'rate_limiter_unavailable', 'The chat is temporarily unavailable. Please try again later.');
    }
    if (!rl.ok) return rateLimitedResponse(rl);

    let upstream;
    try {
      upstream = await doFetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(checked.payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (e) {
      log.warn('chat: upstream unreachable', e && e.name);
      return fail(502, 'upstream_unreachable', 'The AI service could not be reached. Please try again.');
    }
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      // Log the status and Groq's error code only. Never the body: it can contain account details.
      const code = data && data.error && typeof data.error.code === 'string' ? data.error.code.slice(0, 40) : '';
      log.warn('chat: upstream error', upstream.status, code);
      if (upstream.status === 429) {
        const ra = Math.min(3600, Math.max(1, Math.ceil(Number(upstream.headers.get('retry-after')) || 30)));
        return fail(429, 'upstream_rate_limited', 'The AI service is busy (free tier limit). Please try again shortly.', { 'Retry-After': String(ra) });
      }
      if (upstream.status === 400 && /tool/i.test(code)) return fail(400, 'tool_error', 'The model produced an invalid tool call.');
      return fail(502, 'upstream_error', 'The AI service could not answer right now. Please try again later.');
    }
    return json(200, shapeReply(data), { 'X-RateLimit-Remaining': String(rl.remaining) });
  };
}

export default createChatHandler();

export const config = { path: '/api/chat' };
