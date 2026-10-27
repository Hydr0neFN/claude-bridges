import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseOrder, parseOrderDetailed, parseArgs } from "../lib/args.js";
import {
  ENGINES, DEFAULT_OPENROUTER_MODEL, OPENROUTER_CHAIN, OPENROUTER_ATTEMPT_TIMEOUT_SEC, OPENROUTER_MAX_ATTEMPTS,
  resolveOpenRouterKey, openRouterModels, openRouterChain, openRouterTimeoutSec, redact, runSpec,
} from "../lib/engines.js";

// Built at runtime so no key-shaped literal lands in the repo.
const FAKE_KEY = "sk-or-" + "v1-" + "x".repeat(20);
const [M1, M2, M3, M4, M5] = OPENROUTER_CHAIN;

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
const env = { OPENROUTER_API_KEY: FAKE_KEY };
const run = (fetchImpl, extra = {}) => ENGINES.openrouter({ prompt: "hi", env, fetchImpl, ...extra });

test("resolveOpenRouterKey: env > file (first sk-or token) > missing", () => {
  const file = path.join("/h", ".openrouter-key");
  const files = { [file]: `# my key\nname: x\n  ${FAKE_KEY}  \nsk-or-second\n`, "/custom/key": `${FAKE_KEY}-c\n` };
  const readFile = (p) => {
    if (p in files) return files[p];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.equal(resolveOpenRouterKey({ env: { OPENROUTER_API_KEY: " from-env \n" }, home: "/h", readFile }), "from-env");
  assert.equal(resolveOpenRouterKey({ env: {}, home: "/h", readFile }), FAKE_KEY);
  assert.equal(resolveOpenRouterKey({ env: { OPENROUTER_KEY_PATH: "/custom/key" }, home: "/h", readFile }), `${FAKE_KEY}-c`);
  assert.equal(resolveOpenRouterKey({ env: {}, home: "/nowhere", readFile }), "");
  assert.equal(resolveOpenRouterKey({ env: {}, home: "/h", readFile: () => "no token in here\n" }), "");
});

test("openrouter: sends the documented request and returns the answer, labelled with the model", async () => {
  const f = fakeFetch([ok({ content: " ok " })]);
  const r = await run(f);
  assert.deepEqual(r, { engine: `openrouter:${M1}`, ok: true, body: "ok" });
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["HTTP-Referer"], "claude-consult");
  assert.equal(init.headers["X-Title"], "claude-consult");
  assert.equal(body.model, DEFAULT_OPENROUTER_MODEL);
  assert.equal(body.max_tokens, 1500);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("openrouter: 429 then 404 fall through the chain; the third model answers", async () => {
  const f = fakeFetch([status(429, "slow down"), status(404, "no such model"), ok({ content: "third" })]);
  const r = await run(f);
  assert.deepEqual(f.calls.map((c) => c.body.model), [M1, M2, M3]);
  assert.deepEqual(r, { engine: `openrouter:${M3}`, ok: true, body: "third" });
});

test("openrouter: 5xx and empty content also fall through", async () => {
  const f = fakeFetch([status(503), ok({ content: "  " }), ok({ content: "fine" })]);
  const r = await run(f);
  assert.deepEqual(f.calls.map((c) => c.body.model), [M1, M2, M3]);
  assert.equal(r.body, "fine");
});

test("openrouter: reasoning without content counts as empty and tries the next model", async () => {
  const f = fakeFetch([ok({ content: "", reasoning: "thinking out loud" }), ok({ content: "<think>x</think>done" })]);
  const r = await run(f);
  assert.deepEqual(f.calls.map((c) => c.body.model), [M1, M2]);
  assert.deepEqual(r, { engine: `openrouter:${M2}`, ok: true, body: "done" });
});

test("openrouter: a think block is stripped from the answer", async () => {
  const r = await run(fakeFetch([ok({ content: "<think>a\nb</think>\n\nanswer" })]));
  assert.equal(r.body, "answer");
});

test("openrouter: all five fail -> one failure naming each model, 429 as rate-limited, max 5 attempts", async () => {
  const f = fakeFetch([...Array(5).fill(status(429, "busy")), ok({ content: "never" })]);
  const r = await run(f);
  assert.equal(f.calls.length, 5);
  assert.equal(r.ok, false);
  assert.equal(r.engine, `openrouter:${M1}`);
  assert.match(r.reason, /rate-limited/);
  for (const m of OPENROUTER_CHAIN) assert.ok(r.reason.includes(m), m);
});

test("openrouter: a 200 carrying an error object is handled like its HTTP status", async () => {
  const errBody = () => new Response(JSON.stringify({ error: { code: 429, message: "upstream limit" } }), { status: 200 });
  const f = fakeFetch([errBody, ok({ content: "ok" })]);
  const r = await run(f);
  assert.equal(f.calls.length, 2);
  assert.equal(r.ok, true);
});

test("openrouter: a bad key (401) ends the chain at once", async () => {
  const f = fakeFetch([status(401, "invalid key"), ok({ content: "never" })]);
  const r = await run(f);
  assert.equal(f.calls.length, 1);
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 401/);
});

test("openrouter: an unreachable network falls through, then reports every attempt", async () => {
  let n = 0;
  const f = async () => {
    n++;
    throw new TypeError("fetch failed");
  };
  const r = await run(f);
  assert.equal(n, 5);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unreachable/);
});

