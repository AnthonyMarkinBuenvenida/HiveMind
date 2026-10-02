# API layer

`server/api.mjs` sits between the browser and NVIDIA NIM. It holds the key, rate-limits callers, validates input, plans the output-token budget, normalizes NIM's stream, and maps upstream failures to user-readable errors. The same handler runs as Vercel functions (`api/chat.mjs`, `api/models.mjs`, `api/health.mjs`) and as Vite middleware locally. All routes are public — there is no sign-in.

## Routes

### `GET /api/health`
`{ status: "ok" | "missing_key" | "auth_failed" | "unreachable", message, deployment }` — a real `GET /v1/models` call to NIM, cached 60 s (`?fresh` bypasses the cache at most once per 5 s). `auth_failed` means NVIDIA rejected the server's key. `deployment` is the last 8 chars of the Vercel deployment id (or `local`).

### `GET /api/models`
```json
{ "defaultModel": "…", "models": [{ "id", "label", "vendor", "description", "reasoning", "maxOutput", "contextWindow" }],
  "limits": { "outputCap": 50000, "streamSeconds": 285, "rateLimitScope": "global" } }
```
`maxOutput` is what this deployment allows for the model: `min(MAX_OUTPUT_TOKENS, verified NVIDIA maximum)`. `rateLimitScope` is `per-instance` when no database is configured.

### `POST /api/chat`
```json
{ "model": "nvidia/nemotron-3-super-120b-a12b", "messages": [{ "role": "user", "content": "…" }],
  "system": "optional, ≤ 8000 chars", "temperature": 0.6, "topP": 0.95, "maxTokens": 50000, "thinking": true }
```
Validation failures return `{ error: { message, code } }` before streaming. Limits: 200 messages, 600k chars, 2 MB body; the last message must be a non-empty user turn.

On success: `text/event-stream`, one JSON object per `data:` frame:

| Event | Payload |
|---|---|
| `start` | `{ model, maxTokens, limitSeconds }` — `maxTokens` is what was actually sent (may be below the request) |
| `reasoning` | `{ text }` — thinking delta (`reasoning_content` or `reasoning` upstream) |
| `content` | `{ text }` — answer delta |
| `usage` | `{ usage: { prompt, completion, reasoning } }` |
| `done` | `{ finishReason }` (`"stop"`, `"length"`, …) |
| `error` | `{ message, code }` — mid-stream failure; the stream then ends |

**Output tokens** (`server/tokens.mjs`): the requested value is clamped to `[256, min(50 000, model.maxOutput)]`; if the model has a `contextWindow`, it is further clamped to the room left after the prompt (estimated at 3 chars/token + 256 margin). If NVIDIA still rejects `max_tokens`, the ceiling in its error message is parsed and the request retried once.

**Timing**: NVIDIA may queue a request up to `UPSTREAM_QUEUE_TIMEOUT_SECONDS` (default 120, capped 30 s below the stream limit) before a 504 `upstream_timeout`; 60 s of mid-stream silence → `idle_timeout`; at the stream limit the stream is ended cleanly with `max_duration` (the UI shows "Paused at the time limit" + Continue). On Vercel the stream limit is `FUNCTION_MAX_DURATION` (300, = `vercel.json` maxDuration) − 15 s = **285 s**. Measured: ~45 tokens/s, so one response yields roughly 12K tokens before the limit; Continue resumes where it stopped.

**Cancellation**: when the client disconnects (Stop, closed tab) the upstream fetch is aborted so NVIDIA stops generating. On Vercel this requires `supportsCancellation: true` on the function — verified: without it a stopped request kept generating for 68 s; with it the function ended within ~1 s of the disconnect.

### Error codes
`forbidden_origin` 403 · `not_found` 404 · `method_not_allowed` 405 · `unsupported_media_type` 415 · `missing_key` 503 · `invalid_json` / `invalid_request` / `invalid_model` 400 · `too_large` / `too_long` 413 · `rate_limited` / `too_many_streams` 429 (with `Retry-After`) · `auth_failed` / `model_unavailable` / `upstream_error` / `upstream_unreachable` 502 · `upstream_timeout` 504 · in-stream: `idle_timeout`, `max_duration`, `stream_interrupted`. Unexpected failures return 500 `server_error` with a generic message; details go to the function log only. Unknown `/api/*` paths on Vercel get the platform's 404.

## Rate limiting (`server/limits.mjs`)

Applied to `POST /api/chat` **before the body is read** (invalid requests count too), keyed by client IP:

