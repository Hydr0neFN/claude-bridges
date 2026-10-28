import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseOrder, parseOrderDetailed, parseArgs } from "../lib/args.js";
import {
  ENGINES, DEFAULT_DSAPI_MODEL, DSAPI_SOFT_ALARM_REQUESTS, isDsapiModel, resolveDsapiKey, readDsapiUsage,
  dsapiUsageNotice, redact, runSpec, DSAPI_OR_MODEL, resetDsOpenRouterState, openRouterFreeRemaining, orFreeReserve,
  resetOrFreeCache,
} from "../lib/engines.js";

// Built at runtime so no key-shaped literal lands in the repo.
const FAKE_KEY = "sk-" + "ab12".repeat(8);
const PROXY_KEY = "proxy-" + "k".repeat(10);

const reply = (message, finish_reason = "stop", usage) => ({ choices: [{ message, finish_reason }], ...(usage && { usage }) });
const ok = (message, usage) => () => new Response(JSON.stringify(reply(message, "stop", usage)), { status: 200 });
const status = (code, body = "", headers = {}) => () => new Response(body, { status: code, headers });

/** fetch stub: `responses` replayed in order, or a function url -> responder. Records every call. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const pick = typeof responses === "function" ? responses(url, calls.length) : responses[Math.min(calls.length, responses.length) - 1];
    return pick();
  };
  fn.calls = calls;
  return fn;
}
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsapi-test-"));
const naps = () => {
  const ms = [];
  const sleep = async (n) => void ms.push(n);
  sleep.ms = ms;
  return sleep;
};
const env = { DEEPSEEK_API_KEY: FAKE_KEY };
const run = (fetchImpl, extra = {}) =>
  ENGINES.dsapi({ prompt: "hi", env, home: mkHome(), sleep: naps(), fetchImpl, ...extra });
const usageFile = (home) => JSON.parse(fs.readFileSync(path.join(home, ".dsapi-usage.json"), "utf8"));

test("resolveDsapiKey: env > file (first sk- token) > missing", () => {
  const file = path.join("/h", ".deepseek-api-key");
  const files = { [file]: `# my key\n  ${FAKE_KEY}  \nsk-second\n`, "/custom/key": `${FAKE_KEY}-c\n` };
  const readFile = (p) => {
    if (p in files) return files[p];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.equal(resolveDsapiKey({ env: { DEEPSEEK_API_KEY: " from-env \n" }, home: "/h", readFile }), "from-env");
  assert.equal(resolveDsapiKey({ env: {}, home: "/h", readFile }), FAKE_KEY);
  assert.equal(resolveDsapiKey({ env: { DSAPI_KEY_PATH: "/custom/key" }, home: "/h", readFile }), `${FAKE_KEY}-c`);
  assert.equal(resolveDsapiKey({ env: {}, home: "/nowhere", readFile }), "");
  assert.equal(resolveDsapiKey({ env: {}, home: "/h", readFile: () => "no token in here\n" }), "");
});

test("dsapi: sends the documented request to the official API and returns the answer", async () => {
  const f = fakeFetch([ok({ content: " ok " })]);
  const r = await run(f);
  assert.deepEqual(r, { engine: "dsapi", ok: true, body: "ok" });
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(body.model, DEFAULT_DSAPI_MODEL);
  assert.equal(body.max_tokens, 1500);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("isDsapiModel: flash ids pass; pro, reasoner, chat, empty, odd shapes are refused", () => {
  for (const m of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v6-flash", "v4.1flash", "deepseek-chat-flash", "DeepSeek-Flash", "DEEPSEEK-FLASH"]) {
    assert.equal(isDsapiModel(m), true, m);
  }
  for (const m of [
    "deepseek-v4-pro", "deepseek-reasoner", "deepseek-chat", "deepseek-r1", "deepseek-flash-pro", "deepseek-flash-reasoner",
    "DeepSeek-V4-PRO", "", " ", " deepseek-flash", "deepseek-flash ", "deepseek flash", "flash\nreasoner", "deep-seek", undefined, null, 5,
  ]) {
    assert.equal(isDsapiModel(m), false, JSON.stringify(m));
  }
});

test("dsapi: a non-flash model is refused with 'limited to flash' and never sent (spec, env, empty)", async () => {
  for (const model of ["deepseek-v4-pro", "deepseek-reasoner", "deepseek-chat", "", "DeepSeek-V4-PRO", "deepseek-flash-pro"]) {
    const f = fakeFetch([ok({ content: "x" })]);
    const home = mkHome();
    const r = await run(f, { model, home });
    assert.equal(r.ok, false, JSON.stringify(model));
    assert.match(r.reason, /dsapi is limited to flash/);
    assert.equal(f.calls.length, 0, JSON.stringify(model));
    assert.ok(!fs.existsSync(path.join(home, ".dsapi-usage.json")), "nothing counted for a refused call");
  }
  const viaEnv = fakeFetch([ok({ content: "x" })]);
  const r = await run(viaEnv, { env: { ...env, DSAPI_MODEL: "deepseek-reasoner" } });
  assert.match(r.reason, /dsapi is limited to flash/);
  assert.equal(viaEnv.calls.length, 0);
  // refused even before the key is looked up
  const readFile = () => {
    throw new Error("x");
  };
  const noKey = await ENGINES.dsapi({ prompt: "hi", model: "deepseek-v4-pro", env: {}, home: "/nowhere", readFile, fetchImpl: fakeFetch([ok({ content: "x" })]) });
  assert.match(noKey.reason, /dsapi is limited to flash/);
});

test("dsapi: flash ids are sent as given (spec > DSAPI_MODEL env > default), labelled when not the default", async () => {
  const future = fakeFetch([ok({ content: "x" })]);
  const r = await run(future, { model: "deepseek-v6-flash" });
  assert.equal(future.calls[0].body.model, "deepseek-v6-flash");
  assert.equal(r.engine, "dsapi:deepseek-v6-flash");
  const fromEnv = fakeFetch([ok({ content: "x" })]);
  await run(fromEnv, { env: { ...env, DSAPI_MODEL: "deepseek-v5-flash" } });
  assert.equal(fromEnv.calls[0].body.model, "deepseek-v5-flash");
  const fromSpec = fakeFetch([ok({ content: "x" })]);
  await run(fromSpec, { model: "deepseek-v6-flash", env: { ...env, DSAPI_MODEL: "deepseek-v5-flash" } });
  assert.equal(fromSpec.calls[0].body.model, "deepseek-v6-flash");
});

test("dsapi: 429 is retried once (honouring Retry-After) and then succeeds", async () => {
  const f = fakeFetch([status(429, "slow down", { "retry-after": "2" }), ok({ content: "fine" })]);
  const sleep = naps();
  const r = await run(f, { sleep });
  assert.deepEqual(r, { engine: "dsapi", ok: true, body: "fine" });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(sleep.ms, [2000]);
});

test("dsapi: a second 429 / 5xx gives up after exactly one retry", async () => {
  const two429 = fakeFetch([status(429), status(429), ok({ content: "never" })]);
  const r = await run(two429);
  assert.equal(r.ok, false);
  assert.match(r.reason, /rate-limited \(HTTP 429/);
  assert.equal(two429.calls.length, 2);
  const f5 = fakeFetch([status(503, "down"), status(500, "down"), ok({ content: "never" })]);
  const r5 = await run(f5);
  assert.match(r5.reason, /HTTP 500/);
  assert.equal(f5.calls.length, 2);
});

test("dsapi: 5xx and a network error are retried once", async () => {
  const f5 = fakeFetch([status(502), ok({ content: "back" })]);
  assert.equal((await run(f5)).body, "back");
  assert.equal(f5.calls.length, 2);
  let n = 0;
  const net = async () => {
    if (++n === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply({ content: "again" })), { status: 200 });
  };
  const r = await run(net);
  assert.equal(r.body, "again");
  assert.equal(n, 2);
});

test("dsapi: 401, 402, 403 and 400 are final (no retry)", async () => {
  for (const code of [401, 402, 403, 400]) {
    const f = fakeFetch([status(code, "nope"), ok({ content: "never" })]);
    const sleep = naps();
    const r = await run(f, { sleep });
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(`^HTTP ${code}`));
    assert.equal(f.calls.length, 1, `HTTP ${code}`);
    assert.deepEqual(sleep.ms, []);
  }
});

test("dsapi: a missing key is a soft '[failed] no key', never a crash or a request", async () => {
  const f = fakeFetch([ok({ content: "x" })]);
  const readFile = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const r = await ENGINES.dsapi({ prompt: "hi", env: {}, home: "/nowhere", readFile, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^no key/);
  assert.equal(f.calls.length, 0);
});

test("dsapi: a leading <think> block is stripped; reasoning-only is flagged degraded", async () => {
  const r = await run(fakeFetch([ok({ content: "<think>hmm, let me see</think>\n\nthe answer" })]));
  assert.deepEqual(r, { engine: "dsapi", ok: true, body: "the answer" });
  const only = await run(fakeFetch([ok({ content: "", reasoning_content: "just thoughts" })]));
  assert.equal(only.ok, true);
  assert.equal(only.degraded, true);
});

test("dsapi: the key never appears in a failure reason or an echoed answer; sk- keys are redacted", async () => {
  const failed = await run(fakeFetch([status(400, `bad ${FAKE_KEY}`)]));
  assert.ok(!failed.reason.includes(FAKE_KEY));
  const echoed = await run(fakeFetch([ok({ content: `my key is ${FAKE_KEY}` })]));
  assert.ok(!echoed.body.includes(FAKE_KEY));
  assert.equal(redact(`k=${FAKE_KEY}`), "k=sk-***");
  assert.equal(redact("k=sk-or-v1-abcdefghijklmnopqrstuvwxyz"), "k=sk-or-***");
  assert.equal(redact("short sk-abc is left alone"), "short sk-abc is left alone");
});

test("usage counter: counts requests (retries included) and prompt+completion tokens per day", async () => {
  const home = mkHome();
  const now = Date.parse("2026-10-24T12:00:00");
  const u = { prompt_tokens: 10, completion_tokens: 3 };
  await run(fakeFetch([ok({ content: "a" }, u)]), { home, now });
  assert.deepEqual(usageFile(home), { day: "2026-10-24", requests: 1, promptTokens: 10, completionTokens: 3 });
  await run(fakeFetch([status(503), ok({ content: "b" }, u)]), { home, now });
  assert.deepEqual(usageFile(home), { day: "2026-10-24", requests: 3, promptTokens: 20, completionTokens: 6 });
  // a new day starts from zero
  assert.equal(readDsapiUsage({ home, now: Date.parse("2026-10-25T00:30:00") }).requests, 0);
  await run(fakeFetch([ok({ content: "c" }, u)]), { home, now: Date.parse("2026-10-25T00:30:00") });
  assert.deepEqual(usageFile(home), { day: "2026-10-25", requests: 1, promptTokens: 10, completionTokens: 3 });
});

test("usage counter: a broken counter file or an unwritable home never fails the call", async () => {
  const home = mkHome();
  fs.writeFileSync(path.join(home, ".dsapi-usage.json"), "{not json");
  assert.equal((await run(fakeFetch([ok({ content: "x" })]), { home })).ok, true);
  assert.equal(usageFile(home).requests, 1);
  const writeFile = () => {
    throw new Error("EACCES");
  };
  const r = await run(fakeFetch([ok({ content: "x" })]), { home, writeFile });
  assert.equal(r.ok, true);
});

test("usage footer: silent up to 300 requests/day, a one-line soft alarm beyond it (no hard stop)", async () => {
  const home = mkHome();
  const now = Date.parse("2026-10-24T12:00:00");
  const write = (requests) =>
    fs.writeFileSync(path.join(home, ".dsapi-usage.json"), JSON.stringify({ day: "2026-10-24", requests, promptTokens: 1000, completionTokens: 200 }));
  assert.equal(DSAPI_SOFT_ALARM_REQUESTS, 300);
  write(300);
  assert.equal(dsapiUsageNotice({ home, now }), null);
  write(301);
  const note = dsapiUsageNotice({ home, now });
  assert.match(note, /dsapi: 301 requests today/);
  assert.match(note, /1200 tokens/);
  assert.ok(!note.includes("\n"));
  // past the alarm the engine still answers
  const f = fakeFetch([ok({ content: "still works" })]);
  assert.equal((await run(f, { home, now })).body, "still works");
  assert.equal(usageFile(home).requests, 302);
  assert.equal(dsapiUsageNotice({ home: mkHome(), now }), null);
});

// ---- deepseek (proxy) -> dsapi fallback ----

/** Run `fn` with the given process.env vars (undefined = unset); restores them afterwards. */
async function withProxyEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const proxyUp = { DEEPSEEKER_API_KEY: PROXY_KEY, DEEPSEEKER_BASE: "http://127.0.0.1:4000" };
const isProxy = (url) => url.startsWith("http://127.0.0.1:4000");
const deepseek = (fetchImpl, extra = {}) => ENGINES.deepseek({ prompt: "hi", timeoutSec: 300, env, home: mkHome(), sleep: naps(), fetchImpl, ...extra });

