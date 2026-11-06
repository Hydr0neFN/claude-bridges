import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseOrder, parseOrderDetailed, parseArgs } from "../lib/args.js";
import { withLocks, readLocks } from "../lib/locks.js";
import {
  ENGINES, MODEL_ENGINES, DEFAULT_GEMINI_MODEL, GEMINI_CHAIN, GEMINI_ATTEMPT_TIMEOUT_SEC, GEMINI_MAX_ATTEMPTS,
  resolveGeminiKey, geminiModels, geminiChain, geminiTimeoutSec, redact, runSpec, withGeminiFallback, parseSpec,
} from "../lib/engines.js";

// Built at runtime so no key-shaped literal lands in the repo.
const FAKE_KEY = "AIza" + "x".repeat(35);
const ALT_KEY = "AIza" + "y".repeat(35);
const [M1, M2, M3] = GEMINI_CHAIN;

const reply = (message, finish_reason = "stop") => ({ choices: [{ message, finish_reason }] });
const ok = (message) => () => new Response(JSON.stringify(reply(message)), { status: 200 });
const status = (code, body = "") => () => new Response(body, { status: code });

/** fetch stub replaying `responses` in order; records every call. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responses[Math.min(calls.length, responses.length) - 1]();
  };
  fn.calls = calls;
  return fn;
}
const called = (f) => f.calls.map((c) => c.body.model);

const env = { GEMINI_API_KEY: FAKE_KEY };
const run = (fetchImpl, extra = {}) => ENGINES.gemini({ prompt: "hi", env, fetchImpl, ...extra });
const missingKey = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-gemini-")), "state", "locks.json");
const NOW = new Date(2026, 10, 6, 12, 0).getTime();
const AGY_QUOTA = "exit 1: Quota exceeded for model";

test("resolveGeminiKey: env > file (first AIza token) > missing", () => {
  const file = path.join("/h", ".gemini-api-key");
  const files = { [file]: `# my key\nname: x\n  ${FAKE_KEY}  \n${ALT_KEY}\n`, "/custom/key": `${ALT_KEY}-c\n` };
  const readFile = (p) => {
    if (p in files) return files[p];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.equal(resolveGeminiKey({ env: { GEMINI_API_KEY: " from-env \n" }, home: "/h", readFile }), "from-env");
  assert.equal(resolveGeminiKey({ env: {}, home: "/h", readFile }), FAKE_KEY);
  assert.equal(resolveGeminiKey({ env: { GEMINI_KEY_PATH: "/custom/key" }, home: "/h", readFile }), ALT_KEY);
  assert.equal(resolveGeminiKey({ env: {}, home: "/nowhere", readFile }), "");
  assert.equal(resolveGeminiKey({ env: {}, home: "/h", readFile: () => "no token in here\n" }), "");
  assert.equal(resolveGeminiKey({ env: { GEMINI_API_KEY: "  " }, home: "/nowhere", readFile: missingKey }), "");
});

test("gemini: sends the documented request and returns the answer, labelled with the model", async () => {
  const f = fakeFetch([ok({ content: " ok " })]);
  const r = await run(f);
  assert.deepEqual(r, { engine: `gemini:${M1}`, ok: true, body: "ok" });
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(body.model, DEFAULT_GEMINI_MODEL);
  assert.equal(body.max_tokens, 1500);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("gemini: GEMINI_BASE replaces the base and loses its trailing slash", async () => {
  const f = fakeFetch([ok({ content: "x" })]);
  await run(f, { env: { ...env, GEMINI_BASE: "http://127.0.0.1:9/v1beta/openai///" } });
  assert.equal(f.calls[0].url, "http://127.0.0.1:9/v1beta/openai/chat/completions");
});

test("gemini: missing key -> failed result 'no key', no request", async () => {
  const f = fakeFetch([ok({ content: "never" })]);
  const r = await ENGINES.gemini({ prompt: "hi", env: {}, home: "/nowhere", readFile: missingKey, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.engine, `gemini:${DEFAULT_GEMINI_MODEL}`);
  assert.equal(r.reason, "no key (env GEMINI_API_KEY or ~/.gemini-api-key)");
  assert.equal(f.calls.length, 0);
});

test("gemini: 429 on the first model steps to the second", async () => {
  const f = fakeFetch([status(429, "slow down"), ok({ content: "second" })]);
  const r = await run(f);
  assert.deepEqual(called(f), [M1, M2]);
  assert.deepEqual(r, { engine: `gemini:${M2}`, ok: true, body: "second" });
});

test("gemini: 5xx, 404, empty content and timeouts also step on; 410 included", async () => {
  const timeout = () => {
    throw Object.assign(new Error("t"), { name: "TimeoutError" });
  };
  const f = fakeFetch([status(503), status(404), ok({ content: "  " }), ok({ content: "fine" })]);
  const r = await run(f);
  assert.deepEqual(called(f), [M1, M2, M3]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty output/);

  const g = fakeFetch([status(410), timeout, ok({ content: "late" })]);
  const r2 = await run(g);
  assert.deepEqual(called(g), [M1, M2, M3]);
  assert.deepEqual(r2, { engine: `gemini:${M3}`, ok: true, body: "late" });
});

test("gemini: a 401 ends the chain at once; no further model is tried", async () => {
  const f = fakeFetch([status(401, "invalid key"), ok({ content: "never" })]);
  const r = await run(f);
  assert.equal(f.calls.length, 1);
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 401/);
});

test("gemini: 400 and 403 also stop the chain", async () => {
  for (const code of [400, 403]) {
    const f = fakeFetch([status(code, "denied"), ok({ content: "never" })]);
    const r = await run(f);
    assert.equal(r.ok, false, String(code));
    assert.equal(f.calls.length, 1, String(code));
  }
});

test("gemini: the key never appears in a failure reason or an echoed answer", async () => {
  const failed = await run(fakeFetch([status(500, `oops ${FAKE_KEY}`), status(500, FAKE_KEY), status(500, FAKE_KEY)]));
  assert.ok(!failed.reason.includes(FAKE_KEY));
  const echoed = await run(fakeFetch([ok({ content: `my key is ${FAKE_KEY}` })]));
  assert.ok(!echoed.body.includes(FAKE_KEY));
});

test("redact masks an AIza key to AIza*** and leaves the other patterns working", () => {
  assert.equal(redact(`k=${FAKE_KEY}`), "k=AIza***");
  assert.equal(redact("k=sk-or-abcdefghij"), "k=sk-or-***");
  assert.equal(redact("k=nvapi-abcdefghij"), "k=nvapi-***");
});

test("newer AQ.-format AI Studio keys: resolved from the key file and masked", () => {
  const aq = "AQ." + "Ab_c-".repeat(8); // built at runtime: no key-shaped literal
  assert.equal(resolveGeminiKey({ env: {}, home: "/h", readFile: () => `${aq}\r\n` }), aq);
  assert.equal(redact(`k=${aq}`), "k=AQ.***");
});

test("gemini chain: explicit gemini:<model> other than the default runs only that model", async () => {
  const f = fakeFetch([status(404), ok({ content: "never" })]);
  const r = await ENGINES.gemini({ prompt: "hi", model: "gemini-custom", explicit: true, env, fetchImpl: f });
  assert.deepEqual(called(f), ["gemini-custom"]);
  assert.equal(r.ok, false);
  assert.equal(r.engine, "gemini:gemini-custom");
  assert.ok(!r.reason.includes("; "));

  const g = fakeFetch([status(404), ok({ content: "chained" })]);
  const r2 = await runSpec(`gemini:${M1}`, { prompt: "p", cwd: ".", env, fetchImpl: g });
  assert.deepEqual(called(g), [M1, M2]);
  assert.equal(r2.engine, `gemini:${M2}`);
});

test("gemini chain: model precedence and env chain override", () => {
  assert.deepEqual(geminiChain({ GEMINI_CHAIN: " a-m , b-m ,, " }), ["a-m", "b-m"]);
  assert.deepEqual(geminiChain({ GEMINI_CHAIN: " , " }), GEMINI_CHAIN);
  assert.deepEqual(geminiModels("custom"), ["custom", M1, M2]);
  assert.deepEqual(geminiModels(M2), [M2, M1, M3]);
  assert.equal(GEMINI_MAX_ATTEMPTS, 3);
  assert.equal(MODEL_ENGINES.includes("gemini"), true);
});

test("geminiTimeoutSec: default 270, GEMINI_TIMEOUT honoured, clamped to 600, garbage -> 270", () => {
  assert.equal(GEMINI_ATTEMPT_TIMEOUT_SEC * GEMINI_MAX_ATTEMPTS, 270);
  assert.equal(geminiTimeoutSec({}), 270);
  assert.equal(geminiTimeoutSec({ GEMINI_TIMEOUT: "120" }), 120);
  assert.equal(geminiTimeoutSec({ GEMINI_TIMEOUT: "9999" }), 600);
  assert.equal(geminiTimeoutSec({ GEMINI_TIMEOUT: "abc" }), 270);
  assert.equal(geminiTimeoutSec({ GEMINI_TIMEOUT: "-5" }), 270);
});

test("parseOrder / parseArgs: gemini entries, default model normalisation, --gemini-model", () => {
  assert.deepEqual(parseOrder("copilot,gemini"), ["copilot", "gemini"]);
  assert.deepEqual(parseOrder("gemini:gemini-custom,codex"), ["gemini:gemini-custom", "codex"]);
  assert.deepEqual(parseOrderDetailed("gemini:").dropped, ["gemini:"]);
  assert.deepEqual(parseOrder(`gemini,gemini:${DEFAULT_GEMINI_MODEL}`), ["gemini"]);
  assert.deepEqual(parseOrder("gemini:m,gemini", undefined, { geminiModel: "m" }), ["gemini"]);
  assert.equal(parseArgs(["--gemini-model", "a-m", "hi"]).geminiModel, "a-m");
  assert.equal(parseArgs(["hi"]).geminiModel, null);
  assert.deepEqual(parseOrder(undefined), ["copilot", "codex", "deepseek", "agy", "nim", "openrouter"], "gemini stays opt-in");
});

/** withGeminiFallback over a withLocks-wrapped run: agy fails with a quota reason, everything else is runSpec. */
const runWithAgy = (opts) =>
  withGeminiFallback(withLocks(async (spec, base = {}, perEngine = {}) => {
    if (parseSpec(spec).engine === "agy") return { engine: "agy", ok: false, reason: AGY_QUOTA };
    return runSpec(spec, base, perEngine);
  }, opts));