test("openrouter: missing key -> failed result 'no key', never a throw, no request", async () => {
  const f = fakeFetch([ok({ content: "never" })]);
  const readFile = () => {
    throw new Error("ENOENT");
  };
  const r = await ENGINES.openrouter({ prompt: "hi", env: {}, home: "/nowhere", readFile, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^no key/);
  assert.equal(f.calls.length, 0);
});

test("openrouter: the key never appears in a failure reason or an echoed answer", async () => {
  const failed = await run(fakeFetch([status(500, `oops ${FAKE_KEY}`), status(500, FAKE_KEY), status(500, FAKE_KEY)]));
  assert.ok(!failed.reason.includes(FAKE_KEY));
  const echoed = await run(fakeFetch([ok({ content: `my key is ${FAKE_KEY}` })]));
  assert.ok(!echoed.body.includes(FAKE_KEY));
  assert.equal(redact(`k=${FAKE_KEY}`), "k=sk-or-***");
});

test("openrouter: model precedence is spec model > OPENROUTER_MODEL env > default; chain follows with no repeats", async () => {
  const custom = "vendor/custom:free";
  assert.deepEqual(openRouterModels(custom), [custom, M1, M2, M3, M4]);
  assert.deepEqual(openRouterModels(M2), [M2, M1, M3, M4, M5]);
  assert.deepEqual(openRouterModels(M1), [M1, M2, M3, M4, M5]);
  const fromEnv = fakeFetch([ok({ content: "x" })]);
  await ENGINES.openrouter({ prompt: "p", env: { ...env, OPENROUTER_MODEL: "env/model:free" }, fetchImpl: fromEnv });
  assert.equal(fromEnv.calls[0].body.model, "env/model:free");
  const fromSpec = fakeFetch([ok({ content: "x" })]);
  await ENGINES.openrouter({ prompt: "p", model: custom, env: { ...env, OPENROUTER_MODEL: "env/model:free" }, fetchImpl: fromSpec });
  assert.equal(fromSpec.calls[0].body.model, custom);
});

test("runSpec: openrouter:<model> is routed with its model", async () => {
  const f = fakeFetch([ok({ content: "x" })]);
  const r = await runSpec("openrouter:vendor/custom:free", { prompt: "p", cwd: ".", timeoutSec: 300 }, { openrouter: { env, fetchImpl: f } });
  assert.equal(f.calls[0].body.model, "vendor/custom:free");
  assert.equal(r.engine, "openrouter:vendor/custom:free");
});

const called = (f) => f.calls.map((c) => c.body.model);

test("openrouter chain: built-in chain is 5 distinct :free models led by the default", () => {
  assert.equal(OPENROUTER_CHAIN.length, 5);
  assert.equal(new Set(OPENROUTER_CHAIN).size, 5);
  assert.equal(M1, DEFAULT_OPENROUTER_MODEL);
  assert.ok(OPENROUTER_CHAIN.every((m) => m.endsWith(":free")));
});

test("openrouter chain: OPENROUTER_CHAIN env overrides the list; blanks ignored", async () => {
  assert.deepEqual(openRouterChain({ OPENROUTER_CHAIN: " a/x:free , b/y:free,, " }), ["a/x:free", "b/y:free"]);
  assert.deepEqual(openRouterChain({ OPENROUTER_CHAIN: " , " }), OPENROUTER_CHAIN);
  const f = fakeFetch([status(404), ok({ content: "second" })]);
  const r = await run(f, { env: { ...env, OPENROUTER_CHAIN: "a/x:free,b/y:free,c/z:free" } });
  assert.deepEqual(called(f), [DEFAULT_OPENROUTER_MODEL, "a/x:free"]);
  assert.equal(r.engine, "openrouter:a/x:free");
});

test("openrouter chain: first model answering -> one call, label names it", async () => {
  const f = fakeFetch([ok({ content: "hi" })]);
  const r = await run(f);
  assert.deepEqual(called(f), [M1]);
  assert.equal(r.engine, `openrouter:${M1}`);
});

test("openrouter chain: steps past 404, 410, 429, a timeout down to the fifth model, labelled with it", async () => {
  const timeout = () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); };
  const f = fakeFetch([status(404), status(410), status(429), timeout, ok({ content: "fifth" })]);
  const r = await run(f);
  assert.deepEqual(called(f), [M1, M2, M3, M4, M5]);
  assert.deepEqual(r, { engine: `openrouter:${M5}`, ok: true, body: "fifth" });
  const g = fakeFetch([status(500), ok({ content: "second" })]);
  assert.equal((await run(g)).engine, `openrouter:${M2}`);
});