test("deepseek: a working proxy is used as before; dsapi is not touched", async () => {
  const f = fakeFetch((url) => (isProxy(url) ? ok({ content: "from proxy" }) : ok({ content: "from official" })));
  const r = await withProxyEnv(proxyUp, () => deepseek(f));
  assert.deepEqual(r, { engine: "deepseek", ok: true, body: "from proxy" });
  assert.equal(f.calls.length, 1);
  assert.ok(isProxy(f.calls[0].url));
});

test("deepseek: proxy refuses the connection -> falls back to the official API, labelled deepseek->dsapi", async () => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (isProxy(url)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response(JSON.stringify(reply({ content: "from official" })), { status: 200 });
  };
  const home = mkHome();
  const r = await withProxyEnv(proxyUp, () => deepseek(f, { home }));
  assert.deepEqual(r, { engine: "deepseek->dsapi", ok: true, body: "from official" });
  assert.deepEqual(calls, ["http://127.0.0.1:4000/v1/chat/completions", "https://api.deepseek.com/chat/completions"]);
  assert.equal(usageFile(home).requests, 1);
});

test("deepseek: no proxy key, or a proxy 5xx, also falls back", async () => {
  const official = (url) => (isProxy(url) ? status(502, "bad gateway") : ok({ content: "from official" }));
  const noKey = { DEEPSEEKER_API_KEY: undefined, DEEPSEEKER_ENV_PATH: path.join(mkHome(), "missing.env") };
  const f1 = fakeFetch(official);
  const r1 = await withProxyEnv(noKey, () => deepseek(f1));
  assert.deepEqual(r1, { engine: "deepseek->dsapi", ok: true, body: "from official" });
  assert.deepEqual(f1.calls.map((c) => isProxy(c.url)), [false]); // no proxy request without a key
  const f2 = fakeFetch(official);
  const r2 = await withProxyEnv(proxyUp, () => deepseek(f2));
  assert.deepEqual(r2, { engine: "deepseek->dsapi", ok: true, body: "from official" });
  assert.deepEqual(f2.calls.map((c) => isProxy(c.url)), [true, false]);
});

