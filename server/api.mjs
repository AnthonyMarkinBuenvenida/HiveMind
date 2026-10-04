// Server-side API layer — the only code that sees GEMINI_API_KEY.
// Runs inside server.ts (Express: local dev, Google AI Studio, Cloud Run) and as Vercel
// functions (api/*.mjs). HiveMind is a public demo: there is no sign-in; abuse protection is
// rate limiting (server/limits.mjs), request limits and validation.
//
// Routes:
//   GET  /api/health  -> { status: "ok" | "missing_key" | "auth_failed" | "unreachable", message } (?fresh: at most every 5s)
//   GET  /api/models  -> { models, defaultModel, limits }
//   POST /api/chat    -> text/event-stream of normalized events (see docs/API.md)

import { ApiError, GoogleGenAI } from "@google/genai";
import { waitUntil } from "@vercel/functions";
import { clientIp, isSameOrigin, logId } from "./http.mjs";
import { acquireChat, LimitError, limitScope } from "./limits.mjs";
import { MODELS, findModel, defaultModelId } from "./models.mjs";
import { modelOutputLimit, outputCap, parseLimitFromError, planMaxTokens } from "./tokens.mjs";

// How long Gemini may take to start streaming (send response headers). It is always capped
// below the stream limit so a slow start can still produce an answer.
function headersTimeoutMs() {
  const s = Number(process.env.UPSTREAM_QUEUE_TIMEOUT_SECONDS);
  const wanted = Number.isFinite(s) && s > 0 ? s * 1000 : 120_000;
  return Math.min(wanted, streamLimitMs() - 30_000);
}
const IDLE_TIMEOUT_MS = 60_000; // max silence between streamed chunks
const HEALTH_TTL_MS = 60_000;
const HEALTH_FRESH_MIN_MS = 5_000; // "Re-check" can't be used to hammer Gemini's models endpoint
const MAX_BODY_BYTES = 2_000_000;
const MAX_MESSAGES = 200;
const MAX_TOTAL_CHARS = 600_000;
const MAX_SYSTEM_CHARS = 8_000;

const MID_STREAM_FAILURE = "Gemini stopped partway through, usually because the model is under high demand. Try regenerating or pick another model.";

// Gemini finish reasons that mean the response was withheld, not completed.
const BLOCKED_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/**
 * Longest a single response may stream. On Vercel and Cloud Run the platform ends a request at
 * its timeout (FUNCTION_MAX_DURATION, seconds; 300 = vercel.json maxDuration and Cloud Run's
 * default), so the stream ends cleanly a little before that with a "time limit" event the UI
 * can offer to continue from.
 */
export function streamLimitMs() {
  const explicit = Number(process.env.STREAM_LIMIT_SECONDS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit * 1000;
  if (process.env.VERCEL === "1" || process.env.K_SERVICE) return (Number(process.env.FUNCTION_MAX_DURATION) || 300) * 1000 - 15_000;
  return 10 * 60_000;
}

class HttpError extends Error {
  constructor(status, message, code, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function config() {
  return {
    key: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim(),
    // Optional override (tests point it at an unreachable address).
    baseUrl: process.env.GEMINI_BASE_URL?.trim() || undefined,
  };
}

let client = null;

function gemini({ key, baseUrl }) {
  if (client?.key !== key || client?.baseUrl !== baseUrl) {
    client = { key, baseUrl, ai: new GoogleGenAI({ apiKey: key, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) }) };
  }
  return client.ai;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function retryAfterHeader(ms) {
  return { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) };
}

function writeEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new HttpError(415, "Requests must be sent as JSON.", "unsupported_media_type");
  }
  const tooLarge = () => new HttpError(413, "Request is too large. Remove some attachments or start a new chat.", "too_large");
  if (Number(req.headers["content-length"]) > maxBytes) throw tooLarge();
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

function clamp(value, min, max, fallback) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, "No messages to send.", "invalid_request");
  if (input.length > MAX_MESSAGES) throw new HttpError(400, `Conversation exceeds ${MAX_MESSAGES} messages. Start a new chat.`, "too_long");
  let total = 0;
  const messages = input.map((m) => {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      throw new HttpError(400, "Each message needs a role of user or assistant and text content.", "invalid_request");
    }
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > MAX_TOTAL_CHARS) throw new HttpError(413, "Conversation is too long for a single request. Start a new chat.", "too_long");
  const last = messages[messages.length - 1];
  if (last.role !== "user" || !last.content.trim()) throw new HttpError(400, "The last message must be a non-empty user message.", "invalid_request");
  return messages;
}

