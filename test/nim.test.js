import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseOrder, parseOrderDetailed, resolvePrompt, parseArgs, nonBlank } from "../lib/args.js";
import {
  ENGINES, DEFAULT_NIM_MODEL, resolveNimKey, extractAnswer, redact, retryDelayMs, parseSpec, runSpec,
} from "../lib/engines.js";
import { safeFileName, writeEngineResult, runChain, isFinal, formatSection, lastResortNote, authHint } from "../lib/panel.js";

// Built at runtime so no key-shaped literal lands in the repo.
const FAKE_KEY = "nv" + "api-" + "x".repeat(20);

const reply = (message, finish_reason = "stop") => ({ choices: [{ message, finish_reason }] });
const jsonRes = (obj, init) => new Response(JSON.stringify(obj), { status: 200, ...init });

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
const sleeper = () => {
  const fn = async (ms) => void fn.slept.push(ms);
  fn.slept = [];
  return fn;
};
const envWithKey = { NIM_API_KEY: FAKE_KEY };

test("resolveNimKey: env > NIM_KEY_PATH file > home default > missing", () => {
  const files = { "/custom/key": " from-custom \n", [path.join("/h", ".nvidia-nim-key")]: "from-home\n" };
  const readFile = (p) => {
    if (p in files) return files[p];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.equal(resolveNimKey({ env: { NIM_API_KEY: "from-env", NIM_KEY_PATH: "/custom/key" }, home: "/h", readFile }), "from-env");
  assert.equal(resolveNimKey({ env: { NIM_KEY_PATH: "/custom/key" }, home: "/h", readFile }), "from-custom");
  assert.equal(resolveNimKey({ env: {}, home: "/h", readFile }), "from-home");
  assert.equal(resolveNimKey({ env: {}, home: "/nowhere", readFile }), "");
  assert.equal(resolveNimKey({ env: { NIM_KEY_PATH: "/missing" }, home: "/h", readFile }), "");
});

test("extractAnswer: plain, think-stripped, unterminated think", () => {
  assert.deepEqual(extractAnswer(reply({ content: "  hi  " })), { ok: true, body: "hi" });
  assert.equal(extractAnswer(reply({ content: "<think>a\nb</think>\n\nanswer" })).body, "answer");
  assert.equal(extractAnswer(reply({ content: "\n <think>a</think>\nanswer" })).body, "answer");
  const only = extractAnswer(reply({ content: "<think>never finished" }));
  assert.equal(only.ok, true);
  assert.equal(only.degraded, true);
  assert.match(only.body, /^\[reasoning only: model returned no final answer\]\n\nnever finished$/);
});

test("extractAnswer: tags quoted inside a real answer never truncate it", () => {
  const quoted = "Wrap reasoning in <think> tags; the parser strips them.";
  assert.equal(extractAnswer(reply({ content: quoted })).body, quoted);
  const both = "Use `<think>` then `</think>` around reasoning.";
  assert.equal(extractAnswer(reply({ content: `<think>a</think>${both}` })).body, both);
  assert.equal(extractAnswer(reply({ content: both })).body, both);
  // Only a LEADING block is reasoning: a mid-text block or orphan closer is kept verbatim.
  assert.equal(extractAnswer(reply({ content: "pre<think>x</think>post" })).body, "pre<think>x</think>post");
  assert.equal(extractAnswer(reply({ content: "scratch</think>final" })).body, "scratch</think>final");
  assert.equal(extractAnswer(reply({ content: "ok" })).degraded, undefined);
});

test("extractAnswer: reasoning_content / reasoning fallback with marker", () => {
  const a = extractAnswer(reply({ content: "", reasoning_content: "thinking" }));
  assert.equal(a.body, "[reasoning only: model returned no final answer]\n\nthinking");
  const b = extractAnswer(reply({ content: null, reasoning: "<think>alt</think>" }));
  assert.equal(b.body, "[reasoning only: model returned no final answer]\n\nalt");
  assert.equal(extractAnswer(reply({ content: "ans", reasoning_content: "ignored" })).body, "ans");
});

test("extractAnswer: nothing usable is a failure, length adds a note", () => {
  assert.deepEqual(extractAnswer(reply({ content: "" }, "stop")), { ok: false, reason: "empty output (finish_reason: stop)" });
  assert.match(extractAnswer(reply({ content: "<think>x</think>" })).body, /^\[reasoning only/); // think block as last resort
  assert.equal(extractAnswer({}).ok, false);
  assert.match(extractAnswer({}).reason, /^empty output \(finish_reason: unknown\)$/);
  assert.equal(extractAnswer(reply({ content: "cut off" }, "length")).body, "cut off\n\n[truncated: hit max_tokens]");
  assert.match(extractAnswer(reply({ content: "", reasoning: "r" }, "length")).body, /\[truncated: hit max_tokens\]$/);
  assert.equal(extractAnswer(reply({ content: "" }, "length")).reason, "empty output (finish_reason: length)");
});

test("retryDelayMs: numeric Retry-After, default 5 s, capped at 15 s", () => {
  assert.equal(retryDelayMs("2"), 2000);
  assert.equal(retryDelayMs("0"), 0);
  assert.equal(retryDelayMs(null), 5000);
  assert.equal(retryDelayMs("Wed, 21 Oct 2026 07:28:00 GMT"), 5000);
  assert.equal(retryDelayMs("120"), 15000);
});

test("nim: request shape, label, default model and max_tokens", async () => {
  const f = fakeFetch([() => jsonRes(reply({ content: "pong" }))]);
  const r = await ENGINES.nim({ prompt: "ping", timeoutSec: 5, env: envWithKey, fetchImpl: f });
  assert.deepEqual(r, { engine: `nim:${DEFAULT_NIM_MODEL}`, ok: true, body: "pong" });
  assert.equal(f.calls[0].url, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(f.calls[0].body, {
    model: DEFAULT_NIM_MODEL, stream: false, max_tokens: 8192, messages: [{ role: "user", content: "ping" }],
  });
});

test("nim: env overrides (model, base, max tokens); per-call model wins", async () => {
  const env = { ...envWithKey, NIM_MODEL: "env/model", NIM_BASE: "http://nim.test/", NIM_MAX_TOKENS: "123" };
  const f = fakeFetch([() => jsonRes(reply({ content: "a" })), () => jsonRes(reply({ content: "b" }))]);
  const r1 = await ENGINES.nim({ prompt: "p", timeoutSec: 5, env, fetchImpl: f });
  assert.equal(r1.engine, "nim:env/model");
  assert.equal(f.calls[0].url, "http://nim.test/v1/chat/completions");
  assert.equal(f.calls[0].body.max_tokens, 123);
  const r2 = await ENGINES.nim({ prompt: "p", timeoutSec: 5, env, model: "call/model", fetchImpl: f });
  assert.equal(r2.engine, "nim:call/model");
  assert.equal(f.calls[1].body.model, "call/model");
});

test("nim: missing key fails without touching the network", async () => {
  const f = fakeFetch([]);
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 5, env: {}, home: "/nowhere", readFile: () => { throw new Error("no"); }, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no NIM_API_KEY (env or ~/.nvidia-nim-key)");
  assert.equal(f.calls.length, 0);
});

test("nim: 429 then success retries once after Retry-After", async () => {
  const f = fakeFetch([
    () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
    () => jsonRes(reply({ content: "ok" })),
  ]);
  const sleep = sleeper();
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 30, env: envWithKey, fetchImpl: f, sleep });
  assert.equal(r.ok, true);
  assert.equal(r.body, "ok");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(sleep.slept, [3000]);
});

test("nim: 429 twice -> rate-limited failure, exactly 2 calls, sleep capped", async () => {
  const f = fakeFetch([() => new Response("x", { status: 429, headers: { "retry-after": "999" } })]);
  const sleep = sleeper();
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 30, env: envWithKey, fetchImpl: f, sleep });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "rate limited (HTTP 429, after 1 retry; key shares a ~40 RPM trial budget)");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(sleep.slept, [15000]);
});