test("deepseek: no fallback for proxy 4xx or an explicit proxy model", async () => {
  const f4 = fakeFetch((url) => (isProxy(url) ? status(401, "bad key") : ok({ content: "official" })));
  const r4 = await withProxyEnv(proxyUp, () => deepseek(f4));
  assert.equal(r4.ok, false);
  assert.match(r4.reason, /^HTTP 401/);
  assert.equal(f4.calls.length, 1);
  const fm = fakeFetch((url) => (isProxy(url) ? status(502) : ok({ content: "official" })));
  const rm = await withProxyEnv(proxyUp, () => deepseek(fm, { model: "v4.1flash" }));
  assert.equal(rm.ok, false);
  assert.equal(rm.engine, "deepseek:v4.1flash");
  assert.equal(fm.calls.length, 1);
});

test("deepseek: proxy down and dsapi unusable -> one failure naming both reasons", async () => {
  const f = fakeFetch(() => status(503, "down"));
  const noKey = { DEEPSEEKER_API_KEY: undefined, DEEPSEEKER_ENV_PATH: path.join(mkHome(), "missing.env") };
  const readFile = () => {
    throw new Error("x");
  };
  const r = await withProxyEnv(noKey, () => ENGINES.deepseek({ prompt: "hi", timeoutSec: 300, env: {}, home: "/nowhere", readFile, fetchImpl: f }));
  assert.equal(r.ok, false);
  assert.equal(r.engine, "deepseek");
  assert.match(r.reason, /no DEEPSEEKER_API_KEY.*fallback dsapi: no key/);
  assert.equal(f.calls.length, 0);
});

