# API layer

`server/api.mjs` sits between the browser and the model providers. It holds the keys, rate-limits callers, validates input, plans the output-token budget, and maps upstream failures to user-readable errors. Provider adapters in `server/providers/` translate the request and normalize each provider's stream into the app's own events: `gemini.mjs` (Gemini API via `@google/genai`) and `openrouter.mjs` (OpenRouter's OpenAI-compatible API). Each throws `UpstreamError { status, detail }` for provider failures. The same handler runs inside `server.ts` (local, Google AI Studio, Cloud Run) and as Vercel functions (`api/chat.mjs`, `api/models.mjs`, `api/health.mjs`). All routes are public — there is no sign-in.

## Routes

### `GET /api/health`
`{ status: "ok" | "missing_key" | "auth_failed" | "unreachable", message, providers: { gemini?, openrouter? }, deployment }` — checks every provider that has a key (Gemini: `models.get`; OpenRouter: `GET /key`, which spends no quota), cached 60 s (`?fresh` bypasses the cache at most once per 5 s). `status` is the worst provider's. `auth_failed` means a provider rejected its key (Gemini reports a bad key as `400 API key not valid`, OpenRouter as `401`). `deployment` is the Cloud Run revision, the last 8 chars of the Vercel deployment id, or `local`.

### `GET /api/models`
```json
{ "defaultModel": "…", "models": [{ "id", "label", "vendor", "provider", "description", "reasoning", "maxOutput", "contextWindow" }],
  "limits": { "outputCap": 50000, "streamSeconds": 285, "rateLimitScope": "global" } }
```
Only models whose provider has a key are listed (all of them when no key is set). `provider` is the display name (`"Gemini API"`, `"OpenRouter"`). `maxOutput` is what this deployment allows for the model: `min(MAX_OUTPUT_TOKENS, model output limit)`. `rateLimitScope` is `per-instance` when no database is configured.

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
| `reasoning` | `{ text }` — reasoning delta (Gemini: thought-summary parts, `thought: true`; OpenRouter: `delta.reasoning`) |
| `content` | `{ text }` — answer delta |
| `usage` | `{ usage: { prompt, completion, reasoning } }` — `completion` = answer + thinking tokens |
| `done` | `{ finishReason }` — `"stop"`, `"length"` (Gemini `STOP`/`MAX_TOKENS` are mapped), others as sent. A Gemini safety/recitation stop also sends an `error` with code `blocked` |
| `error` | `{ message, code }` — mid-stream failure; the stream then ends |

**Request mapping**
- Gemini: `assistant` → role `model` (empty turns dropped), `system` → `systemInstruction`, `temperature`/`topP` clamped, `maxOutputTokens` planned as below, `thinkingConfig.includeThoughts: true`. For `reasoning: "toggle"` models the `thinking` flag sends the model's `thinkingOn`/`thinkingOff` level (`medium`/`minimal`); `"always"` models send no level (their lowest level, `minimal`, is rejected).
- OpenRouter: OpenAI chat format (`system` first), `max_tokens`, `stream: true`, `X-Title: HiveMind`. Keys: `OPENROUTER_API_KEY`, then `OPENROUTER_API_KEY_BACKUP`, then `OPENROUTER_DEEPSEEK_API_KEY` (a model's `keyEnv` goes first: the DeepSeek models start with the DeepSeek key). A key-specific failure (401, 402, a key/disabled 403, a 429 that isn't "rate-limited upstream") retries the request with the next key and benches the failed key (tried last) for 5 minutes. Health checks every key with `GET /key` and stays `ok` while any works, naming rejected keys in `message`. Thinking off on a `"toggle"` model sends `reasoning: { enabled: false }` (verified to remove reasoning on DeepSeek V4.1 Flash/V4 Pro, Nemotron 3 Super/Ultra and Qwen 3.8; it garbled North Mini Code's answer, so that model is `"always"`). `: OPENROUTER PROCESSING` comment lines keep the idle timer alive; a `{ error }` chunk or `finish_reason: "error"` ends the stream with an error.

**Output tokens** (`server/tokens.mjs`): the requested value is clamped to `[256, min(50 000, model.maxOutput)]` and to the context left after the prompt (estimated at 3 chars/token + 256 margin). Gemini only: one recoverable `400` is retried once: an output ceiling in the error message ("supported range is from 1 (inclusive) to N (exclusive)") lowers `maxOutputTokens`; an error mentioning thinking drops `thinkingLevel`.

**Timing**: a provider may take up to `UPSTREAM_QUEUE_TIMEOUT_SECONDS` (default 120, capped 30 s below the stream limit) to start before a 504 `upstream_timeout`; 60 s of mid-stream silence → `idle_timeout`; at the stream limit the stream is ended cleanly with `max_duration` (the UI shows "Paused at the time limit" + Continue). On Cloud Run (`K_SERVICE`) and Vercel the stream limit is `FUNCTION_MAX_DURATION` (300 = Cloud Run's default request timeout and `vercel.json` maxDuration) − 15 s = **285 s**; locally 10 minutes.

**Cancellation**: when the client disconnects (Stop, closed tab) the upstream request is aborted so the provider stops generating. On Vercel this requires `supportsCancellation: true` on the function.

### Error codes
`forbidden_origin` 403 · `not_found` 404 · `method_not_allowed` 405 · `unsupported_media_type` 415 · `missing_key` 503 · `invalid_json` / `invalid_request` / `invalid_model` 400 · `too_large` / `too_long` 413 · `rate_limited` / `too_many_streams` 429 (with `Retry-After`) · `auth_failed` / `model_unavailable` / `upstream_error` / `upstream_unreachable` 502 · `payment_required` 402 (OpenRouter needs credits) · `upstream_busy` 503 ("high demand") · `upstream_timeout` 504 · in-stream: `idle_timeout`, `max_duration`, `blocked`, `upstream_error` (the provider failed mid-stream; Gemini's SDK drops the error event, so any stream that ends without a finish reason is reported as this). Unexpected failures return 500 `server_error` with a generic message; details go to the function log only. Unknown `/api/*` paths on Vercel get the platform's 404.

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
| Secrets | `GEMINI_API_KEY`, the `OPENROUTER_*` keys and the database URL are read only in `server/` (AI Studio Secrets, or Cloud Run / Vercel env vars). Never sent to the browser. |
| Quota abuse | Per-IP minute/day windows, a global daily cap and per-IP concurrency, enforced globally via Postgres. |
| Cross-site use | Non-GET requests need a same-origin `Origin` (or none) and a JSON body (`415` otherwise); no CORS headers are sent, so other sites' scripts can't call the API. |
| Input | Body ≤ 2 MB, ≤ 200 messages / 600k chars, system prompt ≤ 8k, numeric params clamped, model must be in the allowlist. |
| Logs | `METHOD /path status duration client=<hash>` — no headers, bodies, query strings, keys or raw IPs. |
| Browser hardening | `server/securityHeaders.mjs` (sent by `npm start` and `vercel.json`): CSP `default-src 'self'` (scripts `'self'` only; `style-src 'unsafe-inline'` is needed by KaTeX), `frame-ancestors 'self' https://aistudio.google.com` (AI Studio shows the app in an iframe, so no `X-Frame-Options`), `nosniff`, `Referrer-Policy: no-referrer`, COOP, Permissions-Policy. |
| Untrusted model output | No raw HTML rendering, default URL sanitizing (no `javascript:`), KaTeX `trust:false` + `maxExpand`, highlighting via element trees (no `innerHTML`). |

Tests: `server/api.test.mjs`.

## Models

`server/models.mjs` lists free models only:
- **Gemini** (free tier; the key AI Studio injects may not have billing): Gemini 3.8 Flash (default), 3.5 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite — each 1,048,576 input / 65,536 output tokens per the model pages (2026-10). `gemini-3.1-pro-preview` is paid-only.
- **OpenRouter** (a key without credits gets 50 free-model requests/day per account, 1,000/day after buying $10 of credit): DeepSeek V4.1 Flash, DeepSeek V4 Pro, Nemotron 3 Super, Nemotron 3 Ultra, Qwen 3.8 27B, North Mini Code. The DeepSeek models aren't `:free`, but on 2026-10-04 requests from the $0-credit account cost $0 and counted against the free daily limit; if OpenRouter starts charging they fail with 402 `payment_required` — limits from `/api/v1/models` (`context_length`, `top_provider.max_completion_tokens`), each verified with real requests on 2026-10-04. Rejected: `thinkingmachines/inkling:free` (403 "only available on agentic harnesses"); `google/gemma-4-31b-it:free` was rate-limited upstream when probed.

## Adding a model

1. Gemini: check the model page on ai.google.dev for its input/output limits, thinking levels and free-tier availability. OpenRouter: read `context_length`, `top_provider.max_completion_tokens` and `supported_parameters` from `GET https://openrouter.ai/api/v1/models`.
2. Add it to `MODELS` with `provider`, `reasoning` (Gemini `"toggle"` needs `thinkingOn`/`thinkingOff`; OpenRouter `"toggle"` only if `reasoning: { enabled: false }` really removes reasoning), `maxOutput` and `contextWindow`.
3. Verify with a real request:
   ```bash
   curl -s http://localhost:3000/api/chat -H "Content-Type: application/json" \
     -d '{"model":"<id>","messages":[{"role":"user","content":"Say hi."}],"thinking":false,"maxTokens":1000}'
   ```