/** Gemini's own message out of an SDK error (its message is often the raw JSON error body). */
function upstreamDetail(err) {
  const text = String(err?.message ?? "");
  const json = text.indexOf("{");
  if (json >= 0) {
    try {
      const j = JSON.parse(text.slice(json));
      return String(j.error?.message || j.message || "").slice(0, 300);
    } catch {
      // not JSON: fall through
    }
  }
  return text.trim().slice(0, 300);
}

function isAuthError(status, detail) {
  // Gemini answers an invalid key with 400 INVALID_ARGUMENT "API key not valid", not 401.
  return status === 401 || status === 403 || (status === 400 && /api[ _]?key/i.test(detail));
}

function mapUpstreamError(err) {
  const status = err instanceof ApiError ? err.status : 0;
  const detail = upstreamDetail(err);
  if (isAuthError(status, detail)) return new HttpError(502, "Google rejected the server's API key. The site owner needs to check GEMINI_API_KEY.", "auth_failed");
  if (status === 404) return new HttpError(502, "This model isn't available on the Gemini API right now. Pick another model.", "model_unavailable");
  if (status === 429) return new HttpError(429, "The Gemini API rate limit or quota was reached. Wait a moment and try again.", "rate_limited");
  if (status >= 400 && status < 500) return new HttpError(400, `The model rejected the request${detail ? `: ${detail}` : "."}`, "invalid_request");
  if (status === 503) return new HttpError(503, "Gemini is under high demand right now. Try again in a moment or pick another model.", "upstream_busy");
  if (status >= 500) return new HttpError(502, `The Gemini API returned an error (${status}). Try again shortly.`, "upstream_error");
  return new HttpError(502, "Could not reach the Gemini API. Try again shortly.", "upstream_unreachable");
}

let healthCache = null;

async function health(res, fresh) {
  const cfg = config();
  if (!cfg.key) return sendJson(res, 200, { status: "missing_key", message: "GEMINI_API_KEY is not set on the server." });
  const age = healthCache ? Date.now() - healthCache.at : Infinity;
  if (age < (fresh ? HEALTH_FRESH_MIN_MS : HEALTH_TTL_MS)) return sendJson(res, 200, healthCache.body);

  let body;
  try {
    await gemini(cfg).models.get({ model: defaultModelId(), config: { abortSignal: AbortSignal.timeout(10_000) } });
    body = { status: "ok", message: "Connected to the Gemini API." };
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    if (isAuthError(status, upstreamDetail(err))) body = { status: "auth_failed", message: "Google rejected the server's API key." };
    else if (status) body = { status: "unreachable", message: `The Gemini API responded with ${status}.` };
    else body = { status: "unreachable", message: "Could not reach the Gemini API." };
  }
  healthCache = { at: Date.now(), body };
  // Which deployment answered (non-secret; helps verify rollouts).
  const deployment = process.env.VERCEL_DEPLOYMENT_ID?.slice(-8) ?? process.env.K_REVISION ?? "local";
  sendJson(res, 200, { ...body, deployment });
}

function models(res) {
  sendJson(res, 200, {
    defaultModel: defaultModelId(),
    models: MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      vendor: m.vendor,
      description: m.description,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxOutput: modelOutputLimit(m),
    })),
    limits: { outputCap: outputCap(), streamSeconds: Math.floor(streamLimitMs() / 1000), rateLimitScope: limitScope() },
  });
}

async function chat(req, res) {
  const cfg = config();
  if (!cfg.key) throw new HttpError(503, "The server has no GEMINI_API_KEY configured.", "missing_key");

  let release;
  try {
    release = await acquireChat(clientIp(req));
  } catch (err) {
    if (err instanceof LimitError) throw new HttpError(429, err.message, err.code, retryAfterHeader(err.retryAfterMs));
    throw err;
  }
  // On a client disconnect (Stop, closed tab) try to free the slot immediately. The platform may
  // still end the request before this completes (observed on Vercel); the slot's short lease covers that.
  res.on("close", () => {
    if (!res.writableFinished) waitUntil(release());
  });
  try {
    await streamCompletion(req, res, gemini(cfg), release);
  } finally {
    await release(); // idempotent; covers errors thrown before streaming started
  }
}

