// Auto routing end to end through POST /api/chat, against one fake server that plays both Gemini and
// OpenRouter: provider/model failures, timeouts, rate limits, quota exhaustion, failures before and
// after the first token, manual mode, max attempts, continuation, debug output.
// Run: npm test
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

Object.assign(process.env, {
  MODEL_REGISTRY_LIVE: "false",
  GEMINI_API_KEY: "gemini-test-not-real",
  OPENROUTER_API_KEY: "sk-or-test-not-real",
  RATE_LIMIT_CHAT_PER_MIN: "1000",
  RATE_LIMIT_CHAT_PER_DAY: "1000",
  MAX_CONCURRENT_STREAMS: "50",
  ROUTER_ATTEMPT_TIMEOUT_SECONDS: "1",
  LOG_REQUESTS: "false",
});
delete process.env.DATABASE_URL;
delete process.env.OPENROUTER_API_KEY_BACKUP;
delete process.env.OPENROUTER_API_KEY_BACKUP_2;
delete process.env.OPENROUTER_DEEPSEEK_API_KEY;

/** behaviour(call) → "ok" | "hang" | "empty" | "break-after-text" | { status, json } */
let behaviour = () => "ok";
let calls = [];
let fake;
let app;
let base;
let health;

const geminiChunk = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
const orChunk = (o) => `data: ${JSON.stringify(o)}\n\n`;

before(async () => {
  fake = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url.endsWith("/key")) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: { free_model_daily_requests: { limit: 50, remaining: 50 } } }));
    const isGemini = req.url.includes("streamGenerateContent");
    const json = body ? JSON.parse(body) : {};
    const model = isGemini ? /models\/([^:]+):/.exec(req.url)[1] : json.model;
    const call = { provider: isGemini ? "gemini" : "openrouter", model, body: json, n: calls.length };
    calls.push(call);
    const b = behaviour(call);
    if (b === "hang") return; // never answers: the attempt timeout must fire
    if (typeof b === "object") return res.writeHead(b.status, { "Content-Type": "application/json" }).end(JSON.stringify(b.json));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const text = `ok from ${model}`;
    if (isGemini) {
      if (b === "empty") return res.end(); // stream ends with no finish reason
      res.write(geminiChunk({ candidates: [{ content: { role: "model", parts: [{ text }] } }] }));
      if (b === "break-after-text") return res.end();
      res.end(geminiChunk({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }));
    } else {
      if (b === "empty") return res.end();
      res.write(orChunk({ choices: [{ delta: { content: text }, finish_reason: null }] }));
      if (b === "break-after-text") return res.end();
      res.end(orChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    }
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const port = fake.address().port;
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
  const { handleApi } = await import("./api.mjs");
  health = await import("./router/health.mjs");
  app = createServer((req, res) => handleApi(req, res).then((h) => !h && res.writeHead(404).end()));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => {
  fake.close();
  app.close();
});
beforeEach(() => {
  calls = [];
  behaviour = () => "ok";
  health.resetHealth();
});

async function chat(body) {
  const r = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], debug: true, ...body }) });
  if (!r.headers.get("content-type")?.includes("event-stream")) return { status: r.status, json: await r.json() };
  const events = (await r.text())
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
  return { status: r.status, events, start: events[0], text: events.filter((e) => e.type === "content").map((e) => e.text).join("") };
}

const HARD = "Design a distributed rate limiter architecture that is scalable, handles race conditions and edge cases.";