| Limit | Default | Env |
|---|---|---|
| Per IP per minute | 6 | `RATE_LIMIT_CHAT_PER_MIN` |
| Per IP per day | 120 | `RATE_LIMIT_CHAT_PER_DAY` |
| Whole demo per day | 1,500 | `RATE_LIMIT_GLOBAL_PER_DAY` |
| Concurrent responses per IP | 2 | `MAX_CONCURRENT_STREAMS` |

Storage: with `DATABASE_URL`/`POSTGRES_URL`, counters live in the `hivemind_limits` table (created on first use; Neon serverless driver over HTTP) and are **global across Vercel instances**. Without it — or if the database errors — limits fall back to per-process memory (logged as `[limits] database unavailable`). Windows are fixed (count + expiry per key). Each concurrency slot is its own row holding a 30 s lease, renewed every 10 s while the response streams and deleted when it ends. A function that is cancelled or frozen can't run that cleanup (observed on Vercel), so its slot simply expires within 30 s.

Client IP: on Vercel (`VERCEL=1`) from `x-real-ip` / `x-forwarded-for`, which Vercel sets itself — verified that spoofed values don't change the identity. Elsewhere the socket address is used and forwarding headers are ignored.

## Security model

| Concern | Mechanism |
|---|---|
| Access | Public by design. Anyone with the URL can chat; limits bound the cost. |
| Secrets | `NVIDIA_API_KEY` and the database URL are read only in `server/` (Vercel Sensitive env vars). Verified absent from the HTML, every JS/CSS chunk, and browser network traffic. |
| Quota abuse | Per-IP minute/day windows, a global daily cap and per-IP concurrency, enforced globally via Postgres. |
| Cross-site use | Non-GET requests need a same-origin `Origin` (or none) and a JSON body (`415` otherwise); no CORS headers are sent, so other sites' scripts can't call the API. |
| Input | Body ≤ 2 MB, ≤ 200 messages / 600k chars, system prompt ≤ 8k, numeric params clamped, model must be in the allowlist. |
| Logs | `METHOD /path status duration client=<hash>` — no headers, bodies, query strings, keys or raw IPs. |
| Browser hardening | `vercel.json` headers: CSP `default-src 'self'` (scripts `'self'` only — verified to block injected inline script; `style-src 'unsafe-inline'` is needed by KaTeX), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, COOP, Permissions-Policy. Vercel adds HSTS. |
| Untrusted model output | No raw HTML rendering, default URL sanitizing (no `javascript:`), KaTeX `trust:false` + `maxExpand`, highlighting via element trees (no `innerHTML`). |

Tests: `server/api.test.mjs`.

## NIM behaviour (observed 2026-10-02)

- Base URL `https://integrate.api.nvidia.com/v1`, `Authorization: Bearer nvapi-…`, OpenAI chat-completions format.
- Bad key → `403 {"detail":"Authorization failed"}`. Unknown model → plain-text `404 page not found`.
- `/v1/models` is **not** a reliable availability list: `moonshotai/kimi-k2.6` returned 404 for the account; `moonshotai/kimi-k3` and `z-ai/glm-5.3` hung > 90 s.
- `max_tokens`: the gateway rejects values above 1,048,576 ("Max tokens must not exceed 1048576"). DeepSeek V4.1 Flash, Nemotron 3 Super and GLM 5.3 Flash accepted 1,000,000. gpt-oss 20B and Llama 3.2 11B have a 131,072-token total context (`max_model_len=max_total_tokens=131072`; "maximum context length is 131072 tokens"). All five accepted 50,000.
- Thinking control is per-model `chat_template_kwargs`: DeepSeek `{ "thinking": false }`, Nemotron `{ "enable_thinking": false }`; GLM and gpt-oss always reason; Llama never does.
- **Queueing depends on where the call comes from.** Same key, same moment: DeepSeek started in 12 s from a home connection but not within 120 s from Vercel (tested in iad1 and sin1); GLM took 41–104 s from Vercel. Nemotron (~1 s), gpt-oss (0.7 s) and Llama (0.8 s) start immediately from Vercel — hence the demo's `DEFAULT_MODEL`.

## Adding a model

1. Probe limits directly against NIM: send `max_tokens: 10000000` — the validation error reveals the ceiling without generating anything.
2. Check whether reasoning is streamed and whether a `chat_template_kwargs` flag removes it.
3. Add it to `MODELS` in `server/models.mjs` with `reasoning`, `thinkingKwargs`, `maxOutput` and `contextWindow`.
4. Verify it **from the deployment**, not just locally — NVIDIA's queueing differs for cloud traffic:
   ```bash
   curl -s https://<your-domain>/api/chat -H "Content-Type: application/json" \
     -d '{"model":"<id>","messages":[{"role":"user","content":"Say hi."}],"thinking":false,"maxTokens":1000}'
   ```