test("agy -> gemini: agy fails and a Gemini key resolves, so gemini answers under agy->gemini:<model>", async () => {
  const f = fakeFetch([ok({ content: "from gemini" })]);
  const r = await runWithAgy({ file: tmpFile(), now: () => NOW })("agy", { prompt: "hi", cwd: ".", env, fetchImpl: f });
  assert.deepEqual(r, { engine: `agy->gemini:${M1}`, ok: true, body: "from gemini" });
  assert.deepEqual(called(f), [M1]);
});

test("agy -> gemini: both failing gives ONE failure listing both reasons", async () => {
  const f = fakeFetch([status(401, "bad key")]);
  const r = await runWithAgy({ file: tmpFile(), now: () => NOW })("agy", { prompt: "hi", cwd: ".", env, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.engine, `agy->gemini:${M1}`);
  assert.equal((r.reason.match(/agy:/g) || []).length, 1);
  assert.match(r.reason, /agy: exit 1: Quota exceeded for model/);
  assert.match(r.reason, /gemini: .*HTTP 401/);
});

test("agy -> gemini: a quota failure still writes the agy lock, then a skipped agy falls back too", async () => {
  const file = tmpFile();
  const f = fakeFetch([ok({ content: "one" })]);
  const runLocked = runWithAgy({ file, now: () => NOW });
  const r1 = await runLocked("agy", { prompt: "hi", cwd: ".", env, fetchImpl: f });
  assert.equal(r1.ok, true);
  assert.equal(r1.engine, `agy->gemini:${M1}`);
  const locks = readLocks(file);
  assert.equal(Object.keys(locks).length, 1);
  assert.equal(locks.agy.until, new Date(NOW + 24 * 3600 * 1000).toISOString());

  const g = fakeFetch([ok({ content: "two" })]);
  const r2 = await runLocked("agy", { prompt: "hi", cwd: ".", env, fetchImpl: g });
  assert.deepEqual(r2, { engine: `agy->gemini:${M1}`, ok: true, body: "two" });

  // Skip is visible to the fallback: the agy side reports the lock, gemini still answers.
  const bothDown = fakeFetch([status(401, "bad key")]);
  const h = tmpFile();
  const down = runWithAgy({ file: h, now: () => NOW });
  await down("agy", { prompt: "hi", cwd: ".", env, fetchImpl: bothDown }); // first: failure writes the lock
  const r3 = await down("agy", { prompt: "hi", cwd: ".", env, fetchImpl: bothDown }); // second: lock-skipped
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /agy: skipped: locked until/);
  assert.match(r3.reason, /gemini: /);
});

test("agy: without a Gemini key the result is exactly what it was (label and failure text)", async () => {
  const f = fakeFetch([ok({ content: "never" })]);
  const plain = withGeminiFallback(async (spec) => ({ engine: spec, ok: false, reason: "exit 1: boom" }));
  const r = await plain("agy", { prompt: "hi", env: {}, home: "/nowhere", readFile: missingKey, fetchImpl: f });
  assert.deepEqual(r, { engine: "agy", ok: false, reason: "exit 1: boom" });
  assert.equal(f.calls.length, 0);
});