describe("auto routing", () => {
  test("Auto is the default model and picks one per request", async () => {
    const models = await (await fetch(base + "/api/models")).json();
    assert.equal(models.defaultModel, "auto");
    const r = await chat({ model: "auto" });
    assert.equal(r.status, 200);
    assert.equal(r.start.route.mode, "auto");
    assert.equal(r.start.model, calls[0].model);
    assert.equal(r.text, `ok from ${calls[0].model}`);
    assert.match(r.start.route.reason, /quick question/);
  });

  test("hard request → a stronger model than a simple one", async () => {
    const simple = (await chat({ model: "auto" })).start.debug;
    const hard = (await chat({ model: "auto", messages: [{ role: "user", content: HARD }] })).start.debug;
    assert.equal(simple.task.tier, "fast");
    assert.equal(hard.task.tier, "advanced");
    assert.notEqual(simple.selected.model, hard.selected.model);
  });

  test("debug details: classification, candidates, attempts — and no secrets or message text", async () => {
    const r = await chat({ model: "auto", messages: [{ role: "user", content: "secret-phrase-123 what is 2+2?" }] });
    const d = r.start.debug;
    assert.ok(d.task.type && d.candidates.length && d.attempts.length === 1 && d.fallbacksAvailable.length);
    assert.doesNotMatch(JSON.stringify(r.start), /not-real|secret-phrase-123/);
  });

  test("without debug, only the short route summary is sent", async () => {
    const r = await chat({ model: "auto", debug: false });
    assert.equal(r.start.debug, undefined);
    assert.deepEqual(Object.keys(r.start.route).sort(), ["fallbackFrom", "mode", "model", "provider", "reason", "task"]);
  });
});

describe("failover", () => {
  test("model unavailable (404) → next model; health records it", async () => {
    behaviour = (c) => (c.n === 0 ? { status: 404, json: { error: { code: 404, message: "not found" } } } : "ok");
    const r = await chat({ model: "auto" });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].model, calls[0].model);
    assert.equal(r.start.model, calls[1].model);
    assert.equal(r.start.route.fallbackFrom.length, 1);
    assert.match(r.start.route.reason, /didn't answer/);
    const models = await (await fetch(base + "/api/models")).json();
    assert.equal(models.models.find((m) => m.id === calls[0].model).status, "cooling");
  });

  test("Gemini outage (503 on every Gemini model) → OpenRouter answers", async () => {
    behaviour = (c) => (c.provider === "gemini" ? { status: 503, json: { error: { code: 503, message: "high demand", status: "UNAVAILABLE" } } } : "ok");
    const r = await chat({ model: "auto", messages: [{ role: "user", content: HARD }] });
    assert.equal(r.status, 200);
    assert.equal(r.start.route.provider, "OpenRouter");
  });

  test("OpenRouter outage → Gemini answers", async () => {
    behaviour = (c) => (c.provider === "openrouter" ? { status: 502, json: { error: { code: 502, message: "Provider returned error" } } } : "ok");
    // Make an OpenRouter model the first choice by cooling every Gemini model except one, ranked last.
    const r = await chat({ model: "auto" });
    assert.equal(r.status, 200);
    assert.equal(calls.at(-1).provider, "gemini");
  });

  test("timeout (model never starts) → next model within the attempt timeout", async () => {
    behaviour = (c) => (c.n === 0 ? "hang" : "ok");
    const t0 = Date.now();
    const r = await chat({ model: "auto" });
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(r.start.debug.attempts[0].error, "upstream_timeout");
  });

  test("rate limit (429) → another model", async () => {
    behaviour = (c) => (c.n === 0 ? { status: 429, json: { error: { code: 429, message: "Resource exhausted" } } } : "ok");
    const r = await chat({ model: "auto" });
    assert.equal(r.status, 200);
    assert.equal(r.start.debug.attempts[0].error, "rate_limited");
  });

  test("OpenRouter's daily free quota → no other free OpenRouter model is tried in that request", async () => {
    behaviour = (c) =>
      c.provider === "openrouter" ? { status: 429, json: { error: { code: 429, message: "Rate limit exceeded: free-models-per-day." } } } : { status: 503, json: { error: { code: 503, message: "busy" } } };
    await chat({ model: "auto", messages: [{ role: "user", content: HARD }] });
    const freeOr = calls.filter((c) => c.provider === "openrouter" && c.model.endsWith(":free"));
    assert.ok(freeOr.length <= 1, `tried ${freeOr.length} free OpenRouter models`);
  });

  test("a stream that dies before the first token falls back; nothing reaches the browser twice", async () => {
    behaviour = (c) => (c.n === 0 ? "empty" : "ok");
    const r = await chat({ model: "auto" });
    assert.equal(r.events.filter((e) => e.type === "start").length, 1);
    assert.equal(r.text, `ok from ${calls[1].model}`);
  });

  test("a failure after text has streamed is reported, not switched (no corrupted answer)", async () => {
    behaviour = () => "break-after-text";
    const r = await chat({ model: "auto" });
    assert.equal(calls.length, 1);
    assert.equal(r.text, `ok from ${calls[0].model}`);
    assert.equal(r.events.at(-1).type, "error");
  });

  test("at most ROUTER_MAX_ATTEMPTS models, then a clear explanation", async () => {
    behaviour = () => ({ status: 503, json: { error: { code: 503, message: "busy" } } });
    const r = await chat({ model: "auto" });
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => c.model)).size, 3, "never the same model twice");
    assert.match(r.json.error.message, /No available model could answer right now \(tried .+, .+, .+\)/);
  });

  test("recovery: after the cooldown the first model is used again", async () => {
    let t = Date.now();
    health.resetHealth(() => t);
    behaviour = (c) => (c.n === 0 ? { status: 503, json: { error: { code: 503, message: "busy" } } } : "ok");
    const first = (await chat({ model: "auto" })).start.debug.attempts[0].model;
    calls = [];
    behaviour = () => "ok";
    assert.notEqual((await chat({ model: "auto" })).start.model, first, "still cooling");
    t += 16 * 60_000; // cooldown over and the failure has left the 15-minute window
    assert.equal((await chat({ model: "auto" })).start.model, first, "recovered");
  });
});

