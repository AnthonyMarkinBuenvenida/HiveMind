// Dynamic model registry. Builds the list of usable models from the providers' own catalogs and
// normalizes them into one shape the router and the UI use:
//
//   { id, provider, label, vendor, description, contextWindow, maxOutput,
//     reasoning: "toggle" | "always" | "none", efforts: string[] (lowest → highest),
//     vision, tools, streaming, free, price: { input, output } ($ per 1M tokens, what this deployment pays),
//     quality: { intelligence, coding } | null (Artificial Analysis indices, via OpenRouter's catalog),
//     keyEnv?, source: "live" | "snapshot" }
//
// Sources (refreshed at most every REGISTRY_TTL_MS, per server instance):
//   - OpenRouter GET /api/v1/models (public): limits, modalities, pricing, reasoning efforts, benchmark
//     indices — also for Google's models, which OpenRouter lists as google/<id>.
//   - Gemini models.list: which Gemini models exist for this key, with input/output limits.
// Which models are included is decided by rules (DISCOVERY below), not a fixed list, so new models
// appear automatically. If a catalog can't be fetched, server/catalog-snapshot.mjs (same rules, data
// captured 2026-10-04) is used instead.

import { SNAPSHOT } from "./catalog-snapshot.mjs";

const REGISTRY_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 4_000;
export const EFFORT_SCALE = ["minimal", "low", "medium", "high", "xhigh", "max"];

// ---------- Discovery rules ----------

/** Gemini: plain text-chat families only (no -preview/-image/-tts/-live/-customtools variants). */
const GEMINI_NAME = /^models\/(gemini-\d+(?:\.\d+)?-(?:flash-lite|flash|pro))$/;

function geminiTier() {
  // The free tier has no Pro models (ai.google.dev/gemini-api/docs/pricing, 2026-10).
  return process.env.GEMINI_TIER === "paid" ? "paid" : "free";
}

const DEFAULT_OPENROUTER_EXCLUDE = [
  // Verified 2026-10-04: 403 "only available on agentic harnesses".
  "thinkingmachines/inkling:free",
  "thinkingmachines/inkling-small:free",
];
const DEFAULT_OPENROUTER_EXTRA = ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"];

const listEnv = (name, fallback) => {
  const v = process.env[name];
  return v === undefined ? fallback : v.split(",").map((s) => s.trim()).filter(Boolean);
};

/** Behaviour verified against the real API that the catalog doesn't describe. */
export const OVERRIDES = {
  // `reasoning: { enabled: false }` garbled its answer (2026-10-04), so thinking stays on.
  "cohere/north-mini-code:free": { reasoning: "always" },
  "deepseek/deepseek-v4.1-flash": { keyEnv: "OPENROUTER_DEEPSEEK_API_KEY" },
  "deepseek/deepseek-v4-pro": { keyEnv: "OPENROUTER_DEEPSEEK_API_KEY" },
};

// ---------- Normalization ----------

const perMillion = (v) => Math.round(Number(v ?? 0) * 1e6 * 1000) / 1000;
const sortEfforts = (list) => [...new Set(list ?? [])].filter((e) => EFFORT_SCALE.includes(e)).sort((a, b) => EFFORT_SCALE.indexOf(a) - EFFORT_SCALE.indexOf(b));

function qualityOf(orEntry) {
  const aa = orEntry?.benchmarks?.artificial_analysis;
  if (!aa) return null;
  const intelligence = typeof aa.intelligence_index === "number" ? aa.intelligence_index : null;
  const coding = typeof aa.coding_index === "number" ? aa.coding_index : null;
  return intelligence === null && coding === null ? null : { intelligence, coding };
}

const compact = (n) => (n >= 1_000_000 ? `${Math.round(n / 104_857.6) / 10}M` : `${Math.round(n / 1000)}K`).replace(".0M", "M");

function describe(m) {
  const thinking = m.reasoning === "toggle" ? "optional thinking" : m.reasoning === "always" ? "always thinks" : "no thinking";
  const cost = m.free ? "free" : `$${m.price.output}/M output`;
  return [`${compact(m.contextWindow)} context`, thinking, m.vision ? "reads images" : null, cost].filter(Boolean).join(" · ");
}

function finish(m) {
  const o = OVERRIDES[m.id] ?? {};
  const model = { streaming: true, ...m, ...o };
  model.description = describe(model);
  return model;
}

/** OpenRouter catalog entry → normalized model. */
export function fromOpenRouter(e, source = "live") {
  const name = String(e.name ?? e.id);
  const vendor = name.includes(":") ? name.split(":")[0].trim() : e.id.split("/")[0];
  const label = name.replace(/^[^:]+:\s*/, "").replace(/\s*\(free\)\s*$/i, "");
  const params = e.supported_parameters ?? [];
  const efforts = sortEfforts(e.reasoning?.supported_efforts);
  const reasoning = !params.includes("reasoning") && !e.reasoning ? "none" : e.reasoning?.mandatory ? "always" : "toggle";
  const price = { input: perMillion(e.pricing?.prompt), output: perMillion(e.pricing?.completion) };
  return finish({
    id: e.id,
    provider: "openrouter",
    label,
    vendor,
    contextWindow: e.context_length ?? e.top_provider?.context_length ?? 0,
    maxOutput: e.top_provider?.max_completion_tokens ?? e.context_length ?? 0,
    reasoning,
    efforts,
    vision: (e.architecture?.input_modalities ?? []).includes("image"),
    tools: params.includes("tools"),
    free: price.input === 0 && price.output === 0,
    price,
    quality: qualityOf(e),
    source,
  });
}

