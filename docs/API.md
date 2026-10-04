# API layer

`server/api.mjs` sits between the browser and the Gemini API (`@google/genai`). It holds the key, rate-limits callers, validates input, plans the output-token budget, normalizes Gemini's stream into the app's own events, and maps upstream failures to user-readable errors. The same handler runs inside `server.ts` (local, Google AI Studio, Cloud Run) and as Vercel functions (`api/chat.mjs`, `api/models.mjs`, `api/health.mjs`). All routes are public — there is no sign-in.

## Routes

### `GET /api/health`
`{ status: "ok" | "missing_key" | "auth_failed" | "unreachable", message, deployment }` — a real `models.get` call for the default model, cached 60 s (`?fresh` bypasses the cache at most once per 5 s). `auth_failed` means Google rejected the server's key (Gemini reports a bad key as `400 API key not valid`). `deployment` is the Cloud Run revision, the last 8 chars of the Vercel deployment id, or `local`.

### `GET /api/models`
```json
{ "defaultModel": "…", "models": [{ "id", "label", "vendor", "description", "reasoning", "maxOutput", "contextWindow" }],
  "limits": { "outputCap": 50000, "streamSeconds": 285, "rateLimitScope": "global" } }
```
`maxOutput` is what this deployment allows for the model: `min(MAX_OUTPUT_TOKENS, model output limit)`. `rateLimitScope` is `per-instance` when no database is configured.

### `POST /api/chat`
```json
{ "model": "gemini-3.8-flash", "messages": [{ "role": "user", "content": "…" }],
  "system": "optional, ≤ 8000 chars", "temperature": 0.6, "topP": 0.95, "maxTokens": 50000, "thinking": true }
```
Validation failures return `{ error: { message, code } }` before streaming. Limits: 200 messages, 600k chars, 2 MB body; the last message must be a non-empty user turn.

On success: `text/event-stream`, one JSON object per `data:` frame:

| Event | Payload |
|---|---|
| `start` | `{ model, maxTokens, limitSeconds }` — `maxTokens` is what was actually sent (may be below the request) |
| `reasoning` | `{ text }` — thought-summary delta (Gemini parts with `thought: true`; requested with `includeThoughts`) |
| `content` | `{ text }` — answer delta |
| `usage` | `{ usage: { prompt, completion, reasoning } }` — `completion` = answer + thinking tokens |
| `done` | `{ finishReason }` — `STOP` → `"stop"`, `MAX_TOKENS` → `"length"`, others lowercased. A safety/recitation stop also sends an `error` with code `blocked` |
| `error` | `{ message, code }` — mid-stream failure; the stream then ends |

**Request mapping**: `assistant` → Gemini role `model` (empty turns dropped), `system` → `systemInstruction`, `temperature`/`topP` clamped, `maxOutputTokens` planned as below, `thinkingConfig.includeThoughts: true`. For `reasoning: "toggle"` models the `thinking` flag sends the model's `thinkingOn`/`thinkingOff` level (`medium`/`minimal`); `"always"` models send no level (their lowest level, `minimal`, is rejected).

**Output tokens** (`server/tokens.mjs`): the requested value is clamped to `[256, min(50 000, model.maxOutput)]` and to the context left after the prompt (estimated at 3 chars/token + 256 margin). One recoverable `400` is retried once: an output ceiling in the error message ("supported range is from 1 (inclusive) to N (exclusive)") lowers `maxOutputTokens`; an error mentioning thinking drops `thinkingLevel`.

