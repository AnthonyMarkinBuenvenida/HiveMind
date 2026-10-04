// Curated Gemini model registry. Only free-tier models are listed so the demo works with the key
// Google AI Studio injects (GEMINI_API_KEY). gemini-3.1-pro-preview is paid-only; add it here if
// the key has billing enabled.
//
// reasoning:
//   "toggle" — streams thought summaries; thinking on/off sends thinkingLevel `thinkingOn`/`thinkingOff`
//   "always" — streams thought summaries; the model rejects the lowest level, so it can't be turned off
//   "none"   — never streams reasoning
//
// maxOutput:     output token limit from the model page (ai.google.dev/gemini-api/docs/models, 2026-10).
// contextWindow: input token limit. The app further caps output at 50,000 (server/tokens.mjs).

/** @typedef {{ id: string, label: string, vendor: string, description: string, reasoning: "toggle" | "always" | "none", thinkingOn?: string, thinkingOff?: string, maxOutput: number, contextWindow: number | null }} ModelInfo */

const GEMINI_MAX_OUTPUT = 65_536;
const GEMINI_CONTEXT = 1_048_576;

/** @type {ModelInfo[]} */
export const MODELS = [
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    vendor: "Google",
    description: "Latest Flash model: strong reasoning, code and analysis.",
    reasoning: "always", // levels low/medium/high; "minimal" returns an error
    maxOutput: GEMINI_MAX_OUTPUT,
    contextWindow: GEMINI_CONTEXT,
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    vendor: "Google",
    description: "Balanced speed and quality with built-in thinking.",
    reasoning: "always",
    maxOutput: GEMINI_MAX_OUTPUT,
    contextWindow: GEMINI_CONTEXT,
  },
  {
    id: "gemini-3.5-flash-lite",
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
    label: "Gemini 3.1 Flash-Lite",
    vendor: "Google",
    description: "Compact, low-latency model; thinking is optional.",
    reasoning: "toggle",
    thinkingOn: "medium",
    thinkingOff: "minimal",
    maxOutput: GEMINI_MAX_OUTPUT,
    contextWindow: GEMINI_CONTEXT,
  },
];

export function findModel(id) {
  return MODELS.find((m) => m.id === id);
}

export function defaultModelId() {
  const configured = process.env.DEFAULT_MODEL;
  return configured && findModel(configured) ? configured : MODELS[0].id;
}
