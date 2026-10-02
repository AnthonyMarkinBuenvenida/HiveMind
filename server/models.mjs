// Curated model registry. NVIDIA's /v1/models lists models that are not actually
// usable on every account (some 404, some hang), so only verified models go here.
//
// reasoning:
//   "toggle" — streams reasoning; can be switched off via `thinkingKwargs`
//   "always" — streams reasoning; no verified way to disable it
//   "none"   — never streams reasoning
//
// maxOutput:     largest max_tokens NVIDIA accepts for the model (probed 2026-10-02).
// contextWindow: total tokens (prompt + output) when the model enforces one; null when only the
//                gateway's max_tokens cap applies. The app further caps output at 50,000
//                (server/tokens.mjs). See docs/API.md for how each entry was verified.

/** @typedef {{ id: string, label: string, vendor: string, description: string, reasoning: "toggle" | "always" | "none", thinkingKwargs?: Record<string, unknown>, maxOutput: number, contextWindow: number | null }} ModelInfo */

const NIM_GATEWAY_MAX_TOKENS = 1_048_576; // "Max tokens must not exceed 1048576" (NIM validation)

/** @type {ModelInfo[]} */
export const MODELS = [
  {
    id: "deepseek-ai/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    vendor: "DeepSeek",
    description: "Fast general model with optional step-by-step thinking.",
    reasoning: "toggle",
    thinkingKwargs: { thinking: false },
    maxOutput: NIM_GATEWAY_MAX_TOKENS,
    contextWindow: null,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron 3 Super",
    vendor: "NVIDIA",
    description: "Large reasoning model, strong at analysis and code.",
    reasoning: "toggle",
    thinkingKwargs: { enable_thinking: false },
    maxOutput: NIM_GATEWAY_MAX_TOKENS,
    contextWindow: null,
  },
  {
    id: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    vendor: "Z.ai",
    description: "Quick responses with built-in reasoning.",
    reasoning: "always",
    maxOutput: NIM_GATEWAY_MAX_TOKENS,
    contextWindow: null,
  },
  {
    id: "openai/gpt-oss-20b",
    label: "gpt-oss 20B",
    vendor: "OpenAI",
    description: "Compact open-weight reasoning model.",
    reasoning: "always",
    maxOutput: 131_072, // "max_model_len=max_total_tokens=131072"
    contextWindow: 131_072,
  },
  {
    id: "meta/llama-3.2-11b-vision-instruct",
    label: "Llama 3.2 11B",
    vendor: "Meta",
    description: "Lightweight instruction model, no reasoning trace.",
    reasoning: "none",
    maxOutput: 131_072, // "maximum context length is 131072 tokens"
    contextWindow: 131_072,
  },
];

export function findModel(id) {
  return MODELS.find((m) => m.id === id);
}

export function defaultModelId() {
  const configured = process.env.DEFAULT_MODEL;
  return configured && findModel(configured) ? configured : MODELS[0].id;
}