test("nim: 429 whose retry delay leaves no time fails immediately without sleeping", async () => {
  const f = fakeFetch([() => new Response("x", { status: 429, headers: { "retry-after": "6" } })]);
  const sleep = sleeper();
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 10, env: envWithKey, fetchImpl: f, sleep });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^rate limited \(HTTP 429, no time left to retry/);
  assert.equal(f.calls.length, 1);
  assert.equal(sleep.slept.length, 0);
});

test("nim: reasoning-only reply is ok but degraded; chain falls over, panel keeps it", async () => {
  const reasoningOnly = () => jsonRes(reply({ content: "", reasoning_content: "thinking hard" }));
  const f = fakeFetch([reasoningOnly]);
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 5, env: envWithKey, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.match(r.body, /^\[reasoning only/);

  const run = async (name) => (name === "nim" ? r : { engine: name, ok: true, body: "real answer" });
  const chain = await runChain(["nim", "codex"], run);
  assert.equal(chain.result.engine, "codex");
  assert.deepEqual(chain.trail, ["nim:" + DEFAULT_NIM_MODEL + ": reasoning only, no final answer"]);
  assert.equal(isFinal(r), false);
  // Every engine reasoning-only: the first one is returned as a last resort, flagged degraded.
  const last = await runChain(["nim", "nim"], run);
  assert.equal(last.result, r);
  assert.equal(last.trail.length, 2);
  assert.match(lastResortNote(last.result), /^no final answer from any engine; showing nim:.* reasoning$/);
  assert.equal(lastResortNote({ ok: true, body: "x" }), null);
  // Outright failures still end in null.
  assert.equal((await runChain(["a"], async () => ({ engine: "a", ok: false, reason: "boom" }))).result, null);
  assert.equal(formatSection(r).startsWith(`## nim:${DEFAULT_NIM_MODEL}\n\n[reasoning only`), true);
});

test("nim: 429 without Retry-After waits 5 s", async () => {
  const f = fakeFetch([() => new Response("", { status: 429 }), () => jsonRes(reply({ content: "ok" }))]);
  const sleep = sleeper();
  await ENGINES.nim({ prompt: "p", timeoutSec: 30, env: envWithKey, fetchImpl: f, sleep });
  assert.deepEqual(sleep.slept, [5000]);
});

test("nim: non-2xx detail is truncated and redacted, no retry", async () => {
  const leaked = `bad key ${FAKE_KEY} ${"z".repeat(500)}`;
  const f = fakeFetch([() => new Response(leaked, { status: 401 })]);
  const sleep = sleeper();
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 5, env: envWithKey, fetchImpl: f, sleep });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^HTTP 401: bad key nvapi-\*\*\* z+$/);
  assert.ok(!r.reason.includes(FAKE_KEY));
  assert.ok(r.reason.length < 330);
  assert.equal(f.calls.length, 1);
  assert.equal(sleep.slept.length, 0);
});

