// OpenRouter backup key (OPENROUTER_API_KEY_BACKUP) against a fake OpenRouter API: which failures
// switch keys, which don't, and health with one key rejected. Separate file: key benching is
// per-process state.
// Run: npm test
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const MAIN = "sk-or-main-test";
const BACKUP = "sk-or-backup-test";
const BACKUP_2 = "sk-or-backup-2-test";
Object.assign(process.env, { MODEL_REGISTRY_LIVE: "false", OPENROUTER_API_KEY: MAIN, OPENROUTER_API_KEY_BACKUP: BACKUP, OPENROUTER_API_KEY_BACKUP_2: BACKUP_2, RATE_LIMIT_CHAT_PER_MIN: "1000", LOG_REQUESTS: "false" });
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.DATABASE_URL;

/** `reply(key, path)` returns { status, json } or "ok" (a short successful stream). */
let reply = () => "ok";
let calls = [];
let fake;
let app;
let base;

const MODEL = "qwen/qwen3.8-27b:free";
const keyLimit = { status: 429, json: { error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", code: 429 } } };
const upstreamLimit = { status: 429, json: { error: { message: "Provider returned error", code: 429, metadata: { raw: `${MODEL} is temporarily rate-limited upstream.` } } } };
const rejected = { status: 401, json: { error: { message: "User not found.", code: 401 } } };

before(async () => {
  fake = createServer(async (req, res) => {
    for await (const _ of req);
    const key = String(req.headers.authorization).replace("Bearer ", "");
    calls.push(key);
    const r = reply(key, req.url);
    if (r === "ok") {
      res.writeHead(200, { "Content-Type": req.url.endsWith("/key") ? "application/json" : "text/event-stream" });
      if (req.url.endsWith("/key")) return res.end('{"data":{}}');
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.json));
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${fake.address().port}/api/v1`;
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

async function chat(model = MODEL) {
  const r = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
  return r.headers.get("content-type")?.includes("event-stream") ? { status: r.status, text: await r.text() } : { status: r.status, json: await r.json() };
}

// Order matters: a key that fails for a key-specific reason is benched (tried last) for 5 minutes.
test("the main key is used while it works", async () => {
  reply = () => "ok";
  assert.equal((await chat()).status, 200);
  assert.deepEqual(calls, [MAIN]);
});

test("an upstream rate limit is not retried with the backup (every key gets it)", async () => {
  reply = () => upstreamLimit;
  const r = await chat();
  assert.equal(r.status, 429);
  assert.deepEqual(calls, [MAIN]);
});

test("the main key's own daily limit switches to the backup", async () => {
  reply = (key) => (key === MAIN ? keyLimit : "ok");
  const r = await chat();
  assert.equal(r.status, 200);
  assert.match(r.text, /"type":"content","text":"ok"/);
  assert.deepEqual(calls, [MAIN, BACKUP]);
});

test("after that, the backup is tried first", async () => {
  reply = () => "ok";
  assert.equal((await chat()).status, 200);
  assert.deepEqual(calls, [BACKUP]);
});

test("when every key fails, the last error is reported", async () => {
  reply = () => rejected;
  const r = await chat();
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "auth_failed");
  assert.deepEqual(calls.sort(), [BACKUP, BACKUP_2, MAIN].sort());
  assert.doesNotMatch(JSON.stringify(r.json), /sk-or-/);
});

test("health stays ok with one rejected key, and says which", async () => {
  reply = (key) => (key === BACKUP ? rejected : "ok");
  const h = await (await fetch(base + "/api/health?fresh")).json();
  assert.equal(h.status, "ok");
  assert.match(h.message, /backup key was rejected/);
  reply = () => rejected;
  await new Promise((r) => setTimeout(r, 5_100)); // ?fresh is honoured at most every 5 s
  const down = await (await fetch(base + "/api/health?fresh")).json();
  assert.equal(down.status, "auth_failed");
});
