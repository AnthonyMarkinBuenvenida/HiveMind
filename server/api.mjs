// Server-side API layer — the only code that sees the provider keys (GEMINI_API_KEY, OPENROUTER_API_KEY).
// Runs inside server.ts (Express: local dev, Google AI Studio, Cloud Run) and as Vercel
// functions (api/*.mjs). HiveMind is a public demo: there is no sign-in; abuse protection is
// rate limiting (server/limits.mjs), request limits and validation.
// Provider specifics (request format, stream parsing) live in server/providers/.
//
// Routes:
//   GET  /api/health  -> { status: "ok" | "missing_key" | "auth_failed" | "unreachable", message, providers } (?fresh: at most every 5s)
//   GET  /api/models  -> { models, defaultModel, limits }
//   POST /api/chat    -> text/event-stream of normalized events (see docs/API.md)

import { waitUntil } from "@vercel/functions";
import { clientIp, isSameOrigin, logId } from "./http.mjs";
import { acquireChat, LimitError, limitScope } from "./limits.mjs";
import { MODELS, findModel, defaultModelId } from "./models.mjs";
import { geminiProvider } from "./providers/gemini.mjs";
import { openrouterProvider } from "./providers/openrouter.mjs";
import { UpstreamError } from "./providers/upstream.mjs";
import { modelOutputLimit, outputCap, planMaxTokens } from "./tokens.mjs";

const PROVIDERS = { gemini: geminiProvider, openrouter: openrouterProvider };

// How long a provider may take to start streaming (send response headers). OpenRouter's free models
// can queue; the wait is always capped below the stream limit so a slow start can still produce an answer.
function headersTimeoutMs() {
  const s = Number(process.env.UPSTREAM_QUEUE_TIMEOUT_SECONDS);
  const wanted = Number.isFinite(s) && s > 0 ? s * 1000 : 120_000;
  return Math.min(wanted, streamLimitMs() - 30_000);
}
const IDLE_TIMEOUT_MS = 60_000; // max silence between streamed chunks
const HEALTH_TTL_MS = 60_000;
const HEALTH_FRESH_MIN_MS = 5_000; // "Re-check" can't be used to hammer the providers
const MAX_BODY_BYTES = 2_000_000;
const MAX_MESSAGES = 200;
const MAX_TOTAL_CHARS = 600_000;
const MAX_SYSTEM_CHARS = 8_000;

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

/** Models whose provider has a key; every model when none is configured (health then reports missing_key). */
function availableModels() {
  const ready = MODELS.filter((m) => PROVIDERS[m.provider].configured());
  return ready.length ? ready : MODELS;
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

function isAuthError({ status, detail }) {
  // Gemini answers an invalid key with 400 INVALID_ARGUMENT "API key not valid", OpenRouter with 401.
  return status === 401 || ((status === 400 || status === 403) && /api[ _-]?key|unauthori[sz]ed|permission/i.test(detail));
}

function midStreamMessage(provider) {
  return `${provider.label} stopped partway through, usually because the model is busy. Try regenerating or pick another model.`;
}

/** UpstreamError (or anything else thrown while talking to a provider) -> user-readable HttpError. */
function mapUpstreamError(err, provider) {
  if (!(err instanceof UpstreamError)) return new HttpError(502, `Could not reach ${provider.label}. Try again shortly.`, "upstream_unreachable");
  const { status, detail } = err;
  if (err.kind === "midstream") return new HttpError(502, midStreamMessage(provider), "upstream_error");
  if (isAuthError(err)) return new HttpError(502, `${provider.vendor} rejected the server's API key. The site owner needs to check ${provider.keyEnv}.`, "auth_failed");
  if (status === 402) return new HttpError(402, `${provider.label} needs credits for this request. Pick another model.`, "payment_required");
  if (status === 404) return new HttpError(502, `This model isn't available on ${provider.label} right now. Pick another model.`, "model_unavailable");
  if (status === 429) return new HttpError(429, `${provider.label}'s rate limit or daily quota was reached${detail ? ` (${detail})` : ""}. Wait a moment or pick another model.`, "rate_limited");
  if (status >= 400 && status < 500) return new HttpError(400, `The model rejected the request${detail ? `: ${detail}` : "."}`, "invalid_request");
  if (status === 503) return new HttpError(503, `${provider.label} is under high demand right now. Try again in a moment or pick another model.`, "upstream_busy");
  return new HttpError(502, `${provider.label} returned an error (${status}). Try again shortly.`, "upstream_error");
}

let healthCache = null;

const HEALTH_RANK = { ok: 0, unreachable: 1, auth_failed: 2 };

async function checkProvider(provider) {
  const model = MODELS.find((m) => m.provider === provider.id);
  try {
    await provider.check(model.id, AbortSignal.timeout(10_000));
    return { status: "ok", message: `Connected to ${provider.label}.` };
  } catch (err) {
    if (err instanceof UpstreamError && isAuthError(err)) return { status: "auth_failed", message: `${provider.vendor} rejected ${provider.keyEnv}.` };
    if (err instanceof UpstreamError && err.status) return { status: "unreachable", message: `${provider.label} responded with ${err.status}.` };
    return { status: "unreachable", message: `Could not reach ${provider.label}.` };
  }
}

async function health(res, fresh) {
  const configured = Object.values(PROVIDERS).filter((p) => p.configured());
  if (!configured.length) {
    const keys = Object.values(PROVIDERS).map((p) => p.keyEnv).join(" or ");
    return sendJson(res, 200, { status: "missing_key", message: `No API key is set on the server (${keys}).`, providers: {} });
  }
  const age = healthCache ? Date.now() - healthCache.at : Infinity;
  if (age < (fresh ? HEALTH_FRESH_MIN_MS : HEALTH_TTL_MS)) return sendJson(res, 200, healthCache.body);

  const results = await Promise.all(configured.map(async (p) => [p, await checkProvider(p)]));
  const worst = results.reduce((a, b) => (HEALTH_RANK[b[1].status] > HEALTH_RANK[a[1].status] ? b : a));
  const status = worst[1].status;
  const message = status === "ok" ? `Connected to ${configured.map((p) => p.label).join(" and ")}.` : results.map(([, r]) => r.message).join(" ");
  // Which deployment answered (non-secret; helps verify rollouts).
  const deployment = process.env.VERCEL_DEPLOYMENT_ID?.slice(-8) ?? process.env.K_REVISION ?? "local";
  const body = { status, message, providers: Object.fromEntries(results.map(([p, r]) => [p.id, r.status])), deployment };
  healthCache = { at: Date.now(), body };
  sendJson(res, 200, body);
}

function models(res) {
  const list = availableModels();
  sendJson(res, 200, {
    defaultModel: defaultModelId(list),
    models: list.map((m) => ({
      id: m.id,
      label: m.label,
      vendor: m.vendor,
      provider: PROVIDERS[m.provider].label,
      description: m.description,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxOutput: modelOutputLimit(m),
    })),
    limits: { outputCap: outputCap(), streamSeconds: Math.floor(streamLimitMs() / 1000), rateLimitScope: limitScope() },
  });
}

async function chat(req, res) {
  if (!Object.values(PROVIDERS).some((p) => p.configured())) throw new HttpError(503, "The server has no API key configured.", "missing_key");

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
    await streamCompletion(req, res, release);
  } finally {
    await release(); // idempotent; covers errors thrown before streaming started
  }
}

