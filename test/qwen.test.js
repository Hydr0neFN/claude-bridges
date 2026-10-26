import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ENGINE_NAMES, parseSpec, runSpec, inTradingHours, resolveQwenKey, qwenBase, qwenAvailable, ENGINES } from "../lib/engines.js";
import { parseOrderDetailed } from "../lib/args.js";

const KEY = "lab-" + "k".repeat(12);
const IN_WINDOW = Date.parse("2026-10-26T15:00:00Z"); // Monday 11:00 EDT
const OUTSIDE = Date.parse("2026-10-26T22:00:00Z"); // Monday 18:00 EDT
const env = { QWEN_API_KEY: KEY, QWEN_BASE: "http://gate.test:8097/" };

/** fetch stub: GET /v1/models -> served model, POST chat -> SSE-less JSON reply (or `chat` override). */
function fakeFetch({ model = "qwen36-test", chat } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 });
    if (chat) return chat();
    return new Response(JSON.stringify({ choices: [{ message: { content: "local answer" }, finish_reason: "stop" }] }), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

test("qwen is a known engine without a per-call model", () => {
  assert.ok(ENGINE_NAMES.includes("qwen"));
  assert.deepEqual(parseOrderDetailed("copilot,qwen").order, ["copilot", "qwen"]);
  assert.deepEqual(parseOrderDetailed("qwen:x").dropped, ["qwen:x"]);
  assert.equal(parseSpec("qwen").engine, "qwen");
});

test("inTradingHours: weekday 07:30-16:45 New York, end exclusive, weekends never", () => {
  const t = (iso) => inTradingHours(Date.parse(iso));
  assert.equal(t("2026-10-26T11:29:00Z"), false); // 07:29 EDT
  assert.equal(t("2026-10-26T11:30:00Z"), true);
  assert.equal(t("2026-10-26T20:44:00Z"), true); // 16:44 EDT
  assert.equal(t("2026-10-26T20:45:00Z"), false);
  assert.equal(t("2026-10-24T15:00:00Z"), false); // Saturday
  assert.equal(t("2026-11-02T12:30:00Z"), true); // EST after the clock change: 07:30
  assert.equal(t("2026-11-02T12:29:00Z"), false);
});

test("inside the window: skipped: trading hours, no request made", async () => {
  const f = fakeFetch();
  const r = await runSpec("qwen", { prompt: "q", cwd: ".", timeoutSec: 5, env, fetchImpl: f, now: IN_WINDOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "skipped: trading hours");
  assert.equal(f.calls.length, 0);
});

test("outside the window: asks the served model and labels the result with it", async () => {
  const f = fakeFetch({ model: "gpt-oss-20b" });
  const r = await ENGINES.qwen({ prompt: "hello", timeoutSec: 5, env, fetchImpl: f, now: OUTSIDE });
  assert.equal(r.ok, true);
  assert.equal(r.engine, "qwen:gpt-oss-20b");
  assert.equal(r.body, "local answer");
  const post = f.calls.find((c) => c.init.method === "POST");
  assert.equal(post.url, "http://gate.test:8097/v1/chat/completions");
  assert.equal(JSON.parse(post.init.body).model, "gpt-oss-20b");
  assert.equal(post.init.headers.Authorization, `Bearer ${KEY}`);
});

test("gate 503 (busy) is reported as skipped, and the key never appears in a reason", async () => {
  const f = fakeFetch({ chat: () => new Response('{"error":"busy: dowtrade"}', { status: 503 }) });
  const r = await ENGINES.qwen({ prompt: "q", timeoutSec: 5, env, fetchImpl: f, now: OUTSIDE });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^skipped: gate busy \(HTTP 503/);
  assert.ok(!r.reason.includes(KEY));
});

test("no key: fails soft naming where the key lives", async () => {
  const r = await ENGINES.qwen({ prompt: "q", timeoutSec: 5, env: {}, home: "/nohome", readFile: () => { throw new Error("ENOENT"); }, fetchImpl: fakeFetch(), now: OUTSIDE });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^no key/);
});

test("key and base resolution: env > QWEN_KEY_PATH > FW13_LLM_KEY_FILE (~ expanded) > default file", () => {
  const files = { "/k/q": " a \n", [path.join("/h", "k2")]: "b\n", [path.join("/h", ".config", "fw13", "lab.key")]: "c\n" };
  const readFile = (p) => { if (p in files) return files[p]; throw new Error("ENOENT"); };
  assert.equal(resolveQwenKey({ env: { QWEN_API_KEY: " e " }, readFile }), "e");
  assert.equal(resolveQwenKey({ env: { QWEN_KEY_PATH: "/k/q" }, home: "/h", readFile }), "a");
  assert.equal(resolveQwenKey({ env: { FW13_LLM_KEY_FILE: "~/k2" }, home: "/h", readFile }), "b");
  assert.equal(resolveQwenKey({ env: {}, home: "/h", readFile }), "c");
  assert.equal(resolveQwenKey({ env: {}, home: "/x", readFile }), "");
  assert.equal(qwenBase({ FW13_LLM_URL: "http://x:1/" }), "http://x:1");
  assert.equal(qwenBase({}), "http://100.119.161.52:8097");
});

test("qwenAvailable: false inside the window or without a key", () => {
  const readFile = () => KEY;
  assert.equal(qwenAvailable({ now: IN_WINDOW, env: {}, readFile }), false);
  assert.equal(qwenAvailable({ now: OUTSIDE, env: {}, readFile }), true);
  assert.equal(qwenAvailable({ now: OUTSIDE, env: {}, readFile: () => { throw new Error("x"); } }), false);
});