async function streamCompletion(req, res, ai, release) {
  const body = await readJson(req);
  const model = findModel(body.model);
  if (!model) throw new HttpError(400, "Unknown model. Pick one from the model menu.", "invalid_model");

  const messages = validateMessages(body.messages);
  const system = typeof body.system === "string" ? body.system.trim().slice(0, MAX_SYSTEM_CHARS) : "";
  const promptChars = system.length + messages.reduce((n, m) => n + m.content.length, 0);

  const maxTokens = planMaxTokens(model, body.maxTokens, promptChars);
  if (maxTokens < 256) throw new HttpError(413, "This conversation fills the model's context window. Start a new chat or pick a model with a larger context.", "too_long");

  // Gemini roles are "user" and "model"; empty turns (e.g. a reply stopped before any text) are rejected.
  const contents = messages
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  const upstream = new AbortController();
  const genConfig = {
    temperature: clamp(body.temperature, 0, 2, 0.6),
    topP: clamp(body.topP, 0.01, 1, 0.95),
    maxOutputTokens: maxTokens,
    abortSignal: upstream.signal,
  };
  if (system) genConfig.systemInstruction = system;
  if (model.reasoning !== "none") {
    genConfig.thinkingConfig = { includeThoughts: true };
    if (model.reasoning === "toggle") {
      const level = body.thinking === false ? model.thinkingOff : model.thinkingOn;
      if (level) genConfig.thinkingConfig.thinkingLevel = level;
    }
  }

  const limitMs = streamLimitMs();
  let abortCause = null; // "client" | "headers_timeout" | "idle_timeout" | "max_duration"
  let finished = false;
  const abort = (cause) => {
    if (!abortCause) abortCause = cause;
    upstream.abort();
  };
  res.on("close", () => {
    if (!finished) abort("client");
  });
  const maxTimer = setTimeout(() => abort("max_duration"), limitMs);
  const queueMs = headersTimeoutMs();
  let timer = setTimeout(() => abort("headers_timeout"), queueMs);
  const stopTimers = () => {
    clearTimeout(timer);
    clearTimeout(maxTimer);
  };

  const request = () => ai.models.generateContentStream({ model: model.id, contents, config: genConfig });

  let stream;
  try {
    try {
      stream = await request();
    } catch (err) {
      // A 400 we can recover from is retried once instead of failing the user's request:
      // an output limit lower than expected, or a thinking level this model doesn't accept.
      if (abortCause || !(err instanceof ApiError) || err.status !== 400) throw err;
      const detail = upstreamDetail(err);
      const lower = parseLimitFromError(detail, genConfig.maxOutputTokens);
      if (lower) genConfig.maxOutputTokens = lower;
      else if (genConfig.thinkingConfig?.thinkingLevel && /thinking/i.test(detail)) delete genConfig.thinkingConfig.thinkingLevel;
      else throw err;
      stream = await request();
    }
  } catch (err) {
    stopTimers();
    if (abortCause === "client") return;
    if (abortCause === "headers_timeout") {
      throw new HttpError(504, `${model.label} didn't start responding within ${Math.round(queueMs / 1000)}s. Try again or pick another model.`, "upstream_timeout");
    }
    throw mapUpstreamError(err);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeEvent(res, { type: "start", model: model.id, maxTokens: genConfig.maxOutputTokens, limitSeconds: Math.floor(limitMs / 1000) });

  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort("idle_timeout"), IDLE_TIMEOUT_MS);
  };
  resetIdle();

  let finishReason = null;
  let usage = null;
  try {
    for await (const chunk of stream) {
      resetIdle();
      if (chunk.promptFeedback?.blockReason) {
        writeEvent(res, { type: "error", message: `Gemini blocked this prompt (${chunk.promptFeedback.blockReason.toLowerCase()}). Try rephrasing it.`, code: "blocked" });
        continue;
      }
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) writeEvent(res, { type: part.thought ? "reasoning" : "content", text: part.text });
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata; // cumulative: the last one is the total
    }
    if (usage) {
      const thoughts = usage.thoughtsTokenCount ?? 0;
      writeEvent(res, {
        type: "usage",
        // "completion" includes thinking tokens, as the UI expects.
        usage: { prompt: usage.promptTokenCount ?? null, completion: (usage.candidatesTokenCount ?? 0) + thoughts, reasoning: thoughts || null },
      });
    }
    if (!finishReason && !abortCause) {
      // Gemini reports a failure mid-stream (e.g. 503 high demand) as an error event that the SDK
      // drops, so the stream just ends without a finish reason.
      writeEvent(res, { type: "error", message: MID_STREAM_FAILURE, code: "upstream_error" });
    }
    if (BLOCKED_REASONS.has(finishReason)) {
      writeEvent(res, { type: "error", message: `Gemini stopped this response (${finishReason.toLowerCase().replace(/_/g, " ")}). Try rephrasing your message.`, code: "blocked" });
    }
    writeEvent(res, { type: "done", finishReason: finishReason === "MAX_TOKENS" ? "length" : finishReason === "STOP" ? "stop" : finishReason?.toLowerCase() ?? null });
  } catch (err) {
    if (abortCause !== "client") {
      const message =
        abortCause === "idle_timeout"
          ? "The model stopped responding partway through. Try regenerating."
          : abortCause === "max_duration"
            ? `This demo stops a single response after ${Math.round(limitMs / 1000)} seconds. Use Continue to keep going.`
            : abortCause
              ? "The connection to the Gemini API was interrupted."
              : err instanceof ApiError
                ? mapUpstreamError(err).message
                : MID_STREAM_FAILURE; // the SDK fails to parse the error body Gemini sends after the dropped error event
      writeEvent(res, { type: "error", message, code: abortCause ?? (err instanceof ApiError ? mapUpstreamError(err).code : "upstream_error") });
    }
  } finally {
    stopTimers();
    finished = true;
    await release(); // free the slot before ending: the platform may freeze the request after
    res.end();
  }
}

