// Server-side API layer — the only code that sees NVIDIA_API_KEY.
// Runs as Vite middleware (dev and `vite preview`, see vite.config.ts) and as Vercel
// functions (api/*.mjs). HiveMind is a public demo: there is no sign-in; abuse protection is
// rate limiting (server/limits.mjs), request limits and validation.
//
// Routes:
//   GET  /api/health  -> { status: "ok" | "missing_key" | "auth_failed" | "unreachable", message } (?fresh: at most every 5s)
//   GET  /api/models  -> { models, defaultModel, limits }
//   POST /api/chat    -> text/event-stream of normalized events (see docs/API.md)

import { waitUntil } from "@vercel/functions";
import { clientIp, isSameOrigin, logId } from "./http.mjs";
import { acquireChat, LimitError, limitScope } from "./limits.mjs";
import { MODELS, findModel, defaultModelId } from "./models.mjs";
import { modelOutputLimit, outputCap, parseLimitFromError, planMaxTokens } from "./tokens.mjs";

// How long NIM may queue a request before sending response headers. DeepSeek was measured
// queuing 24s+ (and >45s from Vercel), so the default is generous; it is always capped below
// the stream limit so a queued request can still produce an answer.
function headersTimeoutMs() {
  const s = Number(process.env.UPSTREAM_QUEUE_TIMEOUT_SECONDS);
  const wanted = Number.isFinite(s) && s > 0 ? s * 1000 : 120_000;
  return Math.min(wanted, streamLimitMs() - 30_000);
}
const IDLE_TIMEOUT_MS = 60_000; // max silence between streamed chunks
const HEALTH_TTL_MS = 60_000;
const HEALTH_FRESH_MIN_MS = 5_000; // "Re-check" can't be used to hammer NVIDIA's /models
const MAX_BODY_BYTES = 2_000_000;
const MAX_MESSAGES = 200;
const MAX_TOTAL_CHARS = 600_000;
const MAX_SYSTEM_CHARS = 8_000;

/**
 * Longest a single response may stream. On Vercel the function is killed at its maxDuration
 * (FUNCTION_MAX_DURATION, seconds; must match vercel.json), so the stream ends cleanly a little
 * before that with a "time limit" event the UI can offer to continue from.
 */
