# HiveMind — project instructions

Public demo for Google AI Studio (Build) / Cloud Run, also deployable on Vercel. React 19 + Vite 8 + TypeScript SPA; plain-ESM API in `server/` served by `server.ts` (Express + Vite middleware, port 3000) and as Vercel functions (`api/*.mjs`); two model providers behind one stream format — Gemini API (`server/providers/gemini.mjs`, `@google/genai`) and OpenRouter (`server/providers/openrouter.mjs`); optional Postgres for global rate-limit counters. No authentication by design. Setup/deploy: README.md.

## Commands
- `npm run dev` — app + API on :3000 (`tsx server.ts`; also what AI Studio runs)
- `npm start` — production server (`dist/` + API + security headers)
- `npm test` — must pass (no network). Set `POSTGRES_URL_FOR_TESTS` to include the real-database store tests.
- `npm run build` — must pass before calling work done
- AI Studio imports this repo from GitHub (Build → + → Import from GitHub) and injects `GEMINI_API_KEY` (`OPENROUTER_API_KEY` goes in its Secrets); keep `metadata.json` and the `dev`/`start` scripts.

## Rules
- Secrets (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DATABASE_URL`) are read only in `server/`. Never `VITE_`-prefix them or reference `import.meta.env` secrets in `src/`. Never log headers, bodies, query strings or raw IPs (use `logId`).
- There is no sign-in: rate limits (`server/limits.mjs`) are the abuse protection. Every model-calling route must go through `acquireChat`. Don't claim memory-only limits are global.
- Serverless runtime facts (verified on Vercel; assume the same on Cloud Run): work after the response ends may never run, and a cancelled request's function can stop before async cleanup — release resources before `res.end()` and rely on short leases (concurrency slots) rather than cleanup.
- Keep `vercel.json` in sync: security headers = `server/securityHeaders.mjs` (framing allowed only for aistudio.google.com); `api/chat.mjs` maxDuration = `FUNCTION_MAX_DURATION` default (300); `supportsCancellation: true` (without it Stop doesn't reach the function). Tests enforce the first two.
- Models are a curated allowlist of free models (`server/models.mjs`, each with a `provider`); a model is offered only when its provider's key is set. Verify with real requests before changing (the OpenRouter key allows only 50 requests/day). `server/gemini.test.mjs` and `server/openrouter.test.mjs` test the stream mapping against fake servers. Output is capped at `MAX_OUTPUT_TOKENS` (50,000) and clamped per request (`server/tokens.mjs`).
- Model output is untrusted: no `rehype-raw`, no `innerHTML`, KaTeX `trust: false`. Markdown goes through `normalizeMath` + `splitBlocks` (keep their tests green).
- Colors only via tokens in `src/styles/tokens.css`; every theme must define every token and pass `src/styles/tokens.test.ts` (contrast). No ad-hoc z-index (docs/DESIGN.md "Layering").
- Components that only act use stable contexts (`useConversationActions`, `useDraftActions`). Don't subscribe to per-keystroke or per-frame state without need.
- Frontend changes need browser verification at 1440, 768 and 390 widths; deployment changes need verification on the live URL.

## Docs
- docs/DESIGN.md — tokens, themes, layering, breakpoints, component and rendering conventions
- docs/API.md — routes, SSE events, provider request mapping, limits, security model, adding a model