const ROUTES = {
  "GET /api/health": (req, res, url) => health(res, url.searchParams.has("fresh")),
  "GET /api/models": (req, res) => models(res),
  "POST /api/chat": (req, res) => chat(req, res),
};

const KNOWN_PATHS = new Set(Object.keys(ROUTES).map((k) => k.split(" ")[1]));

function logRequest(req, res, path, started) {
  if (process.env.LOG_REQUESTS === "false") return;
  // No headers, bodies, query strings, keys or raw IPs are logged.
  const aborted = res.writableFinished ? "" : " (client disconnected)";
  console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms client=${logId(clientIp(req))}${aborted}`);
}

/** Handles /api/* requests. Returns false if the URL is not an API route. */
export async function handleApi(req, res) {
  const url = new URL(req.originalUrl ?? req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  const started = Date.now();
  res.on("close", () => logRequest(req, res, url.pathname, started));
  const route = `${req.method} ${url.pathname}`;
  try {
    if (req.method !== "GET" && !isSameOrigin(req)) throw new HttpError(403, "Cross-origin requests are not allowed.", "forbidden_origin");
    const handler = ROUTES[route];
    if (!handler) {
      if (KNOWN_PATHS.has(url.pathname)) throw new HttpError(405, "Method not allowed.", "method_not_allowed");
      throw new HttpError(404, "Unknown API route.", "not_found");
    }
    await handler(req, res, url);
  } catch (err) {
    const known = err instanceof HttpError;
    // Unexpected errors are logged server-side only; clients get a generic message.
    if (!known) console.error(`[api] ${route} failed:`, err instanceof Error ? err.stack : String(err));
    const message = known ? err.message : "Unexpected server error.";
    const code = known ? err.code : "server_error";
    if (res.headersSent) {
      if (!res.writableEnded) {
        writeEvent(res, { type: "error", message, code });
        res.end();
      }
    } else {
      sendJson(res, known ? err.status : 500, { error: { message, code } }, (known && err.headers) || {});
    }
  }
  return true;
}
