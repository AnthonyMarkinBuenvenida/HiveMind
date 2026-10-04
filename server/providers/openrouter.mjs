// OpenRouter adapter (OpenAI-compatible chat completions). Emits the same events as gemini.mjs.
// Verified 2026-10-04 with a free-tier key: `reasoning: { enabled: false }` turns reasoning off on the
// toggle models, reasoning streams as `delta.reasoning`, and the stream may contain
// ": OPENROUTER PROCESSING" comment lines while a request is queued.

import { errorDetail, UpstreamError } from "./upstream.mjs";

function config() {
  return {
    key: (process.env.OPENROUTER_API_KEY || "").trim(),
    base: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
  };
}

const headers = (key) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  "X-Title": "HiveMind", // app name in OpenRouter's activity log
});

async function fail(response) {
  return new UpstreamError(response.status, errorDetail(await response.text().catch(() => "")));
}

export const openrouterProvider = {
  id: "openrouter",
  label: "OpenRouter",
  vendor: "OpenRouter",
  keyEnv: "OPENROUTER_API_KEY",

  configured: () => Boolean(config().key),

  /** GET /key validates the key without spending any of its request quota. */
  async check(_modelId, signal) {
    const { key, base } = config();
    const r = await fetch(`${base}/key`, { headers: headers(key), signal });
    if (!r.ok) throw await fail(r);
  },

  async open({ model, messages, system, temperature, topP, maxTokens, thinking, signal }) {
    const { key, base } = config();
    const payload = {
      model: model.id,
      messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      stream: true,
    };
    if (model.reasoning === "toggle" && thinking === false) payload.reasoning = { enabled: false };

    const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: headers(key), body: JSON.stringify(payload), signal });
    if (!response.ok) throw await fail(response);
    return { maxTokens, events: events(response.body, signal) };
  },
};

async function* events(body, signal) {
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason = null;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) {
        if (line.startsWith(":")) yield { type: "alive" }; // queue keep-alive comment
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      // A failure after streaming started: { error: { code, message }, choices: [{ finish_reason: "error" }] }
      if (json.error) throw new UpstreamError(Number(json.error.code) || 0, errorDetail(JSON.stringify(json)), Number(json.error.code) ? undefined : "midstream");
      const choice = json.choices?.[0];
      const delta = choice?.delta ?? {};
      let sent = false;
      if (delta.reasoning) {
        sent = true;
        yield { type: "reasoning", text: delta.reasoning };
      }
      if (delta.content) {
        sent = true;
        yield { type: "content", text: delta.content };
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json.usage) {
        sent = true;
        yield {
          type: "usage",
          usage: {
            prompt: json.usage.prompt_tokens ?? null,
            completion: json.usage.completion_tokens ?? null,
            reasoning: json.usage.completion_tokens_details?.reasoning_tokens || null,
          },
        };
      }
      if (!sent) yield { type: "alive" };
    }
  }
  if (signal.aborted) return;
  if (!finishReason || finishReason === "error") throw new UpstreamError(0, "", "midstream");
  yield { type: "finish", reason: finishReason };
}