// ---- wiring ----

test("runSpec: dsapi:<model> is routed; a non-flash spec model is refused", async () => {
  const f = fakeFetch([ok({ content: "x" })]);
  const r = await runSpec("dsapi:deepseek-v6-flash", { prompt: "p", cwd: ".", timeoutSec: 300 }, { dsapi: { env, home: mkHome(), fetchImpl: f } });
  assert.equal(f.calls[0].body.model, "deepseek-v6-flash");
  assert.equal(r.engine, "dsapi:deepseek-v6-flash");
  const g = fakeFetch([ok({ content: "x" })]);
  const bad = await runSpec("dsapi:deepseek-reasoner", { prompt: "p", cwd: ".", timeoutSec: 300 }, { dsapi: { env, home: mkHome(), fetchImpl: g } });
  assert.match(bad.reason, /dsapi is limited to flash/);
  assert.equal(g.calls.length, 0);
});

test("parseOrder: dsapi and dsapi:<model> entries; dsapi:<default model> is bare dsapi", () => {
  assert.deepEqual(parseOrder("copilot,codex,deepseek,dsapi"), ["copilot", "codex", "deepseek", "dsapi"]);
  assert.deepEqual(parseOrder("dsapi:deepseek-reasoner,codex"), ["dsapi:deepseek-reasoner", "codex"]); // refused later by the engine
  assert.deepEqual(parseOrderDetailed("dsapi:").dropped, ["dsapi:"]);
  assert.deepEqual(parseOrder(`dsapi,dsapi:${DEFAULT_DSAPI_MODEL}`), ["dsapi"]);
  assert.deepEqual(parseOrder("dsapi:deepseek-v6-flash,dsapi", undefined, { dsapiModel: "deepseek-v6-flash" }), ["dsapi"]);
});

