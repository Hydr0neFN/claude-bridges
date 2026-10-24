import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseOrder, parseOrderDetailed, parseArgs } from "../lib/args.js";
import {
  ENGINES, DEFAULT_OPENROUTER_MODEL, OPENROUTER_CHAIN, resolveOpenRouterKey, openRouterModels, redact, runSpec,
} from "../lib/engines.js";

// Built at runtime so no key-shaped literal lands in the repo.
const FAKE_KEY = "sk-or-" + "v1-" + "x".repeat(20);
const [M1, M2, M3] = OPENROUTER_CHAIN;

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

test("openrouter: all three fail -> one failure naming each model, 429 as rate-limited, max 3 attempts", async () => {
  const f = fakeFetch([status(429, "busy"), status(429, "busy"), status(429, "busy"), ok({ content: "never" })]);
  const r = await run(f);
  assert.equal(f.calls.length, 3);
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
  assert.equal(n, 3);
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
  assert.deepEqual(openRouterModels(custom), [custom, M1, M2]);
  assert.deepEqual(openRouterModels(M2), [M2, M1, M3]);
  assert.deepEqual(openRouterModels(M1), [M1, M2, M3]);
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

test("parseOrder: openrouter and openrouter:<model> entries", () => {
  assert.deepEqual(parseOrder("copilot,codex,deepseek,openrouter"), ["copilot", "codex", "deepseek", "openrouter"]);
  assert.deepEqual(parseOrder("openrouter:poolside/laguna-s-2.1:free,codex"), ["openrouter:poolside/laguna-s-2.1:free", "codex"]);
  assert.deepEqual(parseOrderDetailed("openrouter:").dropped, ["openrouter:"]);
});

test("parseOrder: openrouter:<default model> is the same entry as bare openrouter", () => {
  assert.deepEqual(parseOrder(`openrouter,openrouter:${DEFAULT_OPENROUTER_MODEL}`), ["openrouter"]);
  assert.deepEqual(parseOrder("openrouter:env/m:free,openrouter", undefined, { openrouterModel: "env/m:free" }), ["openrouter"]);
});

test("default order does not include openrouter", () => {
  assert.deepEqual(parseOrder(undefined), ["copilot", "codex", "deepseek"]);
});

test("parseArgs: --openrouter-model", () => {
  assert.equal(parseArgs(["--openrouter-model", "a/b:free", "hi"]).openrouterModel, "a/b:free");
  assert.equal(parseArgs(["hi"]).openrouterModel, null);
});