test("openrouter chain: a 400 'not a valid model ID' (delisted model) steps on; other 400s still stop", async () => {
  const f = fakeFetch([status(400, '{"error":{"message":"x/y:free is not a valid model ID","code":400}}'), ok({ content: "next" })]);
  const r = await run(f);
  assert.deepEqual(called(f), [M1, M2]);
  assert.equal(r.engine, `openrouter:${M2}`);
});

test("openrouter chain: auth and bad-request failures end the chain", async () => {
  for (const code of [400, 401, 402, 403]) {
    const f = fakeFetch([status(code, "denied"), ok({ content: "never" })]);
    const r = await run(f);
    assert.equal(r.ok, false, String(code));
    assert.equal(f.calls.length, 1, String(code));
  }
});

test("openrouter chain: explicit openrouter:<other> runs only that model; the default model still chains", async () => {
  const f = fakeFetch([status(404), ok({ content: "never" })]);
  const r = await runSpec("openrouter:vendor/custom:free", { prompt: "p", cwd: ".", env, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.deepEqual(called(f), ["vendor/custom:free"]);
  assert.equal(r.engine, "openrouter:vendor/custom:free");
  assert.ok(!r.reason.includes("; "));

  const g = fakeFetch([status(404), ok({ content: "chained" })]);
  const r2 = await runSpec(`openrouter:${M1}`, { prompt: "p", cwd: ".", env, fetchImpl: g });
  assert.deepEqual(called(g), [M1, M2]);
  assert.equal(r2.engine, `openrouter:${M2}`);
});

test("openrouter chain: a flag/env model (not explicit) starts the chain there", async () => {
  const f = fakeFetch([status(404), ok({ content: "x" })]);
  const r = await runSpec("openrouter", { prompt: "p", cwd: ".", env, fetchImpl: f }, { openrouter: { model: "flag/m:free" } });
  assert.deepEqual(called(f), ["flag/m:free", M1]);
  assert.equal(r.engine, `openrouter:${M1}`);
  const g = fakeFetch([status(404), ok({ content: "x" })]);
  await runSpec("openrouter", { prompt: "p", cwd: ".", env: { ...env, OPENROUTER_MODEL: "env/m:free" }, fetchImpl: g });
  assert.deepEqual(called(g), ["env/m:free", M1]);
});

test("openrouterTimeoutSec: default 300, OPENROUTER_TIMEOUT honoured, clamped to 600, garbage -> 300", () => {
  assert.equal(OPENROUTER_ATTEMPT_TIMEOUT_SEC * OPENROUTER_MAX_ATTEMPTS, 300);
  assert.equal(openRouterTimeoutSec({}), 300);
  assert.equal(openRouterTimeoutSec({ OPENROUTER_TIMEOUT: "120" }), 120);
  assert.equal(openRouterTimeoutSec({ OPENROUTER_TIMEOUT: "9999" }), 600);
  assert.equal(openRouterTimeoutSec({ OPENROUTER_TIMEOUT: "abc" }), 300);
  assert.equal(openRouterTimeoutSec({ OPENROUTER_TIMEOUT: "-5" }), 300);
});

test("openrouter chain budget: 60 s per step, five steps fit the 300 s default, a short budget skips the rest", async () => {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t; // every failed request "takes" 60 s
  try {
    const f = async (url, init) => { f.calls.push(JSON.parse(init.body).model); t += 60_000; return new Response("x", { status: 500 }); };
    f.calls = [];
    await run(f);
    assert.equal(f.calls.length, 5);
    f.calls = [];
    t = realNow();
    const r = await run(f, { timeoutSec: 130 }); // 60 + 60 used, 10 s left (< 15 s minimum)
    assert.equal(f.calls.length, 2);
    assert.ok(r.reason.includes(`${M3}: skipped`));
  } finally {
    Date.now = realNow;
  }
});

test("parseOrder: openrouter and openrouter:<model> entries", () => {
  assert.deepEqual(parseOrder("copilot,codex,deepseek,openrouter"), ["copilot", "codex", "deepseek", "openrouter"]);
  assert.deepEqual(parseOrder("openrouter:cohere/north-mini-code:free,codex"), ["openrouter:cohere/north-mini-code:free", "codex"]);
  assert.deepEqual(parseOrderDetailed("openrouter:").dropped, ["openrouter:"]);
});

test("parseOrder: openrouter:<default model> is the same entry as bare openrouter", () => {
  assert.deepEqual(parseOrder(`openrouter,openrouter:${DEFAULT_OPENROUTER_MODEL}`), ["openrouter"]);
  assert.deepEqual(parseOrder("openrouter:env/m:free,openrouter", undefined, { openrouterModel: "env/m:free" }), ["openrouter"]);
});

test("default order includes openrouter (after nim)", () => {
  assert.deepEqual(parseOrder(undefined), ["copilot", "codex", "deepseek", "agy", "nim", "openrouter"]);
});

test("parseArgs: --openrouter-model", () => {
  assert.equal(parseArgs(["--openrouter-model", "a/b:free", "hi"]).openrouterModel, "a/b:free");
  assert.equal(parseArgs(["hi"]).openrouterModel, null);
});
