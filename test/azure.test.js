import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseOrderDetailed, parseArgs } from "../lib/args.js";
import { withLocks, readLocks, parseLimit, LOCKABLE } from "../lib/locks.js";
import { validateSpec } from "../lib/debate.js";
import { ENGINES, MODEL_ENGINES, DEFAULT_AZURE_MODEL, azureTimeoutSec, runSpec } from "../lib/engines.js";

// Built at runtime so no key-shaped literal lands in the repo.
const KEY = "az" + "k".repeat(30);
const ENDPOINT = "https://example-res.openai.azure.com";
const URL_OK = `${ENDPOINT}/openai/v1/chat/completions`;

const reply = (message) => ({ choices: [{ message, finish_reason: "stop" }] });
const ok = (message) => () => new Response(JSON.stringify(reply(message)), { status: 200 });
const status = (code, body = "", headers = {}) => () => new Response(body, { status: code, headers });

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responses[Math.min(calls.length, responses.length) - 1]();
  };
  fn.calls = calls;
  return fn;
}

const noFile = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const env = { AZURE_OPENAI_KEY: KEY, AZURE_OPENAI_ENDPOINT: ENDPOINT };
const run = (fetchImpl, extra = {}) =>
  ENGINES.azure({ prompt: "hi", env, home: "/nohome", readFile: noFile, fetchImpl, ...extra });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-azure-")), "state", "locks.json");
const NOW = new Date(2026, 10, 6, 12, 0).getTime();

test("azure: request shape, answer and label", async () => {
  for (const endpoint of [ENDPOINT, `${ENDPOINT}/`, `${ENDPOINT}//`]) {
    const f = fakeFetch([ok({ content: " azure ok \n" })]);
    const r = await run(f, { env: { ...env, AZURE_OPENAI_ENDPOINT: endpoint } });
    assert.deepEqual(r, { engine: "azure:gpt-5-mini", ok: true, body: "azure ok" });
    assert.equal(f.calls.length, 1);
    const { url, init, body } = f.calls[0];
    assert.equal(url, URL_OK);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["api-key"], KEY);
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.ok(!Object.keys(init.headers).some((h) => h.toLowerCase() === "authorization"));
    assert.deepEqual(body, { model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 16000 });
    for (const k of ["temperature", "max_tokens", "stream"]) assert.ok(!(k in body), k);
  }
});

test("azure: key and endpoint come from the files (first line, trimmed) when env is empty", async () => {
  const files = {
    [path.join("/h", ".azure-openai-key")]: `  ${KEY}  \nsecond line\n`,
    [path.join("/h", ".azure-openai-endpoint")]: `${ENDPOINT}/\r\n`,
  };
  const readFile = (p) => (p in files ? files[p] : noFile());
  const f = fakeFetch([ok({ content: "x" })]);
  const r = await ENGINES.azure({ prompt: "hi", env: {}, home: "/h", readFile, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].url, URL_OK);
  assert.equal(f.calls[0].init.headers["api-key"], KEY);
});

test("azure: 429 with quota text locks through withLocks; a bare 429 does not lock for days", async () => {
  assert.ok(LOCKABLE.includes("azure"));
  const quota = "HTTP 429: You have exceeded your current quota, please check your plan and billing details";
  assert.ok(parseLimit(quota, NOW), "quota text is a limit");

  const file = tmpFile();
  const f = fakeFetch([status(429, "You have exceeded your current quota, please check your plan.")]);
  const locked = withLocks(runSpec, { file, now: () => NOW });
  const r = await locked("azure", { prompt: "hi", env, home: "/nohome", readFile: noFile, fetchImpl: f }, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 429/);
  assert.match(r.reason, /now locked until/);
  assert.ok(readLocks(file).azure, "lock written");
  // A second call is skipped without a request.
  const r2 = await locked("azure", { prompt: "hi", env, home: "/nohome", readFile: noFile, fetchImpl: f }, {});
  assert.equal(r2.skipped, true);
  assert.equal(f.calls.length, 1);

  const file2 = tmpFile();
  const f2 = fakeFetch([status(429, "Too many requests")]);
  const r3 = await withLocks(runSpec, { file: file2, now: () => NOW })("azure", { prompt: "hi", env, home: "/nohome", readFile: noFile, fetchImpl: f2 }, {});
  assert.match(r3.reason, /HTTP 429/);
  assert.equal(readLocks(file2).azure, undefined, "bare 429 does not lock");

  const file3 = tmpFile();
  const f3 = fakeFetch([status(429, "Too many requests", { "retry-after": "30" })]);
  const r4 = await withLocks(runSpec, { file: file3, now: () => NOW })("azure", { prompt: "hi", env, home: "/nohome", readFile: noFile, fetchImpl: f3 }, {});
  assert.match(r4.reason, /HTTP 429/);
  assert.equal(Date.parse(readLocks(file3).azure.until), NOW + 30000, "Retry-After locks for that long only");
});

test("azure: missing key or endpoint -> clean failure, no request, never a throw", async () => {
  const f = fakeFetch([ok({ content: "x" })]);
  const noKey = await run(f, { env: { AZURE_OPENAI_ENDPOINT: ENDPOINT } });
  assert.deepEqual(noKey, { engine: "azure:gpt-5-mini", ok: false, reason: "no key (env AZURE_OPENAI_KEY or ~/.azure-openai-key)" });
  const noEp = await run(f, { env: { AZURE_OPENAI_KEY: KEY } });
  assert.deepEqual(noEp, { engine: "azure:gpt-5-mini", ok: false, reason: "no endpoint (env AZURE_OPENAI_ENDPOINT or ~/.azure-openai-endpoint)" });
  const neither = await run(f, { env: {} });
  assert.equal(neither.ok, false);
  assert.equal(f.calls.length, 0);
});