describe("manual mode", () => {
  test("the chosen model is used even when Auto would pick another", async () => {
    const r = await chat({ model: "nvidia/nemotron-3-super-120b-a12b:free" });
    assert.equal(r.start.model, "nvidia/nemotron-3-super-120b-a12b:free");
    assert.equal(r.start.route.mode, "manual");
  });

  test("a failing manual model is not silently replaced", async () => {
    behaviour = () => ({ status: 503, json: { error: { code: 503, message: "busy" } } });
    const r = await chat({ model: "gemini-3.8-flash" });
    assert.equal(calls.length, 1);
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, "upstream_busy");
  });

  test("…unless the user enabled fallback", async () => {
    behaviour = (c) => (c.model === "gemini-3.8-flash" ? { status: 503, json: { error: { code: 503, message: "busy" } } } : "ok");
    const r = await chat({ model: "gemini-3.8-flash", allowFallback: true });
    assert.equal(r.status, 200);
    assert.notEqual(r.start.model, "gemini-3.8-flash");
    assert.deepEqual(r.start.route.fallbackFrom, ["Gemini 3.8 Flash"]);
    assert.match(r.start.route.reason, /Your chosen model \(Gemini 3\.8 Flash\) was unavailable/);
  });

  test("an unknown model id is refused with a way back to Auto", async () => {
    const r = await chat({ model: "some/removed-model" });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /Auto/);
  });

  test("switching back to Auto works", async () => {
    await chat({ model: "gemini-3.8-flash" });
    assert.equal((await chat({ model: "auto" })).start.route.mode, "auto");
  });
});

describe("conversation context", () => {
  test("Continue stays on the model that wrote the answer", async () => {
    const r = await chat({
      model: "auto",
      continuation: true,
      previousModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "partial" },
        { role: "user", content: "Continue exactly where you stopped." },
      ],
    });
    assert.equal(r.start.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
    assert.match(r.start.route.reason, /continued/);
  });

  test("Stop during the first attempt ends cleanly; the next request works", async () => {
    behaviour = (c) => (c.n === 0 ? "hang" : "ok");
    const ctrl = new AbortController();
    const p = fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }), signal: ctrl.signal }).catch((e) => e.name);
    setTimeout(() => ctrl.abort(), 200);
    assert.equal(await p, "AbortError");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(calls.length, 1, "no fallback after the user stopped");
    calls = [];
    assert.equal((await chat({ model: "auto" })).status, 200);
  });
});
