# HiveMind · AI Factory

A public demo of a workspace-style AI chat app, deployed on Vercel and backed by NVIDIA NIM's OpenAI-compatible API. Anyone with the link can use it — there is no sign-in. The NVIDIA key stays server-side, and rate limits are the abuse protection.

**Live demo:** https://hivemind-tawny.vercel.app

## Architecture

```
Browser ──HTTPS──▶ Vercel ─┬─ static SPA (Vite build, dist/)
                           └─ Functions api/{chat,models,health}.mjs ──▶ NVIDIA NIM
                                         │
                                         └─▶ Neon Postgres (global rate-limit counters)
```

All API logic is in `server/` and is shared by the Vercel functions and the local Vite dev server.

## Local development

```bash
npm install
cp .env.example .env      # set NVIDIA_API_KEY
npm run dev               # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with the API mounted as middleware |
| `npm run build` | Type-check, then build to `dist/` |
| `npm run preview` | Serve the build on :8787 with production security headers |
| `npm test` | Server, token, theme-contrast, settings, markdown and math tests (`node --test`, no network) |

Without `DATABASE_URL`, local rate limits live in process memory. To run the Postgres store test against a real database, set `POSTGRES_URL_FOR_TESTS`.

## Deploying to Vercel

1. `vercel link` (or import the repo). `vercel.json` sets the build, function durations, request cancellation and security headers.
2. Environment variables (Production):
   - `NVIDIA_API_KEY` — mark as **Sensitive**.
   - `DATABASE_URL` — connect a Neon/Postgres resource for **global** rate limits (without it, limits are per function instance only).
   - Optional: `DEFAULT_MODEL`, `RATE_LIMIT_*`, `MAX_CONCURRENT_STREAMS`, `MAX_OUTPUT_TOKENS`, `LOG_SALT` (see `.env.example`).
3. `vercel deploy --prod`. Check `GET /api/health` — it reports the deployment id that answered.

Vercel Deployment Protection covers per-deployment URLs; the production domain is public.

## Features

- Streaming chat with stop, regenerate, retry, edit-and-resend, and **Continue** when a response hits the output or time limit
- Model picker (5 verified NIM models), thinking on/off where supported, temperature, top-p, system prompt
- **Max output up to 50,000 tokens** where the model and NVIDIA accept it, with presets; clamped per request to the model's context
- Math (KaTeX) and syntax highlighting (20+ languages), lazy-loaded; Markdown tables, code copy/wrap
- Conversations stored in the browser: search, rename, export Markdown/JSON, delete, delete-all
- Text-file attachments (picker or drag-and-drop)
- Themes: **Dark**, **True Black**, **White + Gold** — persisted, applied before first paint
- Responsive (desktop, tablet drawer, phone), keyboard shortcuts, WCAG AA contrast, axe-clean

## Limits and behaviour on the demo

| | Value | Notes |
|---|---|---|
| Messages per visitor (IP) | 6 / minute, 120 / day | Global across instances via Postgres |
| Messages for the whole demo | 1,500 / day | Protects the NVIDIA quota |
| Simultaneous responses per visitor | 2 | Slots are 30 s leases renewed while streaming |
| One response | ≤ 285 s | Vercel function limit (300 s, Hobby). Then "Paused at the time limit" + Continue |
| Output | ≤ 50,000 tokens | At ~45 tok/s one response yields ~12K tokens before the time limit; Continue for more |
| Request body | ≤ 2 MB | |

## Known limitations

- **Public by link**: anyone with the URL spends the demo's NVIDIA quota (bounded by the limits above). There are no accounts.
- **DeepSeek V4.1 Flash and GLM 5.3 Flash queue for minutes when called from Vercel** (NVIDIA prioritizes differently for cloud traffic; measured: same key, same moment — 12 s from a home connection vs >120 s from Vercel). They stay selectable; the demo defaults to Nemotron 3 Super.
- **Chats live in each browser** (`localStorage`); they don't sync and aren't on the server.
- **Attachments are text only** — no image/PDF/Office parsing.
- A visitor's IP is the rate-limit identity: people behind one NAT share a quota; a visitor with many IPs gets more (the global daily cap still applies).
- Security headers come from `vercel.json` (and `vite preview`), not from the Vite dev server.
