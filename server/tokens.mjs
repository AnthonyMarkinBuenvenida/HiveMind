// Output-token limits. The app targets up to 50,000 output tokens (MAX_OUTPUT_TOKENS), but never
// more than the model/API accepts, and never more than fits in the model's context window
// after the prompt. If NVIDIA still rejects the value, parseLimitFromError() finds the real
// ceiling in its message so the request can be retried once instead of failing.

export const DEFAULT_OUTPUT_CAP = 50_000;
export const MIN_OUTPUT_TOKENS = 256;
const PROMPT_CHARS_PER_TOKEN = 3; // conservative (real text averages ~4 chars/token)
const CONTEXT_MARGIN = 256;

export function outputCap() {
  const n = Number.parseInt(process.env.MAX_OUTPUT_TOKENS ?? "", 10);
  return Number.isFinite(n) && n >= MIN_OUTPUT_TOKENS ? n : DEFAULT_OUTPUT_CAP;
}

/** Largest output the UI may offer for a model: min(app cap, verified API maximum). */
export function modelOutputLimit(model, cap = outputCap()) {
  return Math.min(cap, model.maxOutput);
}

/** max_tokens to send: the user's request clamped to the model limit and the context left after the prompt. */
export function planMaxTokens(model, requested, promptChars, cap = outputCap()) {
  const limit = modelOutputLimit(model, cap);
  const wanted = typeof requested === "number" && Number.isFinite(requested) ? Math.round(requested) : Math.min(4096, limit);
  let n = Math.min(limit, Math.max(MIN_OUTPUT_TOKENS, wanted));
  if (model.contextWindow) {
    const promptTokens = Math.ceil(promptChars / PROMPT_CHARS_PER_TOKEN) + CONTEXT_MARGIN;
    n = Math.min(n, model.contextWindow - promptTokens);
  }
  return n;
}

/**
 * Reads a token ceiling out of an NVIDIA/vLLM validation error. Returns a smaller max_tokens
 * that should be accepted, or null if the error isn't about max_tokens.
 */
export function parseLimitFromError(text, sent) {
  let m = /maximum context length is (\d+) tokens.*?\((\d+) in the messages/is.exec(text);
  if (m) return fit(Number(m[1]) - Number(m[2]) - 16, sent);
  m = /max_model_len=(?:max_total_tokens=)?(\d+)/i.exec(text);
  if (m) return fit(Number(m[1]) - 1024, sent); // prompt size unknown here: leave headroom
  m = /max(?:imum)?[ _]tokens must not exceed (\d+)/i.exec(text);
  if (m) return fit(Number(m[1]), sent);
  return null;
}

function fit(n, sent) {
  return n >= MIN_OUTPUT_TOKENS && n < sent ? n : null;
}
