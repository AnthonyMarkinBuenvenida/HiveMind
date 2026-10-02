# HiveMind — project instructions

Public demo on Vercel. React 19 + Vite 8 + TypeScript SPA; plain-ESM API in `server/` exposed as Vercel functions (`api/*.mjs`) and as Vite middleware locally; NVIDIA NIM backend; Neon Postgres for rate-limit counters. No authentication by design. Setup/deploy: README.md.

## Commands
- `npm run dev` — app + API on :5173
- `npm test` — must pass (no network). Set `POSTGRES_URL_FOR_TESTS` to include the real-database store tests.
- `npm run build` — must pass before calling work done
- `vercel deploy --prod` — then confirm `GET /api/health` reports the new deployment id

## Rules
- Secrets (`NVIDIA_API_KEY`, `DATABASE_URL`) are read only in `server/`. Never `VITE_`-prefix them or reference `import.meta.env` secrets in `src/`. Never log headers, bodies, query strings or raw IPs (use `logId`).
- There is no sign-in: rate limits (`server/limits.mjs`) are the abuse protection. Every NVIDIA-calling route must go through `acquireChat`. Don't claim memory-only limits are global.
- Vercel runtime facts (verified in production): work after the response ends may never run, and a cancelled request's function can stop before async cleanup — release resources before `res.end()` and rely on short leases (concurrency slots) rather than cleanup.
- Keep `vercel.json` in sync: security headers = `server/securityHeaders.mjs`; `api/chat.mjs` maxDuration = `FUNCTION_MAX_DURATION` default (300); `supportsCancellation: true` (without it Stop doesn't reach the function). Tests enforce the first two.
- Models are a curated allowlist (`server/models.mjs`) with probed `maxOutput`/`contextWindow`; verify with real requests before changing. Output is capped at `MAX_OUTPUT_TOKENS` (50,000) and clamped per request (`server/tokens.mjs`).
- Model output is untrusted: no `rehype-raw`, no `innerHTML`, KaTeX `trust: false`. Markdown goes through `normalizeMath` + `splitBlocks` (keep their tests green).
- Colors only via tokens in `src/styles/tokens.css`; every theme must define every token and pass `src/styles/tokens.test.ts` (contrast). No ad-hoc z-index (docs/DESIGN.md "Layering").
- Components that only act use stable contexts (`useConversationActions`, `useDraftActions`). Don't subscribe to per-keystroke or per-frame state without need.
- Frontend changes need browser verification at 1440, 768 and 390 widths; deployment changes need verification on the live URL.

## Docs
- docs/DESIGN.md — tokens, themes, layering, breakpoints, component and rendering conventions
- docs/API.md — routes, SSE events, limits, security model, Vercel and NIM behaviour, adding a model