**Timing**: Gemini may take up to `UPSTREAM_QUEUE_TIMEOUT_SECONDS` (default 120, capped 30 s below the stream limit) to start before a 504 `upstream_timeout`; 60 s of mid-stream silence → `idle_timeout`; at the stream limit the stream is ended cleanly with `max_duration` (the UI shows "Paused at the time limit" + Continue). On Cloud Run (`K_SERVICE`) and Vercel the stream limit is `FUNCTION_MAX_DURATION` (300 = Cloud Run's default request timeout and `vercel.json` maxDuration) − 15 s = **285 s**; locally 10 minutes.

**Cancellation**: when the client disconnects (Stop, closed tab) the SDK request is aborted (`abortSignal`) so Gemini stops generating. On Vercel this requires `supportsCancellation: true` on the function.

### Error codes
`forbidden_origin` 403 · `not_found` 404 · `method_not_allowed` 405 · `unsupported_media_type` 415 · `missing_key` 503 · `invalid_json` / `invalid_request` / `invalid_model` 400 · `too_large` / `too_long` 413 · `rate_limited` / `too_many_streams` 429 (with `Retry-After`) · `auth_failed` / `model_unavailable` / `upstream_error` / `upstream_unreachable` 502 · `upstream_busy` 503 (Gemini "high demand") · `upstream_timeout` 504 · in-stream: `idle_timeout`, `max_duration`, `blocked`, `upstream_error` (Gemini failed mid-stream — the SDK drops its error event, so a stream that ends without a finish reason is reported as this). Unexpected failures return 500 `server_error` with a generic message; details go to the function log only. Unknown `/api/*` paths on Vercel get the platform's 404.

## Rate limiting (`server/limits.mjs`)

Applied to `POST /api/chat` **before the body is read** (invalid requests count too), keyed by client IP:

| Limit | Default | Env |
|---|---|---|
| Per IP per minute | 6 | `RATE_LIMIT_CHAT_PER_MIN` |
| Per IP per day | 120 | `RATE_LIMIT_CHAT_PER_DAY` |
| Whole demo per day | 1,500 | `RATE_LIMIT_GLOBAL_PER_DAY` |
| Concurrent responses per IP | 2 | `MAX_CONCURRENT_STREAMS` |

Storage: with `DATABASE_URL`/`POSTGRES_URL`, counters live in the `hivemind_limits` table (created on first use; Neon serverless driver over HTTP) and are **global across instances** (Cloud Run, Vercel). Without it — or if the database errors — limits fall back to per-process memory (logged as `[limits] database unavailable`). Windows are fixed (count + expiry per key). Each concurrency slot is its own row holding a 30 s lease, renewed every 10 s while the response streams and deleted when it ends. A request that is cancelled or frozen can't run that cleanup (observed on Vercel), so its slot simply expires within 30 s.

Client IP: on Vercel (`VERCEL=1`) from `x-real-ip` / `x-forwarded-for`, which Vercel sets itself — verified that spoofed values don't change the identity. On Cloud Run (`K_SERVICE`) the **last** `x-forwarded-for` entry, which Google's front end appends (not yet verified against a live deployment). Elsewhere the socket address is used and forwarding headers are ignored.

## Security model

| Concern | Mechanism |
|---|---|
| Access | Public by design. Anyone with the URL can chat; limits bound the cost. |
| Secrets | `GEMINI_API_KEY` and the database URL are read only in `server/` (AI Studio Secrets, or Cloud Run / Vercel env vars). Never sent to the browser. |
| Quota abuse | Per-IP minute/day windows, a global daily cap and per-IP concurrency, enforced globally via Postgres. |
| Cross-site use | Non-GET requests need a same-origin `Origin` (or none) and a JSON body (`415` otherwise); no CORS headers are sent, so other sites' scripts can't call the API. |
| Input | Body ≤ 2 MB, ≤ 200 messages / 600k chars, system prompt ≤ 8k, numeric params clamped, model must be in the allowlist. |
| Logs | `METHOD /path status duration client=<hash>` — no headers, bodies, query strings, keys or raw IPs. |
| Browser hardening | `server/securityHeaders.mjs` (sent by `npm start` and `vercel.json`): CSP `default-src 'self'` (scripts `'self'` only; `style-src 'unsafe-inline'` is needed by KaTeX), `frame-ancestors 'self' https://aistudio.google.com` (AI Studio shows the app in an iframe, so no `X-Frame-Options`), `nosniff`, `Referrer-Policy: no-referrer`, COOP, Permissions-Policy. |
| Untrusted model output | No raw HTML rendering, default URL sanitizing (no `javascript:`), KaTeX `trust:false` + `maxExpand`, highlighting via element trees (no `innerHTML`). |

Tests: `server/api.test.mjs`.

## Models

`server/models.mjs` lists free-tier models only (the key AI Studio injects may not have billing): Gemini 3.8 Flash (default), 3.5 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite — each 1,048,576 input / 65,536 output tokens per the model pages (2026-10). `gemini-3.1-pro-preview` is paid-only.

## Adding a model

1. Check the model page on ai.google.dev for its input/output limits, thinking levels and free-tier availability.
2. Add it to `MODELS` with `reasoning` (`"toggle"` + `thinkingOn`/`thinkingOff` if it accepts `minimal`, else `"always"`), `maxOutput` and `contextWindow`.
3. Verify with a real request:
   ```bash
   curl -s http://localhost:3000/api/chat -H "Content-Type: application/json" \
     -d '{"model":"<id>","messages":[{"role":"user","content":"Say hi."}],"thinking":false,"maxTokens":1000}'
   ```