test("azure: empty content (empty, blank, missing) fails and points at the reasoning budget", async () => {
  for (const message of [{ content: "" }, { content: "   " }, {}, { content: null }]) {
    const f = fakeFetch([ok(message)]);
    const r = await run(f);
    assert.equal(r.ok, false);
    assert.match(r.reason, /empty content/);
    assert.match(r.reason, /reasoning/);
    assert.match(r.reason, /max_completion_tokens/);
    assert.match(r.reason, /AZURE_MAX_TOKENS/);
  }
});

test("azure: 401, 403, 400 fail after exactly one request", async () => {
  for (const code of [401, 403, 400]) {
    const f = fakeFetch([status(code, "denied")]);
    const r = await run(f);
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(`^HTTP ${code}: denied`));
    assert.equal(f.calls.length, 1, String(code));
  }
});

test("azure: 500, network error, timeout and a 200 error object are plain failures", async () => {
  assert.match((await run(fakeFetch([status(500, "boom")]))).reason, /^HTTP 500: boom/);
  const net = async () => {
    throw new Error("socket hang up");
  };
  assert.match((await run(net)).reason, /unreachable: socket hang up/);
  const slow = async () => {
    throw Object.assign(new Error("t"), { name: "TimeoutError" });
  };
  assert.match((await run(slow)).reason, /timed out after 300s/);
  const err = fakeFetch([() => new Response(JSON.stringify({ error: { message: "bad deployment" } }), { status: 200 })]);
  assert.match((await run(err)).reason, /bad deployment/);
});

test("azure: AZURE_MAX_TOKENS and model precedence (spec > flag > AZURE_OPENAI_MODEL > default)", async () => {
  const body = async (extra, e = env) => {
    const f = fakeFetch([ok({ content: "x" })]);
    const r = await run(f, { env: e, ...extra });
    return { r, b: f.calls[0].body };
  };
  assert.equal((await body({}, { ...env, AZURE_MAX_TOKENS: "4000" })).b.max_completion_tokens, 4000);
  assert.equal((await body({}, { ...env, AZURE_MAX_TOKENS: "abc" })).b.max_completion_tokens, 16000);
  assert.equal((await body({}, { ...env, AZURE_MAX_TOKENS: "-5" })).b.max_completion_tokens, 16000);
  const withEnv = { ...env, AZURE_OPENAI_MODEL: "from-env" };
  assert.equal((await body({}, withEnv)).b.model, "from-env");
  assert.equal((await body({ model: "from-flag" }, withEnv)).b.model, "from-flag");
  const viaSpec = fakeFetch([ok({ content: "x" })]);
  const r = await runSpec("azure:from-spec", { prompt: "hi", env: withEnv, home: "/nohome", readFile: noFile, fetchImpl: viaSpec }, { azure: { model: "from-flag" } });
  assert.equal(r.engine, "azure:from-spec");
  assert.equal(viaSpec.calls[0].body.model, "from-spec");
  assert.equal(DEFAULT_AZURE_MODEL, "gpt-5-mini");
});

test("azure: timeout is AZURE_TIMEOUT, default 300, capped at 600", () => {
  assert.equal(azureTimeoutSec({}), 300);
  assert.equal(azureTimeoutSec({ AZURE_TIMEOUT: "120" }), 120);
  assert.equal(azureTimeoutSec({ AZURE_TIMEOUT: "9999" }), 600);
  assert.equal(azureTimeoutSec({ AZURE_TIMEOUT: "-1" }), 300);
});

test("azure: the key never appears in a failure reason or answer", async () => {
  const r = await run(fakeFetch([status(500, `upstream echoed api-key ${KEY} here`)]));
  assert.equal(r.ok, false);
  assert.ok(!r.reason.includes(KEY));
  assert.match(r.reason, /\*\*\*/);
  const e = await run(async () => {
    throw new Error(`connect failed for ${KEY}`);
  });
  assert.ok(!e.reason.includes(KEY));
  const a = await run(fakeFetch([ok({ content: `my key is ${KEY}` })]));
  assert.ok(!a.body.includes(KEY));
});

test("azure: order and args", () => {
  assert.ok(MODEL_ENGINES.includes("azure"));
  assert.deepEqual(parseOrderDetailed("azure").order, ["azure"]);
  assert.deepEqual(parseOrderDetailed("azure:gpt-5").order, ["azure:gpt-5"]);
  assert.deepEqual(parseOrderDetailed("azure:gpt-5-mini").order, ["azure"], "default model normalises to bare azure");
  assert.deepEqual(parseOrderDetailed("azure:gpt-5-mini", undefined, { azureModel: "x" }).order, ["azure:gpt-5-mini"]);
  assert.deepEqual(parseOrderDetailed("azure:x", undefined, { azureModel: "x" }).order, ["azure"]);
  assert.ok(parseOrderDetailed(undefined).order.includes("azure"), "in the default order");
  assert.equal(parseArgs(["--azure-model", "gpt-5", "hi"]).azureModel, "gpt-5");
  assert.equal(parseArgs(["hi"]).azureModel, null);
});

test("azure: usable as a debate stance engine", () => {
  const s = validateSpec({ question: "q", stances: [{ engine: "azure", stance: "pick A" }, { engine: "azure:gpt-5", stance: "pick B" }] });
  assert.deepEqual(s.stances.map((x) => x.engine), ["azure", "azure:gpt-5"]);
});
