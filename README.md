# Muster Roll

A static army builder for Warhammer Age of Sigmar, Warhammer 40,000 and the Middle-earth
Strategy Battle Game, hosted on Netlify. The site itself has no build step; two small
Netlify Functions power the AI rules chat.

## AI chat architecture

```
 browser (muster-chat.js)                          Netlify Functions                     external
 ------------------------                          -----------------                     --------
 question + army summary  --POST /api/chat-->  chat.mjs                                Groq API
   tool loop:                                    origin check, 30 KB cap,       --->   (key from
   find_units / get_unit  (run in the browser     allowlisted roles + tools,             GROQ_API_KEY)
                           over the loaded data)  pinned model and limits,
   search_rules  ----------POST /api/rules--> rules.mjs                                (no LLM)
                                                 hybrid search over the
                                                 official core rules index
                         <-- cited passages ----  (BM25 + MiniLM, RRF)
 rate limits for both: Netlify Blobs, hashed IP + daily salt
```

Visitors need no API key. The Groq key exists only as the `GROQ_API_KEY` environment
variable of the function; the browser never sees it.

### Security measures

- **Not an open proxy.** `/api/chat` accepts only POST with JSON from the site's own origin
  (or localhost), at most 30 KB and 24 messages. Roles are limited to
  system/user/assistant/tool, a system message may only come first, and every message is
  rebuilt field by field, so unknown fields are dropped.
- **Pinned on the server:** model, `max_completion_tokens` (500), temperature and
  `reasoning_effort`. Client values are ignored.
- **Tools by name only.** The browser can name `find_units`, `get_unit` and
  `search_rules`; the server swaps in its own tool definitions, so a client cannot inject
  tool descriptions or extra tools.
- **Rate limits** (Netlify Blobs): 60 chat requests per visitor per 10 minutes and 1000 per
  day for the whole site, configurable with env vars (see `.env.example`); `/api/rules` allows 120 per visitor per 10 minutes. Over the limit
  you get 429 with `Retry-After`. Visitors are keyed by HMAC-SHA256(IP, random daily salt);
  raw IPs are never stored, the blob is replaced on the first request of each UTC day and a
  scheduled function deletes stale ones at midnight, so nothing is kept past 24 hours.
- **No leaks.** Request bodies and the key are never logged. Errors returned to the browser
  are fixed messages; Groq's error text (which can name the account) is never echoed.
- The origin check stops other websites from using the API in a visitor's browser. It is
  not authentication (a script can fake the header), which is why the rate limits exist.
- `_headers` CSP: `connect-src` no longer allows `api.groq.com`; all calls are same-origin.

### Rules RAG pipeline

1. **Sources:** the official free PDFs from warhammer-community.com, listed in
   `rules/sources.json` (40k Core Rules and Universal Rules Updates, AoS Core Rules and the
   core section of the Rules Updates, MESBG Battlehost Quickstart Rules and Rules Manual
   FAQ). The full MESBG Rules Manual is a paid book and is not indexed. PDFs live in
   `rules-src/` and are never committed.
2. **Build** (`tools/build-rules-index.mjs`): text per page with `unpdf`, running headers,
   footers, page numbers and "see also" sidebars removed, broken glyphs from some fonts
   repaired, then chunked per section heading (font size and AoS rule numbers give the
   hierarchy) to at most 600 tokens with a small overlap. Each chunk keeps game, source,
   section path and printed page. The MESBG guide uses inline ALL-CAPS run-in headings ("DUEL ROLL ...");
   those are split into their own chunks, and a few carry search hints (plain words like "who strikes first")
   that are indexed but never shown to the model.
3. **Embeddings:** `Xenova/all-MiniLM-L6-v2` (8-bit) via `@huggingface/transformers`,
   run locally. Long chunks are embedded in windows and averaged. Vectors are stored as
   int8 in `netlify/functions/_data/rules-index.json` (553 chunks, 759 KB, 353 KB gzipped).
4. **Search** (`netlify/functions/_lib/rules-search.mjs`): BM25 (own implementation) and
   cosine similarity, fused with Reciprocal Rank Fusion, filtered by game. The top 3
   passages are trimmed to the sentences that best match the query (about 2000 characters
   in total) and returned with source, section and page. The model is told to answer rules
   questions only from these passages, cite them as "(40k Core Rules, section, p.N)", and
   say so when they do not cover the question.
5. On a cold start the embedding model loads in the background; until it is ready
   (at most 2.5 s per request) the search falls back to BM25 instead of making the visitor wait.

**Why a separate `/api/rules` instead of running the tool inside `/api/chat`:** the tool
loop already lives in the browser (the unit tools need the army data loaded there), so a
second endpoint keeps one loop. The chat function stays a small, easily audited proxy
with no ML dependencies, and only the rules function carries the ONNX runtime. Security is
the same: the browser could already send any text as a tool result, so moving the call
does not add trust.

### Retrieval eval

`node tools/eval-rules.mjs` asks about 20 questions per game (for example "how does cover
work", "can I charge after advancing", "how do objectives get controlled") and checks
whether a chunk from the section that answers it is ranked first (hit@1) or in the top 4
(hit@4). No LLM is involved.

| game  | BM25 hit@1 | BM25 hit@4 | embeddings hit@1 | embeddings hit@4 | hybrid hit@1 | hybrid hit@4 |
|-------|-----------:|-----------:|-----------------:|-----------------:|-------------:|-------------:|
| 40k (21 q)   | 76.2 | 100  | 81.0 | 100  | 95.2 | 100  |
| AoS (22 q)   | 86.4 | 100  | 77.3 | 90.9 | 86.4 | 100  |
| MESBG (24 q) |       79.2 |      100   |             83.3 |             95.8 |         83.3 |        100   |

Notes: the BM25 weight (2:1 in the fusion) was tuned on this same question set, so the
hybrid numbers are optimistic. Merging small sections into bigger chunks (about 250 to 350
tokens on average) cut hybrid hit@4 to 77 to 82%, because merged chunks lose their own
section label, so chunks follow the document's sections (average 150 to 270 tokens). The
MESBG quickstart has few, broad sections, which makes that eval easier.

### Run locally

```sh
npm install
cp .env.example .env              # then put your Groq key in GROQ_API_KEY
npx netlify dev                   # site + functions on http://localhost:8888
npm test                          # handler, rate-limit and widget tests (no network)
```

To rebuild the rules index, download the PDFs listed in `rules/sources.json` into
`rules-src/` (see `rules-src/README.md`), then:

```sh
node tools/build-rules-index.mjs
node tools/eval-rules.mjs
```

Opening the site with a plain static server (for example `python -m http.server`) works
for the army builder, but the chat then shows "Chat needs the server: run `netlify dev`".

### Deploy

Set `GROQ_API_KEY` under Site configuration > Environment variables in Netlify (optionally
the limits from `.env.example`). Netlify installs the dependencies and bundles the
functions; the rules function is about 30 MB zipped, under the 50 MB limit.