export function streamLimitMs() {
  const explicit = Number(process.env.STREAM_LIMIT_SECONDS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit * 1000;
  if (process.env.VERCEL === "1") return (Number(process.env.FUNCTION_MAX_DURATION) || 300) * 1000 - 15_000;
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
    key: process.env.NVIDIA_API_KEY?.trim() || "",
    base: (process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
  };
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

function parseUpstreamDetail(text) {
  try {
    const j = JSON.parse(text);
    return String(j.detail || j.message || j.error?.message || j.title || "").slice(0, 300);
  } catch {
    return text.trim().slice(0, 300);
  }
}

function mapUpstreamError(status, text) {
  const detail = parseUpstreamDetail(text);
  if (status === 401 || status === 403) return new HttpError(502, "NVIDIA rejected the server's API key. The site owner needs to check NVIDIA_API_KEY.", "auth_failed");
  if (status === 404) return new HttpError(502, "This model isn't available on NVIDIA's API right now. Pick another model.", "model_unavailable");
  if (status === 429) return new HttpError(429, "NVIDIA's rate limit was reached. Wait a moment and try again.", "rate_limited");
  if (status >= 400 && status < 500) return new HttpError(400, `The model rejected the request${detail ? `: ${detail}` : "."}`, "invalid_request");
  return new HttpError(502, `NVIDIA's API returned an error (${status}). Try again shortly.`, "upstream_error");
}

let healthCache = null;

async function health(res, fresh) {
  const { key, base } = config();
  if (!key) return sendJson(res, 200, { status: "missing_key", message: "NVIDIA_API_KEY is not set on the server." });
  const age = healthCache ? Date.now() - healthCache.at : Infinity;
  if (age < (fresh ? HEALTH_FRESH_MIN_MS : HEALTH_TTL_MS)) return sendJson(res, 200, healthCache.body);

  let body;
  try {
    const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) body = { status: "ok", message: "Connected to NVIDIA NIM." };
    else if (r.status === 401 || r.status === 403) body = { status: "auth_failed", message: "NVIDIA rejected the server's API key." };
    else body = { status: "unreachable", message: `NVIDIA API responded with ${r.status}.` };
  } catch {
    body = { status: "unreachable", message: "Could not reach NVIDIA's API." };
  }
  healthCache = { at: Date.now(), body };
  // Which deployment answered (non-secret; helps verify rollouts).
  sendJson(res, 200, { ...body, deployment: process.env.VERCEL_DEPLOYMENT_ID?.slice(-8) ?? "local" });
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
  const { key, base } = config();
  if (!key) throw new HttpError(503, "The server has no NVIDIA_API_KEY configured.", "missing_key");

  let release;
  try {
    release = await acquireChat(clientIp(req));
  } catch (err) {
    if (err instanceof LimitError) throw new HttpError(429, err.message, err.code, retryAfterHeader(err.retryAfterMs));
    throw err;
  }
  // On a client disconnect (Stop, closed tab) try to free the slot immediately. Vercel may still
  // cancel the function before this completes (observed); the slot's short lease covers that case.
  res.on("close", () => {
    if (!res.writableFinished) waitUntil(release());
  });
  try {
    await streamCompletion(req, res, key, base, release);
  } finally {
    await release(); // idempotent; covers errors thrown before streaming started
  }
}

async function streamCompletion(req, res, key, base, release) {
  const body = await readJson(req);
  const model = findModel(body.model);
  if (!model) throw new HttpError(400, "Unknown model. Pick one from the model menu.", "invalid_model");

  const messages = validateMessages(body.messages);
  const system = typeof body.system === "string" ? body.system.trim().slice(0, MAX_SYSTEM_CHARS) : "";
  if (system) messages.unshift({ role: "system", content: system });
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);

  const maxTokens = planMaxTokens(model, body.maxTokens, promptChars);
  if (maxTokens < 256) throw new HttpError(413, "This conversation fills the model's context window. Start a new chat or pick a model with a larger context.", "too_long");

  const payload = {
    model: model.id,
    messages,
    temperature: clamp(body.temperature, 0, 2, 0.6),
    top_p: clamp(body.topP, 0.01, 1, 0.95),
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (model.reasoning === "toggle" && body.thinking === false) payload.chat_template_kwargs = model.thinkingKwargs;

  const limitMs = streamLimitMs();
  const upstream = new AbortController();
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

  const request = () =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal: upstream.signal,
    });

  let response;
  try {
    response = await request();
    // If NVIDIA rejects max_tokens anyway (e.g. a context limit we couldn't predict), retry once
    // with the ceiling it reports instead of failing the user's request.
    if (response.status === 400) {
      const text = await response.text().catch(() => "");
      const lower = parseLimitFromError(text, payload.max_tokens);
      if (lower) {
        payload.max_tokens = lower;
        response = await request();
      } else {
        response = new Response(text, { status: 400 });
      }
    }
  } catch {
    stopTimers();
    if (abortCause === "client") return;
    if (abortCause === "headers_timeout") {
      throw new HttpError(504, `NVIDIA queued ${model.label} for over ${Math.round(queueMs / 1000)}s without starting. It's busy right now; try again or pick another model.`, "upstream_timeout");
    }
    throw new HttpError(502, "Could not reach NVIDIA's API. Try again shortly.", "upstream_unreachable");
  }
  if (!response.ok) {
    stopTimers();
    throw mapUpstreamError(response.status, await response.text().catch(() => ""));
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeEvent(res, { type: "start", model: model.id, maxTokens: payload.max_tokens, limitSeconds: Math.floor(limitMs / 1000) });

  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort("idle_timeout"), IDLE_TIMEOUT_MS);
  };
  resetIdle();

  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason = null;
  try {
    for await (const chunk of response.body) {
      resetIdle();
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) {
          writeEvent(res, { type: "error", message: parseUpstreamDetail(JSON.stringify(json.error)) || "The model returned an error.", code: "upstream_error" });
          continue;
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) writeEvent(res, { type: "reasoning", text: reasoning });
        if (delta.content) writeEvent(res, { type: "content", text: delta.content });
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (json.usage) {
          writeEvent(res, {
            type: "usage",
            usage: {
              prompt: json.usage.prompt_tokens ?? null,
              completion: json.usage.completion_tokens ?? null,
              reasoning: json.usage.completion_tokens_details?.reasoning_tokens ?? null,
            },
          });
        }
      }
    }
    writeEvent(res, { type: "done", finishReason });
  } catch {
    if (abortCause !== "client") {
      const message =
        abortCause === "idle_timeout"
          ? "The model stopped responding partway through. Try regenerating."
          : abortCause === "max_duration"
            ? `This demo stops a single response after ${Math.round(limitMs / 1000)} seconds. Use Continue to keep going.`
            : "The connection to NVIDIA's API was interrupted.";
      writeEvent(res, { type: "error", message, code: abortCause ?? "stream_interrupted" });
    }
  } finally {
    stopTimers();
    finished = true;
    await release(); // free the slot before ending: the platform may freeze the function after
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
  const url = new URL(req.url ?? "/", "http://localhost");
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
