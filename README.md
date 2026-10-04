# HiveMind · AI Factory

A public demo of a workspace-style AI chat app powered by the **Google Gemini API**. It runs in Google AI Studio (Build), on Cloud Run, or on Vercel. Anyone with the link can use it — there is no sign-in. The Gemini key stays server-side, and rate limits are the abuse protection.

## Architecture

```
Browser ──HTTPS──▶ server.ts (Express) ─┬─ React SPA (Vite middleware in dev, dist/ in production)
                                        └─ /api/{chat,models,health} → server/api.mjs ──▶ Gemini API (@google/genai)
                                                                          │
                                                                          └─▶ Postgres (optional: global rate-limit counters)
```

All API logic is in `server/`. `server.ts` is the entry point for local runs, Google AI Studio and Cloud Run; on Vercel the same handler runs as functions (`api/*.mjs`).

## Google AI Studio

1. In [AI Studio Build](https://aistudio.google.com/apps), click **+** in the prompt box → **Import from GitHub**, pick this repository and click **Import repository**.
2. AI Studio injects `GEMINI_API_KEY` server-side (Settings → **Secrets**); nothing else is required. `metadata.json` declares the server-side Gemini capability.
3. The preview runs `npm run dev` (Express + Vite on port 3000). **Deploy** publishes to Cloud Run, which runs `npm run build` and `npm start`.

Optional secrets: `DEFAULT_MODEL`, `DATABASE_URL` (global rate limits), `RATE_LIMIT_*`, `MAX_CONCURRENT_STREAMS`, `MAX_OUTPUT_TOKENS`, `LOG_SALT` — see `.env.example`.

## Local development

```bash
npm install
cp .env.example .env      # set GEMINI_API_KEY (https://aistudio.google.com/apikey)
npm run dev               # http://localhost:3000
```

| Script | What it does |
|---|---|
| `npm run dev` | Express server with the API and Vite (hot reload) on :3000 |
| `npm run build` | Type-check, then build to `dist/` |
| `npm start` | Serve `dist/` and the API with production security headers |
| `npm run preview` | Build, then `npm start` |
| `npm test` | Server (incl. streaming against a fake Gemini API), token, theme-contrast, settings, markdown and math tests (`node --test`, no network) |

Without `DATABASE_URL`, rate limits live in process memory. To run the Postgres store test against a real database, set `POSTGRES_URL_FOR_TESTS`.

## Deploying to Vercel (optional)

`vercel.json` sets the build, function durations, request cancellation and security headers. Set `GEMINI_API_KEY` (Sensitive) and optionally `DATABASE_URL` in the project's environment variables, then `vercel deploy --prod` and check `GET /api/health`.

## Features

- Streaming chat with stop, regenerate, retry, edit-and-resend, and **Continue** when a response hits the output or time limit
- Model picker (4 free-tier Gemini models), visible thinking (thought summaries), thinking on/off on Flash-Lite, temperature, top-p, system prompt
- **Max output up to 50,000 tokens** (Gemini allows 65,536), with presets
- Math (KaTeX) and syntax highlighting (20+ languages), lazy-loaded; Markdown tables, code copy/wrap
- Conversations stored in the browser: search, rename, export Markdown/JSON, delete, delete-all
- Text-file attachments (picker or drag-and-drop)
- Themes: **Dark**, **True Black**, **White + Gold** — persisted, applied before first paint
- Responsive (desktop, tablet drawer, phone), keyboard shortcuts, WCAG AA contrast, axe-clean

## Limits and behaviour

| | Value | Notes |
|---|---|---|
| Messages per visitor (IP) | 6 / minute, 120 / day | Global across instances only with `DATABASE_URL` |
| Messages for the whole demo | 1,500 / day | Protects the Gemini quota |
| Simultaneous responses per visitor | 2 | Slots are 30 s leases renewed while streaming |
| One response | ≤ 285 s on Cloud Run / Vercel, 10 min locally | Platform request timeout (300 s) − 15 s. Then "Paused at the time limit" + Continue |
| Output | ≤ 50,000 tokens | |
| Request body | ≤ 2 MB | |

## Known limitations

- **Public by link**: anyone with the URL spends the demo's Gemini quota (bounded by the limits above, and by Gemini's own free-tier rate limits — a `429` is shown as "rate limit or quota reached").
- **Chats live in each browser** (`localStorage`); they don't sync and aren't on the server.
- **Attachments are text only** — no image/PDF/Office parsing.
- A visitor's IP is the rate-limit identity: people behind one NAT share a quota; a visitor with many IPs gets more (the global daily cap still applies).
- Security headers are sent by `npm start` / Cloud Run and `vercel.json`, not by the dev server (React refresh needs inline scripts).