test("default order does not include dsapi", () => {
  assert.deepEqual(parseOrder(undefined), ["copilot", "codex", "deepseek", "agy", "nim", "openrouter"]);
});

test("parseArgs: --dsapi-model", () => {
  assert.equal(parseArgs(["--dsapi-model", "deepseek-flash", "hi"]).dsapiModel, "deepseek-flash");
  assert.equal(parseArgs(["hi"]).dsapiModel, null);
});

// --- OpenRouter credit first (2026-10-28) ---
const OR_KEY = "sk-or-" + "cd34".repeat(8);
const orEnv = { DEEPSEEK_API_KEY: FAKE_KEY, OPENROUTER_API_KEY: OR_KEY };
const runOr = (fetchImpl, extraEnv = {}) =>
  ENGINES.dsapi({ prompt: "hi", env: { ...orEnv, ...extraEnv }, home: mkHome(), sleep: naps(), fetchImpl });
const byHost = (or, ds) => (url) => (url.startsWith("https://openrouter.ai/") ? or : ds);

test("dsapi: with an OpenRouter key the credit goes first, model pinned, data_collection deny", async () => {
  resetDsOpenRouterState();
  const f = fakeFetch(byHost(ok({ content: "via or" }), ok({ content: "via ds" })));
  const r = await runOr(f);
  assert.deepEqual(r, { engine: "dsapi", ok: true, body: "via or", upstream: "openrouter" });
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(init.headers.Authorization, `Bearer ${OR_KEY}`);
  assert.equal(body.model, DSAPI_OR_MODEL);
  assert.equal(body.model, "deepseek/deepseek-v4.1-flash");
  assert.deepEqual(body.provider, { data_collection: "deny" });
});

test("dsapi: a model argument cannot move the OpenRouter call off the pinned flash id", async () => {
  resetDsOpenRouterState();
  const f = fakeFetch(byHost(ok({ content: "x" }), ok({ content: "y" })));
  await runOr(f, {}).then(() => {});
  const g = fakeFetch(byHost(ok({ content: "x" }), ok({ content: "y" })));
  await ENGINES.dsapi({ prompt: "hi", model: "deepseek-v9-flash", env: orEnv, home: mkHome(), sleep: naps(), fetchImpl: g });
  assert.equal(g.calls[0].body.model, DSAPI_OR_MODEL);
  const h = fakeFetch(byHost(ok({ content: "x" }), ok({ content: "y" })));
  const bad = await ENGINES.dsapi({ prompt: "hi", model: "deepseek-v4-pro", env: orEnv, home: mkHome(), sleep: naps(), fetchImpl: h });
  assert.equal(bad.ok, false);
  assert.equal(h.calls.length, 0);
});

test("dsapi: 402 from OpenRouter falls back to the official API and stays there for the process", async () => {
  resetDsOpenRouterState();
  const f = fakeFetch(byHost(status(402, "no credit"), ok({ content: "via ds" })));
  const r = await runOr(f);
  assert.deepEqual(r, { engine: "dsapi", ok: true, body: "via ds" });
  assert.deepEqual(f.calls.map((c) => c.url), ["https://openrouter.ai/api/v1/chat/completions", "https://api.deepseek.com/chat/completions"]);
  const g = fakeFetch(byHost(ok({ content: "via or" }), ok({ content: "via ds" })));
  const r2 = await runOr(g);
  assert.equal(r2.body, "via ds");
  assert.deepEqual(g.calls.map((c) => c.url), ["https://api.deepseek.com/chat/completions"]);
  resetDsOpenRouterState();
});

