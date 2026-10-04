// Gemini API adapter (@google/genai). Turns a chat request into Gemini's format and its stream into
// the app's events: { type: "reasoning" | "content", text }, { type: "usage", usage },
// { type: "error", message, code } (in-stream, non-fatal), { type: "finish", reason }, { type: "alive" }.

import { ApiError, GoogleGenAI } from "@google/genai";
import { parseLimitFromError } from "../tokens.mjs";
import { errorDetail, UpstreamError } from "./upstream.mjs";

// Gemini finish reasons that mean the response was withheld, not completed.
const BLOCKED_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

function config() {
  return {
    key: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim(),
    // Optional override (tests point it at a fake server).
    baseUrl: process.env.GEMINI_BASE_URL?.trim() || undefined,
  };
}

let client = null;

function gemini() {
  const { key, baseUrl } = config();
  if (client?.key !== key || client?.baseUrl !== baseUrl) {
    client = { key, baseUrl, ai: new GoogleGenAI({ apiKey: key, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) }) };
  }
  return client.ai;
}

/** Gemini's own message out of an SDK error (its message is often the raw JSON error body). */
function sdkDetail(err) {
  const text = String(err?.message ?? "");
  const json = text.indexOf("{");
  return json >= 0 ? errorDetail(text.slice(json)) : text.trim().slice(0, 300);
}

function toUpstream(err) {
  return err instanceof ApiError ? new UpstreamError(err.status, sdkDetail(err)) : err;
}

export const geminiProvider = {
  id: "gemini",
  label: "Gemini API",
  vendor: "Google",
  keyEnv: "GEMINI_API_KEY",

  configured: () => Boolean(config().key),

  async check(modelId, signal) {
    try {
      await gemini().models.get({ model: modelId, config: { abortSignal: signal } });
    } catch (err) {
      throw toUpstream(err);
    }
  },

  /** Starts a streamed reply. Throws UpstreamError (or a network error) before anything streams. */
  async open({ model, messages, system, temperature, topP, maxTokens, thinking, signal }) {
    // Gemini roles are "user" and "model"; empty turns (e.g. a reply stopped before any text) are rejected.
    const contents = messages
      .filter((m) => m.content.trim())
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const genConfig = { temperature, topP, maxOutputTokens: maxTokens, abortSignal: signal };
    if (system) genConfig.systemInstruction = system;
    if (model.reasoning !== "none") {
      genConfig.thinkingConfig = { includeThoughts: true };
      if (model.reasoning === "toggle") {
        const level = thinking === false ? model.thinkingOff : model.thinkingOn;
        if (level) genConfig.thinkingConfig.thinkingLevel = level;
      }
    }
    const request = () => gemini().models.generateContentStream({ model: model.id, contents, config: genConfig });

    let stream;
    try {
      try {
        stream = await request();
      } catch (err) {
        // A 400 we can recover from is retried once instead of failing the user's request:
        // an output limit lower than expected, or a thinking level this model doesn't accept.
        if (signal.aborted || !(err instanceof ApiError) || err.status !== 400) throw err;
        const detail = sdkDetail(err);
        const lower = parseLimitFromError(detail, genConfig.maxOutputTokens);
        if (lower) genConfig.maxOutputTokens = lower;
        else if (genConfig.thinkingConfig?.thinkingLevel && /thinking/i.test(detail)) delete genConfig.thinkingConfig.thinkingLevel;
        else throw err;
        stream = await request();
      }
    } catch (err) {
      throw toUpstream(err);
    }
    return { maxTokens: genConfig.maxOutputTokens, events: events(stream, signal) };
  },
};

async function* events(stream, signal) {
  let finishReason = null;
  let usage = null;
  try {
    for await (const chunk of stream) {
      let sent = false;
      if (chunk.promptFeedback?.blockReason) {
        yield { type: "error", message: `Gemini blocked this prompt (${chunk.promptFeedback.blockReason.toLowerCase()}). Try rephrasing it.`, code: "blocked" };
        continue;
      }
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (!part.text) continue;
        sent = true;
        yield { type: part.thought ? "reasoning" : "content", text: part.text };
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata; // cumulative: the last one is the total
      if (!sent) yield { type: "alive" };
    }
  } catch (err) {
    if (signal.aborted || err instanceof ApiError) throw toUpstream(err);
    // The SDK fails to parse the error body Gemini sends after a mid-stream error event.
    throw new UpstreamError(0, "", "midstream");
  }
  if (signal.aborted) return;
  if (usage) {
    const thoughts = usage.thoughtsTokenCount ?? 0;
    // "completion" includes thinking tokens, as the UI expects.
    yield { type: "usage", usage: { prompt: usage.promptTokenCount ?? null, completion: (usage.candidatesTokenCount ?? 0) + thoughts, reasoning: thoughts || null } };
  }
  // Gemini reports a mid-stream failure (e.g. 503 high demand) as an error event that the SDK drops,
  // so the stream just ends without a finish reason.
  if (!finishReason) throw new UpstreamError(0, "", "midstream");
  if (BLOCKED_REASONS.has(finishReason)) {
    yield { type: "error", message: `Gemini stopped this response (${finishReason.toLowerCase().replace(/_/g, " ")}). Try rephrasing your message.`, code: "blocked" };
  }
  yield { type: "finish", reason: finishReason === "MAX_TOKENS" ? "length" : finishReason === "STOP" ? "stop" : finishReason.toLowerCase() };
}