test("nim: timeout and network errors are reported, key redacted", async () => {
  const timeout = async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 7, env: envWithKey, fetchImpl: timeout });
  assert.match(r.reason, /^timed out after 7s/);
  const boom = async () => { throw new Error(`connect failed for ${FAKE_KEY}`); };
  const r2 = await ENGINES.nim({ prompt: "p", timeoutSec: 7, env: envWithKey, fetchImpl: boom });
  assert.match(r2.reason, /^unreachable: connect failed for nvapi-\*\*\*/);
  assert.ok(!r2.reason.includes(FAKE_KEY));
});

test("nim: empty answer becomes a failure with finish_reason", async () => {
  const f = fakeFetch([() => jsonRes(reply({ content: "" }, "length"))]);
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 5, env: envWithKey, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty output (finish_reason: length)");
});

test("redact: masks nvapi keys and an explicit secret", () => {
  assert.equal(redact(`a ${FAKE_KEY} b nv${"api-"}A_b-9 c`), "a nvapi-*** b nvapi-*** c");
  assert.equal(redact("tok-123 here", "tok-123"), "*** here");
  assert.equal(redact("nothing to hide"), "nothing to hide");
});

test("parseSpec: splits on the first colon only", () => {
  assert.deepEqual(parseSpec("codex"), { engine: "codex", model: null });
  assert.deepEqual(parseSpec("nim:moonshotai/kimi-k3"), { engine: "nim", model: "moonshotai/kimi-k3" });
  assert.deepEqual(parseSpec("nim:a:b"), { engine: "nim", model: "a:b" });
});