/** Gemini models.list entry (+ OpenRouter's google/<id> entry for benchmarks, efforts, modalities). */
export function fromGemini(g, orEntry, source = "live") {
  const id = GEMINI_NAME.exec(g.name)[1];
  const efforts = sortEfforts(orEntry?.reasoning?.supported_efforts);
  const free = geminiTier() === "free";
  const price = free ? { input: 0, output: 0 } : { input: perMillion(orEntry?.pricing?.prompt), output: perMillion(orEntry?.pricing?.completion) };
  return finish({
    id,
    provider: "gemini",
    label: g.displayName || id,
    vendor: "Google",
    contextWindow: g.inputTokenLimit ?? 0,
    maxOutput: g.outputTokenLimit ?? 0,
    // Thinking can be switched off only where the lowest level is "minimal" (verified: 3.5/3.6 Flash
    // use 0 thinking tokens at minimal; 3.8 Flash rejects minimal).
    reasoning: g.thinking ? (efforts.length === 0 || efforts[0] === "minimal" ? "toggle" : "always") : "none",
    efforts: efforts.length ? efforts : g.thinking ? ["minimal", "low", "medium", "high"] : [],
    vision: orEntry ? (orEntry.architecture?.input_modalities ?? []).includes("image") : true, // Gemini chat models are multimodal
    tools: true,
    free,
    price,
    quality: qualityOf(orEntry),
    source,
  });
}

/** Applies the discovery rules to raw catalogs. Exported for the snapshot generator and tests. */
export function buildModels({ geminiModels, openrouterModels }, { gemini = true, openrouter = true, source = "live" } = {}) {
  const byId = new Map((openrouterModels ?? []).map((e) => [e.id, e]));
  const out = [];
  if (gemini) {
    const usable = (geminiModels ?? []).filter((g) => {
      const m = GEMINI_NAME.exec(g.name ?? "");
      return m && (g.supportedGenerationMethods ?? []).includes("generateContent") && !(m[1].endsWith("-pro") && geminiTier() === "free");
    });
    // Only the newest generation (e.g. 3.x once it exists, not 2.5), unless GEMINI_MIN_VERSION says otherwise.
    const major = (g) => Number(/gemini-(\d+)/.exec(g.name)[1]);
    const minMajor = Number(process.env.GEMINI_MIN_VERSION) || Math.max(0, ...usable.map(major));
    for (const g of usable) if (major(g) >= minMajor) out.push(fromGemini(g, byId.get(`google/${GEMINI_NAME.exec(g.name)[1]}`), source));
  }
  if (openrouter) {
    const exclude = new Set(listEnv("OPENROUTER_EXCLUDE", DEFAULT_OPENROUTER_EXCLUDE));
    const extra = new Set(listEnv("OPENROUTER_EXTRA_MODELS", DEFAULT_OPENROUTER_EXTRA));
    for (const e of openrouterModels ?? []) {
      if (exclude.has(e.id)) continue;
      const textOut = (e.architecture?.output_modalities ?? ["text"]).join() === "text";
      // Free models are included when they have independent benchmark data to route on.
      const discovered = e.id.endsWith(":free") && textOut && (e.context_length ?? 0) >= 32_000 && qualityOf(e)?.intelligence != null;
      if (discovered || extra.has(e.id)) out.push(fromOpenRouter(e, source));
    }
  }
  return out;
}

// ---------- Live refresh ----------

let cache = null; // { at, models, errors }
let inflight = null;

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${url.split("?")[0]} → ${r.status}`);
  return r.json();
}

async function refresh({ geminiKey, geminiBase, openrouterBase }) {
  const errors = [];
  const [orCatalog, geminiCatalog] = await Promise.all([
    fetchJson(`${openrouterBase}/models`).then((j) => j.data, (e) => (errors.push(`openrouter: ${e.message}`), null)),
    geminiKey
      ? fetchJson(`${geminiBase}/v1beta/models?pageSize=200`, { "x-goog-api-key": geminiKey }).then((j) => j.models, (e) => (errors.push(`gemini: ${e.message}`), null))
      : Promise.resolve(null),
  ]);
  const snapshot = (provider) => SNAPSHOT.filter((m) => m.provider === provider).map((m) => finish({ ...m, source: "snapshot" }));
  // Each provider falls back to the snapshot on its own; Gemini benchmarks need OpenRouter's catalog.
  const gemini = geminiCatalog ? buildModels({ geminiModels: geminiCatalog, openrouterModels: orCatalog ?? [] }, { openrouter: false }) : snapshot("gemini");
  const openrouter = orCatalog ? buildModels({ openrouterModels: orCatalog }, { gemini: false }) : snapshot("openrouter");
  // A failed fetch is retried after 5 minutes rather than the full hour.
  const at = errors.length ? Date.now() - REGISTRY_TTL_MS + 5 * 60_000 : Date.now();
  return { at, models: [...gemini, ...openrouter], errors };
}

/**
 * All registry models (callers filter by configured provider). Live data when enabled
 * (MODEL_REGISTRY_LIVE !== "false"), refreshed every hour; the snapshot otherwise.
 */
export async function getRegistry() {
  if (process.env.MODEL_REGISTRY_LIVE === "false") {
    return { models: SNAPSHOT.map((m) => finish({ ...m, source: "snapshot" })), source: "snapshot", errors: [] };
  }
  if (cache && Date.now() - cache.at < REGISTRY_TTL_MS) return { ...cache, source: "live" };
  inflight ??= refresh({
    geminiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim(),
    geminiBase: (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
    openrouterBase: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
  })
    .then((r) => (cache = r))
    .finally(() => (inflight = null));
  const r = await inflight;
  if (r.errors.length) console.warn(`[registry] using snapshot for: ${r.errors.join("; ")}`);
  return { ...r, source: "live" };
}

/** For tests. */
export function resetRegistry() {
  cache = null;
}