test("dsapi: a 5xx or 429 from OpenRouter falls back for that request only", async () => {
  resetDsOpenRouterState();
  const f = fakeFetch(byHost(status(503, "down"), ok({ content: "via ds" })));
  assert.equal((await runOr(f)).body, "via ds");
  const g = fakeFetch(byHost(ok({ content: "via or" }), ok({ content: "via ds" })));
  assert.equal((await runOr(g)).body, "via or");
});

test("dsapi: DS_UPSTREAM=deepseek forces the official API; no OpenRouter key means no OpenRouter call", async () => {
  resetDsOpenRouterState();
  const f = fakeFetch(byHost(ok({ content: "via or" }), ok({ content: "via ds" })));
  assert.equal((await runOr(f, { DS_UPSTREAM: "deepseek" })).body, "via ds");
  assert.deepEqual(f.calls.map((c) => c.url), ["https://api.deepseek.com/chat/completions"]);
  const g = fakeFetch(byHost(ok({ content: "via or" }), ok({ content: "via ds" })));
  assert.equal((await run(g)).body, "via ds");
});

test("dsapi: OpenRouter only (no DeepSeek key) works; its failure is reported, the key never leaks", async () => {
  resetDsOpenRouterState();
  const f = fakeFetch(byHost(ok({ content: "via or" }), status(500)));
  const r = await ENGINES.dsapi({ prompt: "hi", env: { OPENROUTER_API_KEY: OR_KEY }, home: mkHome(), sleep: naps(), fetchImpl: f });
  assert.equal(r.body, "via or");
  const g = fakeFetch(byHost(status(402, `credit ${OR_KEY}`), status(500)));
  const r2 = await ENGINES.dsapi({ prompt: "hi", env: { OPENROUTER_API_KEY: OR_KEY }, home: mkHome(), sleep: naps(), fetchImpl: g });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /HTTP 402/);
  assert.ok(!r2.reason.includes(OR_KEY));
  resetDsOpenRouterState();
});

test("orFreeReserve: env wins (non-negative integer), else the caller default", () => {
  assert.equal(orFreeReserve({}), 50);
  assert.equal(orFreeReserve({}, 200), 200);
  assert.equal(orFreeReserve({ OR_FREE_RESERVE: "7" }, 200), 7);
  assert.equal(orFreeReserve({ OR_FREE_RESERVE: "x" }, 200), 200);
});

test("openRouterFreeRemaining: reads /v1/key, caches for 60 s, null on errors", async () => {
  resetOrFreeCache();
  let n = 0;
  const f = async () => (n++, new Response(JSON.stringify({ data: { free_model_daily_requests: { remaining: 913 } } }), { status: 200 }));
  assert.equal(await openRouterFreeRemaining({ key: OR_KEY, fetchImpl: f, now: 1000 }), 913);
  assert.equal(await openRouterFreeRemaining({ key: OR_KEY, fetchImpl: f, now: 30000 }), 913);
  assert.equal(n, 1);
  assert.equal(await openRouterFreeRemaining({ key: OR_KEY, fetchImpl: f, now: 90000 }), 913);
  assert.equal(n, 2);
  resetOrFreeCache();
  assert.equal(await openRouterFreeRemaining({ key: OR_KEY, fetchImpl: async () => new Response("x", { status: 500 }) }), null);
  assert.equal(await openRouterFreeRemaining({ key: "", fetchImpl: f }), null);
  resetOrFreeCache();
});

test("openrouter chain: OR_FREE_RESERVE skips :free models when the pool is at or under the reserve", async () => {
  resetOrFreeCache();
  const urls = [];
  const f = async (url) => {
    urls.push(url);
    return url.endsWith("/v1/key")
      ? new Response(JSON.stringify({ data: { free_model_daily_requests: { remaining: 40 } } }), { status: 200 })
      : new Response(JSON.stringify(reply({ content: "never" })), { status: 200 });
  };
  const r = await ENGINES.openrouter({ prompt: "hi", env: { OPENROUTER_API_KEY: OR_KEY, OR_FREE_RESERVE: "50" }, home: mkHome(), sleep: naps(), fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /reserve 50/);
  assert.ok(urls.every((u) => u.endsWith("/v1/key")));
  resetOrFreeCache();
});