async function streamCompletion(req, res, release) {
  const body = await readJson(req);
  const model = findModel(body.model, availableModels());
  if (!model) throw new HttpError(400, "Unknown model. Pick one from the model menu.", "invalid_model");
  const provider = PROVIDERS[model.provider];
  if (!provider.configured()) throw new HttpError(503, `The server has no ${provider.keyEnv} configured.`, "missing_key");

  const messages = validateMessages(body.messages);
  const system = typeof body.system === "string" ? body.system.trim().slice(0, MAX_SYSTEM_CHARS) : "";
  const promptChars = system.length + messages.reduce((n, m) => n + m.content.length, 0);

  const maxTokens = planMaxTokens(model, body.maxTokens, promptChars);
  if (maxTokens < 256) throw new HttpError(413, "This conversation fills the model's context window. Start a new chat or pick a model with a larger context.", "too_long");

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

  let reply;
  try {
    reply = await provider.open({
      model,
      messages,
      system,
      temperature: clamp(body.temperature, 0, 2, 0.6),
      topP: clamp(body.topP, 0.01, 1, 0.95),
      maxTokens,
      thinking: body.thinking,
      signal: upstream.signal,
    });
  } catch (err) {
    stopTimers();
    if (abortCause === "client") return;
    if (abortCause === "headers_timeout") {
      throw new HttpError(504, `${model.label} didn't start responding within ${Math.round(queueMs / 1000)}s. It's busy right now; try again or pick another model.`, "upstream_timeout");
    }
    throw mapUpstreamError(err, provider);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeEvent(res, { type: "start", model: model.id, maxTokens: reply.maxTokens, limitSeconds: Math.floor(limitMs / 1000) });

  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort("idle_timeout"), IDLE_TIMEOUT_MS);
  };
  resetIdle();

  let finishReason = null;
  try {
    for await (const event of reply.events) {
      resetIdle();
      if (event.type === "finish") finishReason = event.reason;
      else if (event.type !== "alive") writeEvent(res, event);
    }
    writeEvent(res, { type: "done", finishReason });
  } catch (err) {
    if (abortCause !== "client") {
      let message;
      let code = abortCause;
      if (abortCause === "idle_timeout") message = "The model stopped responding partway through. Try regenerating.";
      else if (abortCause === "max_duration") message = `This demo stops a single response after ${Math.round(limitMs / 1000)} seconds. Use Continue to keep going.`;
      else if (abortCause) message = `The connection to ${provider.label} was interrupted.`;
      else if (err instanceof UpstreamError) ({ message, code } = mapUpstreamError(err, provider));
      else {
        message = midStreamMessage(provider);
        code = "upstream_error";
      }
      writeEvent(res, { type: "error", message, code });
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