test("parseOrder: engine:model specs, filtering, dedupe, default", () => {
  assert.deepEqual(
    parseOrder("nim:moonshotai/kimi-k3, nim:z-ai/glm-5.3 ,codex"),
    ["nim:moonshotai/kimi-k3", "nim:z-ai/glm-5.3", "codex"],
  );
  assert.deepEqual(parseOrder("nim:a:b"), ["nim:a:b"]);
  assert.deepEqual(parseOrder("agy:x,grok:y,codex:gpt,copilot:m,deepseek:v"), ["codex:gpt", "copilot:m", "deepseek:v"]);
  assert.deepEqual(parseOrder("nim:,nim,nope:x,:y"), ["nim"]);
  assert.deepEqual(parseOrder("nim:a,codex,nim:a,codex,nim"), ["nim:a", "codex", "nim"]);
  assert.deepEqual(parseOrder(""), ["copilot", "codex"]);
});

test("runSpec: nim:a/b routes to nim with model a/b and flag model as fallback", async () => {
  const f = fakeFetch([() => jsonRes(reply({ content: "x" }))]);
  const base = { prompt: "q", cwd: "/w", timeoutSec: 5, env: envWithKey, fetchImpl: f };
  const r = await runSpec("nim:a/b", base, { nim: { model: "flag/model" } });
  assert.equal(r.engine, "nim:a/b");
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].body.model, "a/b");

  const r2 = await runSpec("nim", base, { nim: { model: "flag/model" } });
  assert.equal(r2.engine, "nim:flag/model");
  assert.equal(f.calls[1].body.model, "flag/model");

  const r3 = await runSpec("nim", base, { nim: { model: null } });
  assert.equal(r3.engine, `nim:${DEFAULT_NIM_MODEL}`);
});

