// Curated model registry across providers (server/providers/). Only free models are listed so the
// demo works without billing: Gemini's free tier (the key Google AI Studio injects) and OpenRouter's
// `:free` models (a free-tier OpenRouter key allows 50 requests/day across them).
// gemini-3.1-pro-preview is paid-only; add it here if the Gemini key has billing enabled.
//
// provider: "gemini" | "openrouter" — a model is offered only when its provider's key is set.
// reasoning:
//   "toggle" — streams reasoning; can be switched off (Gemini: thinkingLevel `thinkingOn`/`thinkingOff`;
//              OpenRouter: `reasoning: { enabled: false }`)
//   "always" — streams reasoning; can't be switched off
//   "none"   — never streams reasoning
//
// maxOutput:     Gemini: output limit from the model page (2026-10). OpenRouter: top_provider.max_completion_tokens.
// contextWindow: input/context limit. The app further caps output at 50,000 (server/tokens.mjs).

/** @typedef {{ id: string, provider: "gemini" | "openrouter", label: string, vendor: string, description: string, reasoning: "toggle" | "always" | "none", thinkingOn?: string, thinkingOff?: string, maxOutput: number, contextWindow: number | null }} ModelInfo */

const GEMINI_MAX_OUTPUT = 65_536;
const GEMINI_CONTEXT = 1_048_576;

/** @type {ModelInfo[]} */
export const MODELS = [
  {
    id: "gemini-3.8-flash",
    provider: "gemini",
    label: "Gemini 3.8 Flash",
    vendor: "Google",
    description: "Latest Flash model: strong reasoning, code and analysis.",
    reasoning: "always", // levels low/medium/high; "minimal" returns an error
    maxOutput: GEMINI_MAX_OUTPUT,
    contextWindow: GEMINI_CONTEXT,
  },
  {
    id: "gemini-3.5-flash",
    provider: "gemini",
    label: "Gemini 3.5 Flash",
    vendor: "Google",
    description: "Balanced speed and quality with built-in thinking.",
    reasoning: "always",
    maxOutput: GEMINI_MAX_OUTPUT,
    contextWindow: GEMINI_CONTEXT,
  },
  {
    id: "gemini-3.5-flash-lite",
    provider: "gemini",
    label: "Gemini 3.5 Flash-Lite",
    vendor: "Google",
    description: "Fastest responses; thinking is optional.",
    reasoning: "toggle",
    thinkingOn: "medium",
    thinkingOff: "minimal", // the model's default level
    maxOutput: GEMINI_MAX_OUTPUT,
    contextWindow: GEMINI_CONTEXT,
  },
  {
    id: "gemini-3.1-flash-lite",
    provider: "gemini",
    label: "Gemini 3.1 Flash-Lite",
    vendor: "Google",
    description: "Compact, low-latency model; thinking is optional.",
    reasoning: "toggle",
    thinkingOn: "medium",
    thinkingOff: "minimal",
    maxOutput: GEMINI_MAX_OUTPUT,
    contextWindow: GEMINI_CONTEXT,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    provider: "openrouter",
    label: "Nemotron 3 Super",
    vendor: "NVIDIA",
    description: "Large reasoning model, strong at analysis and code.",
    reasoning: "toggle",
    maxOutput: 235_929,
    contextWindow: 262_144,
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    provider: "openrouter",
    label: "Nemotron 3 Ultra",
    vendor: "NVIDIA",
    description: "NVIDIA's largest open model, for hard reasoning.",
    reasoning: "toggle",
    maxOutput: 65_536,
    contextWindow: 1_000_000,
  },
  {
    id: "qwen/qwen3.8-27b:free",
    provider: "openrouter",
    label: "Qwen 3.8 27B",
    vendor: "Qwen",
    description: "Fast mid-size model with optional thinking.",
    reasoning: "toggle",
    maxOutput: 235_929,
    contextWindow: 262_144,
  },
  {
    id: "cohere/north-mini-code:free",
    provider: "openrouter",
    label: "North Mini Code",
    vendor: "Cohere",
    description: "Coding-focused model with built-in reasoning.",
    reasoning: "always", // `reasoning: { enabled: false }` garbled its answer (2026-10-04)
    maxOutput: 64_000,
    contextWindow: 256_000,
  },
];

export function findModel(id, models = MODELS) {
  return models.find((m) => m.id === id);
}

/** DEFAULT_MODEL when it is among `models`, else the first of them. */
export function defaultModelId(models = MODELS) {
  const configured = process.env.DEFAULT_MODEL;
  return configured && findModel(configured, models) ? configured : models[0]?.id;
}
