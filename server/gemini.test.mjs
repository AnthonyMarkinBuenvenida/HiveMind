// Streaming against a fake Gemini API (no network, no real key): request mapping, thought/answer
// separation, finish reasons, usage, the one-shot 400 retries, and error mapping.
// Run: npm test
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

Object.assign(process.env, { GEMINI_API_KEY: "test-key-not-real", RATE_LIMIT_CHAT_PER_MIN: "1000", LOG_REQUESTS: "false" });
delete process.env.DATABASE_URL;

/** Fake upstream. `reply(call)` returns { status, json } or { sse: [chunk, …], raw?: trailing text }. */
let reply = () => ({ sse: [] });
let calls = [];
let fake;
let app;
let base;

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
const done = { candidates: [{ finishReason: "STOP" }] };
const text = (t, thought = false) => ({ candidates: [{ content: { role: "model", parts: [{ text: t, ...(thought ? { thought: true } : {}) }] } }] });

before(async () => {
  fake = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const call = { method: req.method, path: req.url, key: req.headers["x-goog-api-key"], body: body ? JSON.parse(body) : null };
    calls.push(call);
    const r = reply(call);
    if (r.sse) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(r.sse) + (r.raw ?? ""));
    } else {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json));
    }
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${fake.address().port}`;

  const { handleApi } = await import("./api.mjs");
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
});

async function chat(body) {
  const r = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.headers.get("content-type")?.includes("event-stream")) return { status: r.status, json: await r.json() };
  const events = (await r.text())
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
  return { status: r.status, events };
}

const ask = (extra = {}) => ({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }], ...extra });

describe("chat against the Gemini API", () => {
  test("maps the request: roles, system prompt, sampling, output limit, thoughts", async () => {
    reply = () => ({ sse: [text("ok"), { candidates: [{ finishReason: "STOP" }] }] });
    await chat(
      ask({
        system: "Be brief.",
        temperature: 0.3,
        topP: 0.9,
        maxTokens: 1000,
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "" }, // stopped before any text: dropped
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ],
      }),
    );
    assert.equal(calls.length, 1);
    const { path, key, body } = calls[0];
    assert.match(path, /\/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse/);
    assert.equal(key, "test-key-not-real");
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "a" }] },
      { role: "model", parts: [{ text: "b" }] },
      { role: "user", parts: [{ text: "c" }] },
    ]);
    assert.deepEqual(body.systemInstruction.parts, [{ text: "Be brief." }]);
    const g = body.generationConfig;
    assert.equal(g.temperature, 0.3);
    assert.equal(g.topP, 0.9);
    assert.equal(g.maxOutputTokens, 1000);
    assert.deepEqual(g.thinkingConfig, { includeThoughts: true }); // "always" model: no level sent
  });

  test("streams thoughts as reasoning, text as content, then usage and done", async () => {
    reply = () => ({
      sse: [
        text("Let me think.", true),
        text("Hello"),
        { ...text(" world"), usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 7 } },
        { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 7 } },
      ],
    });
    const { status, events } = await chat(ask({ maxTokens: 1000 }));
    assert.equal(status, 200);
    assert.deepEqual(events, [
      { type: "start", model: "gemini-3.8-flash", maxTokens: 1000, limitSeconds: 600 },
      { type: "reasoning", text: "Let me think." },
      { type: "content", text: "Hello" },
      { type: "content", text: " world" },
      { type: "usage", usage: { prompt: 5, completion: 10, reasoning: 7 } },
      { type: "done", finishReason: "stop" },
    ]);
  });

  test("MAX_TOKENS is reported as length (the UI offers Continue)", async () => {
    reply = () => ({ sse: [{ ...text("partial"), candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] }] });
    const { events } = await chat(ask());
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "length" });
  });

  test("a safety stop becomes a readable error", async () => {
    reply = () => ({ sse: [{ candidates: [{ finishReason: "SAFETY" }] }] });
    const { events } = await chat(ask());
    const err = events.find((e) => e.type === "error");
    assert.equal(err.code, "blocked");
    assert.match(err.message, /safety/);
  });

  test("a mid-stream failure (high demand) is reported, not mistaken for a network error", async () => {
    const busy = { error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } };
    // As observed live: the error event, then a raw JSON body the SDK can't parse.
    reply = () => ({ sse: [text("partial"), busy], raw: JSON.stringify(busy, null, 2) });
    let { events } = await chat(ask());
    assert.deepEqual(events.at(-1), { type: "error", message: events.at(-1).message, code: "upstream_error" });
    assert.match(events.at(-1).message, /high demand/);
    // The error event alone: the stream just ends without a finish reason.
    reply = () => ({ sse: [text("partial"), busy] });
    ({ events } = await chat(ask()));
    const err = events.find((e) => e.type === "error");
    assert.match(err.message, /high demand/);
  });

  test("a 503 before streaming is reported as high demand", async () => {
    reply = () => ({ status: 503, json: { error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } } });
    const res = await chat(ask());
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "upstream_busy");
  });

  test("thinking toggle sends the model's on/off level", async () => {
    reply = () => ({ sse: [text("ok"), done] });
    await chat(ask({ model: "gemini-3.5-flash-lite", thinking: false }));
    await chat(ask({ model: "gemini-3.5-flash-lite", thinking: true }));
    assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingLevel.toLowerCase(), "minimal");
    assert.equal(calls[1].body.generationConfig.thinkingConfig.thinkingLevel.toLowerCase(), "medium");
  });

  test("a rejected thinking level is retried once without it", async () => {
    reply = (c) =>
      c.body.generationConfig.thinkingConfig.thinkingLevel
        ? { status: 400, json: { error: { code: 400, message: "Thinking level MINIMAL is not supported for this model.", status: "INVALID_ARGUMENT" } } }
        : { sse: [text("ok"), done] };
    const { status, events } = await chat(ask({ model: "gemini-3.1-flash-lite", thinking: false }));
    assert.equal(status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.generationConfig.thinkingConfig.thinkingLevel, undefined);
    assert.ok(events.some((e) => e.type === "content" && e.text === "ok"));
  });

  test("a lower output ceiling in the error is retried once", async () => {
    reply = (c) =>
      c.body.generationConfig.maxOutputTokens > 32_768
        ? { status: 400, json: { error: { code: 400, message: "Unable to submit request because it has a maxOutputTokens value of 50000 but the supported range is from 1 (inclusive) to 32769 (exclusive).", status: "INVALID_ARGUMENT" } } }
        : { sse: [text("ok"), done] };
    const { events } = await chat(ask({ maxTokens: 50_000 }));
    assert.equal(calls.length, 2);
    assert.equal(events[0].maxTokens, 32_768);
  });

  test("upstream errors are mapped without leaking the key", async () => {
    const cases = [
      [{ status: 400, json: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } } }, 502, "auth_failed"],
      [{ status: 429, json: { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } } }, 429, "rate_limited"],
      [{ status: 404, json: { error: { code: 404, message: "models/x is not found", status: "NOT_FOUND" } } }, 502, "model_unavailable"],
      [{ status: 400, json: { error: { code: 400, message: "Bad thing", status: "INVALID_ARGUMENT" } } }, 400, "invalid_request"],
    ];
    for (const [r, status, code] of cases) {
      reply = () => r;
      const res = await chat(ask());
      assert.equal(res.status, status, code);
      assert.equal(res.json.error.code, code);
      assert.doesNotMatch(JSON.stringify(res.json), /test-key-not-real/);
    }
  });

  test("health checks the key with a real models call", async () => {
    reply = () => ({ status: 200, json: { name: "models/gemini-3.8-flash" } });
    const r = await (await fetch(base + "/api/health?fresh")).json();
    assert.equal(r.status, "ok");
    assert.match(calls[0].path, /\/models\/gemini-3\.8-flash/);
  });
});