test("runSpec: unknown engine fails cleanly", async () => {
  const r = await runSpec("nope:x", { prompt: "q", cwd: "/w", timeoutSec: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown engine");
});

test("safeFileName / writeEngineResult: spec names stay in one flat dir", () => {
  assert.equal(safeFileName("nim:z-ai/glm-5.3"), "nim_z-ai_glm-5.3");
  assert.equal(safeFileName("codex"), "codex");
  assert.ok(!safeFileName("..\\..\\x").startsWith("."));
  assert.ok(!/[\\/:]/.test(safeFileName("a/b\\c:d")));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-nim-"));
  writeEngineResult(dir, "nim:z-ai/glm-5.3", { engine: "nim:z-ai/glm-5.3", ok: true, body: "hi" });
  assert.deepEqual(fs.readdirSync(dir), ["nim_z-ai_glm-5.3.md"]);
});

test("parseOrderDetailed: reports dropped entries, ignores empty segments", () => {
  assert.deepEqual(parseOrderDetailed("codex,nope,agy:x,,nim:a/b"), { order: ["codex", "nim:a/b"], dropped: ["nope", "agy:x"] });
  assert.deepEqual(parseOrderDetailed("agy:x"), { order: [], dropped: ["agy:x"] });
  assert.deepEqual(parseOrderDetailed(undefined), { order: ["copilot", "codex"], dropped: [] });
});

test("resolvePrompt: words, --prompt-file, stdin, and misuse", () => {
  const files = { "/p.txt": "  big diff\n" };
  const readFile = (p) => {
    if (p in files) return files[p];
    throw new Error("ENOENT");
  };
  const readStdin = () => "from stdin\n";
  assert.equal(resolvePrompt({ prompt: ["a", "b"], promptFile: null }, { readFile, readStdin }), "a b");
  assert.equal(resolvePrompt({ prompt: [], promptFile: "/p.txt" }, { readFile, readStdin }), "big diff");
  assert.equal(resolvePrompt({ prompt: [], promptFile: "-" }, { readFile, readStdin }), "from stdin");
  assert.throws(() => resolvePrompt({ prompt: ["x"], promptFile: "/p.txt" }, { readFile, readStdin }), /not both/);
  assert.throws(() => resolvePrompt({ prompt: [], promptFile: "/missing" }, { readFile, readStdin }), /cannot read prompt from \/missing/);
  assert.equal(parseArgs(["--prompt-file", "-"]).promptFile, "-");
});

test("parseOrder: bare nim and nim:<default model> are one entry", () => {
  assert.deepEqual(parseOrder(`nim,nim:${DEFAULT_NIM_MODEL},codex`), ["nim", "codex"]);
  assert.deepEqual(parseOrder(`nim:${DEFAULT_NIM_MODEL},nim`), ["nim"]);
  assert.deepEqual(parseOrder("nim:other/m,nim"), ["nim:other/m", "nim"]);
  // The model a bare nim resolves to (flag/env) is the one that collapses.
  assert.deepEqual(parseOrder("nim,nim:x/y,nim:" + DEFAULT_NIM_MODEL, undefined, { nimModel: "x/y" }), ["nim", "nim:" + DEFAULT_NIM_MODEL]);
});

test("nonBlank: [''] and whitespace mean no order given", () => {
  assert.deepEqual(nonBlank([""]), []);
  assert.deepEqual(nonBlank(["  ", "codex", ""]), ["codex"]);
  assert.deepEqual(nonBlank(undefined), []);
});

test("authHint: only for auth/launch-looking failures", () => {
  assert.match(authHint(["codex: exit 1: Not logged in, please login"]), /Check auth/);
  assert.match(authHint(["agy: not installed (looked in /x)"]), /Check auth/);
  assert.match(authHint(["nim:m: HTTP 401: bad key"]), /Check auth/);
  assert.equal(authHint(["nim:m: rate limited (HTTP 429, after 1 retry; key shares a ~40 RPM trial budget)"]), "");
  assert.equal(authHint(["codex: timed out after 300s", "nim:m: reasoning only, no final answer"]), "");
  assert.equal(authHint(["a: timed out", "copilot: exit 1: authentication required"]).includes("Check auth"), true);
});

test("nim: a key echoed in a successful body is redacted", async () => {
  const echo = `my key is ${FAKE_KEY} and again ${FAKE_KEY.slice(0, 12)}tail; custom secret too`;
  const f = fakeFetch([() => jsonRes(reply({ content: echo }))]);
  const r = await ENGINES.nim({ prompt: "p", timeoutSec: 5, env: { NIM_API_KEY: "plain-secret-token" }, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.ok(!r.body.includes("plain-secret-token"));
  const g = fakeFetch([() => jsonRes(reply({ content: echo }))]);
  const r2 = await ENGINES.nim({ prompt: "p", timeoutSec: 5, env: envWithKey, fetchImpl: g });
  assert.ok(!r2.body.includes(FAKE_KEY));
  assert.match(r2.body, /^my key is nvapi-\*\*\* and again/);
  const h = fakeFetch([() => jsonRes(reply({ content: "", reasoning_content: `think ${FAKE_KEY}` }))]);
  assert.ok(!(await ENGINES.nim({ prompt: "p", timeoutSec: 5, env: envWithKey, fetchImpl: h })).body.includes(FAKE_KEY));
});

test("safeFileName: Windows reserved device names get a _ prefix", () => {
  for (const n of ["con", "CON", "prn", "Aux", "nul", "com1", "COM9", "lpt3", "con.x"]) assert.equal(safeFileName(n), `_${n}`);
  for (const n of ["com0", "console", "nim_con", "codex", "lpt10"]) assert.equal(safeFileName(n), n);
});
