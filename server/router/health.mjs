// Runtime health per model and per provider, kept in memory per server instance (no personal data:
// only model ids, outcomes, timings). Feeds the router: reliability and latency scores, and
// cooldowns that temporarily exclude a failing model or provider.
//
// Outcomes are kept for WINDOW_MS (rolling window, at most MAX_EVENTS per model). A failure starts a
// cooldown that grows with consecutive failures (exponential backoff, capped); a success ends it.
// When a cooldown expires the model is eligible again ("half-open"): one success restores it.

const WINDOW_MS = 15 * 60_000;
const MAX_EVENTS = 30;
const LATENCY_SAMPLES = 5; // time to first token = mean of the latest samples in the window

/** Cooldown per failure kind: [base, cap] in ms (doubles per consecutive failure). */
const COOLDOWN = {
  rate_limited: [60_000, 15 * 60_000],
  timeout: [30_000, 10 * 60_000],
  overloaded: [20_000, 10 * 60_000], // 5xx, "high demand", stream died early
  unavailable: [6 * 60 * 60_000, 6 * 60 * 60_000], // 404 / model restricted (403): won't fix itself soon
  rejected: [60_000, 10 * 60_000], // 400s that another model may accept
  payment: [30 * 60_000, 30 * 60_000],
};
const PROVIDER_COOLDOWN = {
  auth: 10 * 60_000, // the provider rejected our key: every model of it would fail
  quota: 30 * 60_000, // account-wide daily quota (e.g. OpenRouter free-models-per-day)
  unreachable: 30_000,
};

let models = new Map(); // id -> { events: [{ t, ok, kind?, ttft? }], streak, coolUntil, coolKind }
let providers = new Map(); // id -> { coolUntil, kind, scope }
let now = () => Date.now();

function entry(id) {
  let e = models.get(id);
  if (!e) models.set(id, (e = { events: [], streak: 0, coolUntil: 0, coolKind: null }));
  return e;
}

function prune(e) {
  const cutoff = now() - WINDOW_MS;
  while (e.events.length && (e.events[0].t < cutoff || e.events.length > MAX_EVENTS)) e.events.shift();
}

export function recordSuccess(id, { ttftMs } = {}) {
  const e = entry(id);
  e.events.push({ t: now(), ok: true, ttft: typeof ttftMs === "number" ? ttftMs : undefined });
  prune(e);
  e.streak = 0;
  e.coolUntil = 0;
  e.coolKind = null;
}

/** @param {keyof COOLDOWN} kind @param {{ retryAfterMs?: number }} [opts] */
export function recordFailure(id, kind, { retryAfterMs } = {}) {
  const e = entry(id);
  e.events.push({ t: now(), ok: false, kind });
  prune(e);
  e.streak += 1;
  const [base, cap] = COOLDOWN[kind] ?? COOLDOWN.overloaded;
  const backoff = Math.min(cap, base * 2 ** (e.streak - 1));
  e.coolUntil = now() + Math.max(backoff, retryAfterMs ?? 0);
  e.coolKind = kind;
}

/** Cools down a whole provider (or only its free models, scope "free"). */
export function recordProviderFailure(provider, kind, { scope = "all", retryAfterMs } = {}) {
  providers.set(provider, { coolUntil: now() + Math.max(PROVIDER_COOLDOWN[kind] ?? 30_000, retryAfterMs ?? 0), kind, scope });
}

export function recordProviderSuccess(provider) {
  providers.delete(provider);
}

/** Why `model` is cooling down right now, or null. */
export function coolingReason(model) {
  const p = providers.get(model.provider);
  if (p && p.coolUntil > now() && (p.scope === "all" || (p.scope === "free" && model.free))) return `provider ${p.kind}`;
  const e = models.get(model.id);
  return e && e.coolUntil > now() ? e.coolKind : null;
}

/**
 * Health numbers for scoring: success rate with a Laplace prior ((ok+1)/(n+2), so 0.5 with no
 * data), the time-to-first-token average, and the sample count.
 */
export function stats(id) {
  const e = models.get(id);
  if (!e) return { successRate: 0.5, samples: 0, ttftMs: null };
  prune(e);
  const ok = e.events.filter((x) => x.ok).length;
  const ttfts = e.events.filter((x) => typeof x.ttft === "number").slice(-LATENCY_SAMPLES).map((x) => x.ttft);
  const ttftMs = ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null;
  return { successRate: (ok + 1) / (e.events.length + 2), samples: e.events.length, ttftMs };
}

/** "ok" | "degraded" (recent failures) | "cooling" (temporarily excluded) — for the UI and debug view. */
export function status(model) {
  if (coolingReason(model)) return "cooling";
  const s = stats(model.id);
  return s.samples >= 2 && s.successRate < 0.5 ? "degraded" : "ok";
}

/** Debug snapshot: no personal data, only model ids and aggregates. */
export function snapshot() {
  const out = {};
  for (const [id, e] of models) {
    const s = stats(id);
    out[id] = { ...s, successRate: Math.round(s.successRate * 100) / 100, coolingForMs: Math.max(0, e.coolUntil - now()), lastFailure: e.coolKind };
  }
  return { models: out, providers: Object.fromEntries([...providers].map(([k, v]) => [k, { ...v, coolingForMs: Math.max(0, v.coolUntil - now()) }])) };
}

/** For tests: reset state and optionally control the clock. */
export function resetHealth(clock) {
  models = new Map();
  providers = new Map();
  now = clock ?? (() => Date.now());
}
