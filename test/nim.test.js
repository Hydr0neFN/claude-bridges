import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseOrder, parseOrderDetailed, resolvePrompt, parseArgs, nonBlank } from "../lib/args.js";
import {
  ENGINES, DEFAULT_NIM_MODEL, nimTimeoutSec, resolveNimKey, extractAnswer, redact, retryDelayMs, parseSpec, runSpec,
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
    model: DEFAULT_NIM_MODEL, stream: true, max_tokens: 8192, messages: [{ role: "user", content: "ping" }],
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
  assert.deepEqual(parseOrder(""), ["copilot", "codex", "deepseek"]);
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
  assert.deepEqual(parseOrderDetailed(undefined), { order: ["copilot", "codex", "deepseek"], dropped: [] });
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

test("nimTimeoutSec: default 600, NIM_TIMEOUT honoured, clamped to 600, garbage -> 600, CONSULT_TIMEOUT ignored", () => {
  assert.equal(nimTimeoutSec({}), 600);
  assert.equal(nimTimeoutSec({ NIM_TIMEOUT: "120" }), 120);
  assert.equal(nimTimeoutSec({ NIM_TIMEOUT: "1.5" }), 1.5);
  assert.equal(nimTimeoutSec({ NIM_TIMEOUT: "9999" }), 600);
  for (const bad of ["abc", "", "0", "-5", "NaN", "Infinity"]) assert.equal(nimTimeoutSec({ NIM_TIMEOUT: bad }), 600, bad);
  assert.equal(nimTimeoutSec({ CONSULT_TIMEOUT: "30" }), 600);
});

test("runSpec: nim gets its own timeout, not the caller's", async () => {
  const timeout = async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
  const base = { prompt: "q", cwd: "/w", timeoutSec: 300, fetchImpl: timeout };
  const r = await runSpec("nim", { ...base, env: envWithKey });
  assert.match(r.reason, /^timed out after 600s/);
  const r2 = await runSpec("nim", { ...base, env: { ...envWithKey, NIM_TIMEOUT: "120" } });
  assert.match(r2.reason, /^timed out after 120s/);
  const r3 = await runSpec("nim", { ...base, env: { ...envWithKey, NIM_TIMEOUT: "9999" } });
  assert.match(r3.reason, /^timed out after 600s/);
  // Direct engine call without a timeout also falls back to NIM_TIMEOUT / 600.
  const r4 = await ENGINES.nim({ prompt: "p", env: { ...envWithKey, NIM_TIMEOUT: "90" }, fetchImpl: timeout });
  assert.match(r4.reason, /^timed out after 90s/);
});

// --- SSE streaming ---

const sse = (o) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;
const delta = (d, finish_reason = null) => sse({ choices: [{ delta: d, finish_reason }] });
/** Response whose body yields `chunks` (strings, split exactly as given), then ends or errors with `err`. */
function streamRes(chunks, { err, status = 200, type = "text/event-stream" } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  // Pull-based: c.error() would discard chunks still queued, but a real abort arrives after they were read.
  const body = new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else if (err) c.error(err);
      else c.close();
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status, headers: { "content-type": type } });
}
const timeoutErr = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });
const runNim = (f, extra = {}) => ENGINES.nim({ prompt: "p", timeoutSec: 5, env: envWithKey, fetchImpl: f, ...extra });

test("nim stream: sends stream:true + Accept, joins content across chunks split mid-line, stops at [DONE]", async () => {
  const wire = delta({ role: "assistant" }) + delta({ content: "Hel" }) + ": keep-alive\n\n" + delta({ content: "lo wörld" }) +
    delta({}, "stop") + sse("[DONE]") + delta({ content: "IGNORED" });
  // Cut into 7-char pieces so lines (and a multibyte char) straddle reads.
  const bytes = new TextEncoder().encode(wire);
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.slice(i, i + 7));
  const body = new ReadableStream({ start(c) { pieces.forEach((p) => c.enqueue(p)); c.close(); } });
  const f = fakeFetch([() => new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } })]);
  const r = await runNim(f);
  assert.deepEqual(r, { engine: `nim:${DEFAULT_NIM_MODEL}`, ok: true, body: "Hello wörld" });
  assert.equal(f.calls[0].body.stream, true);
  assert.equal(f.calls[0].init.headers.Accept, "text/event-stream");
});

test("nim stream: reasoning deltas then content; <think> and reasoning_content behave like non-stream", async () => {
  const f = fakeFetch([() => streamRes([
    delta({ reasoning_content: "thinking " }), delta({ reasoning: "more" }), delta({ content: "the answer" }), delta({}, "stop"), sse("[DONE]"),
  ])]);
  assert.equal((await runNim(f)).body, "the answer");
  const g = fakeFetch([() => streamRes([delta({ reasoning_content: "only " }), delta({ reasoning_content: "thoughts" }, "stop")])]);
  const r = await runNim(g);
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.equal(r.body, "[reasoning only: model returned no final answer]\n\nonly thoughts");
  const h = fakeFetch([() => streamRes([delta({ content: "<think>plan</think>" }), delta({ content: "final" }, "stop")])]);
  assert.equal((await runNim(h)).body, "final");
});

test("nim stream: finish_reason length adds the truncation note; last chunk with a finish wins", async () => {
  const f = fakeFetch([() => streamRes([delta({ content: "cut" }, "length"), delta({})])]);
  assert.equal((await runNim(f)).body, "cut\n\n[truncated: hit max_tokens]");
  const g = fakeFetch([() => streamRes([delta({ content: "a" }, "length"), delta({ content: "b" }, "stop")])]);
  assert.equal((await runNim(g)).body, "ab");
});

test("nim stream: stream ending without [DONE] or trailing newline still parses the last line", async () => {
  const f = fakeFetch([() => streamRes([`data: ${JSON.stringify({ choices: [{ delta: { content: "tail" }, finish_reason: "stop" }] })}`])]);
  assert.equal((await runNim(f)).body, "tail");
});

test("nim stream: abort mid-stream keeps partial content with a timeout note (ok, not degraded)", async () => {
  const f = fakeFetch([() => streamRes([delta({ content: "partial " }), delta({ content: "text" })], { err: timeoutErr() })]);
  const r = await runNim(f, { timeoutSec: 9 });
  assert.deepEqual(r, { engine: `nim:${DEFAULT_NIM_MODEL}`, ok: true, body: "partial text\n\n[truncated: timed out after 9s]" });
});

test("nim stream: abort with only reasoning is reasoning-only; with nothing it is a plain timeout", async () => {
  const f = fakeFetch([() => streamRes([delta({ reasoning_content: "hmm" })], { err: timeoutErr() })]);
  const r = await runNim(f);
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.match(r.body, /^\[reasoning only/);
  const g = fakeFetch([() => streamRes([], { err: timeoutErr() })]);
  const r2 = await runNim(g, { timeoutSec: 9 });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /^timed out after 9s/);
});

test("nim stream: a non-timeout interruption keeps partial text and is labelled, key redacted", async () => {
  const f = fakeFetch([() => streamRes([delta({ content: "some" })], { err: new Error(`reset ${FAKE_KEY}`) })]);
  const r = await runNim(f);
  assert.equal(r.ok, true);
  assert.match(r.body, /^some\n\n\[truncated: stream interrupted: reset nvapi-\*\*\*\]$/);
  assert.ok(!r.body.includes(FAKE_KEY));
});

test("nim: undici header/body timeouts get a clear reason instead of 'fetch failed'", async () => {
  const undici = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  const r = await runNim(async () => { throw undici("UND_ERR_HEADERS_TIMEOUT"); });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^no response headers within ~300 s \(client limit/);
  assert.ok(!/fetch failed|unreachable/.test(r.reason));
  const g = fakeFetch([() => streamRes([delta({ content: "part" })], { err: undici("UND_ERR_BODY_TIMEOUT") })]);
  const r2 = await runNim(g);
  assert.equal(r2.ok, true);
  assert.equal(r2.body, "part\n\n[truncated: stream stalled, no data for ~300 s (client limit)]");
  const h = fakeFetch([() => streamRes([], { err: undici("UND_ERR_BODY_TIMEOUT") })]);
  assert.match((await runNim(h)).reason, /^stream stalled, no data for ~300 s/);
  const boom = await runNim(async () => { throw new Error("ECONNREFUSED"); });
  assert.match(boom.reason, /^unreachable: ECONNREFUSED/);
});

test("nim stream: in-stream error event with no text is a failure", async () => {
  const f = fakeFetch([() => streamRes([sse({ error: { message: "model overloaded" } })])]);
  const r = await runNim(f);
  assert.equal(r.ok, false);
  assert.match(r.reason, /stream error: model overloaded/);
});

test("nim stream: HTTP 504 gets the ~300 s gateway message, 502 a plain gateway error with detail; no retry", async () => {
  const f = fakeFetch([() => new Response("<html>gateway</html>", { status: 504 })]);
  const sleep = sleeper();
  const r = await runNim(f, { sleep });
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    "NVIDIA gateway timeout (HTTP 504: the model did not start answering within ~300 s; free-tier queue stalled, try another model)",
  );
  assert.equal(f.calls.length, 1);
  assert.equal(sleep.slept.length, 0);

  const g = fakeFetch([() => new Response(`bad gateway for ${FAKE_KEY} ${"x".repeat(500)}`, { status: 502 })]);
  const r2 = await runNim(g, { sleep });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /^NVIDIA gateway error \(HTTP 502\): bad gateway for nvapi-\*\*\* x+$/);
  assert.ok(!r2.reason.includes("~300 s") && !r2.reason.includes(FAKE_KEY));
  assert.ok(r2.reason.length < 380);
  assert.equal(g.calls.length, 1);
  const h = fakeFetch([() => new Response("", { status: 502 })]);
  assert.equal((await runNim(h)).reason, "NVIDIA gateway error (HTTP 502)");
});

test("nim stream: 429 is still retried once, then the stream is read", async () => {
  const f = fakeFetch([
    () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
    () => streamRes([delta({ content: "ok" }, "stop")]),
  ]);
  const sleep = sleeper();
  const r = await runNim(f, { timeoutSec: 30, sleep });
  assert.equal(r.body, "ok");
  assert.deepEqual(sleep.slept, [1000]);
});

test("nim stream: a JSON reply (not event-stream) is parsed as a normal completion", async () => {
  const f = fakeFetch([() => jsonRes(reply({ content: "plain json" }), { headers: { "content-type": "application/json" } })]);
  assert.equal((await runNim(f)).body, "plain json");
});

test("nim stream: a key echoed in streamed text is redacted; deepseek stays non-streamed", async () => {
  const f = fakeFetch([() => streamRes([delta({ content: `key ${FAKE_KEY}` }, "stop")])]);
  const r = await runNim(f);
  assert.ok(!r.body.includes(FAKE_KEY));
  const d = fakeFetch([() => jsonRes(reply({ content: "x" }))]);
  const prev = process.env.DEEPSEEKER_API_KEY;
  process.env.DEEPSEEKER_API_KEY = "ds-test";
  try {
    await ENGINES.deepseek({ prompt: "p", timeoutSec: 5, fetchImpl: d });
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEKER_API_KEY;
    else process.env.DEEPSEEKER_API_KEY = prev;
  }
  assert.equal(d.calls[0].body.stream, false);
  assert.equal(d.calls[0].init.headers.Accept, undefined);
});

test("nim stream: one event may span several data: lines (joined with newline), any line ending, optional space", async () => {
  const payload = JSON.stringify({ choices: [{ delta: { content: "joined" }, finish_reason: "stop" }] });
  const cut = payload.indexOf("\"delta\"");
  const event = `event: message\nid: 1\n: comment\ndata: ${payload.slice(0, cut)}\ndata:${payload.slice(cut)}\n\n`;
  // JSON tolerates the newline between the two halves, so the joined payload parses.
  const f = fakeFetch([() => streamRes([event, sse("[DONE]")])]);
  assert.equal((await runNim(f)).body, "joined");
  for (const eol of ["\r\n", "\r", "\n"]) {
    const wire = [delta({ content: "a" }), delta({ content: "b" }, "stop"), sse("[DONE]")].join("").replace(/\n/g, eol);
    for (const size of [1, 5, wire.length]) {
      const parts = wire.match(new RegExp(`[^]{1,${size}}`, "g"));
      const g = fakeFetch([() => streamRes(parts)]);
      assert.equal((await runNim(g)).body, "ab", `eol=${JSON.stringify(eol)} size=${size}`);
    }
  }
});

test("nim stream: a final event without a terminating blank line is dispatched at EOF", async () => {
  const f = fakeFetch([() => streamRes([`data: ${JSON.stringify({ choices: [{ delta: { content: "eof" }, finish_reason: "stop" }] })}\n`])]);
  assert.equal((await runNim(f)).body, "eof");
});

test("nim stream: EOF with neither [DONE] nor finish_reason keeps the text with a truncation note", async () => {
  const f = fakeFetch([() => streamRes([delta({ content: "half an ans" })])]);
  const r = await runNim(f);
  assert.deepEqual(r, { engine: `nim:${DEFAULT_NIM_MODEL}`, ok: true, body: "half an ans\n\n[truncated: stream ended without [DONE]]" });
  // [DONE] alone (no finish_reason) is a normal end.
  const g = fakeFetch([() => streamRes([delta({ content: "whole" }), sse("[DONE]")])]);
  assert.equal((await runNim(g)).body, "whole");
});

test("nim stream: an error event after partial text keeps the text with a note; key redacted", async () => {
  const f = fakeFetch([() => streamRes([delta({ content: "start" }), sse({ error: { message: `boom ${FAKE_KEY}` } })])]);
  const r = await runNim(f);
  assert.equal(r.ok, true);
  assert.equal(r.degraded, undefined);
  assert.equal(r.body, "start\n\n[truncated: stream error: boom nvapi-***]");
});

test("nim timeout: a perEngine/explicit timeoutSec cannot exceed 600; small explicit values pass through", async () => {
  const timeout = async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
  const base = { prompt: "q", cwd: "/w", timeoutSec: 300, fetchImpl: timeout, env: envWithKey };
  assert.match((await runSpec("nim", base, { nim: { timeoutSec: 999 } })).reason, /^timed out after 600s/);
  assert.match((await runSpec("nim", base, { nim: { timeoutSec: 45 } })).reason, /^timed out after 45s/);
  assert.match((await ENGINES.nim({ ...base, timeoutSec: 99999 })).reason, /^timed out after 600s/);
});

test("nim: JSON fallback maps timeout and undici errors instead of 'bad JSON'", async () => {
  const brokenBody = (err) => () => new Response(new ReadableStream({ pull(c) { c.error(err); } }), { status: 200, headers: { "content-type": "application/json" } });
  const r = await runNim(fakeFetch([brokenBody(timeoutErr())]), { timeoutSec: 8 });
  assert.match(r.reason, /^timed out after 8s/);
  const undici = Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("x"), { code: "UND_ERR_BODY_TIMEOUT" }) });
  assert.match((await runNim(fakeFetch([brokenBody(undici)]))).reason, /^stream stalled, no data for ~300 s/);
  const notJson = fakeFetch([() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })]);
  assert.match((await runNim(notJson)).reason, /^bad JSON/);
});

test("nim: the body of a second 429 is cancelled so the socket is released", async () => {
  let cancelled = 0;
  const mk = () => new Response(new ReadableStream({ pull() {}, cancel() { cancelled++; } }), { status: 429, headers: { "retry-after": "1" } });
  const body429 = new Response("first", { status: 429, headers: { "retry-after": "1" } });
  const f = fakeFetch([() => body429, mk]);
  const r = await runNim(f, { timeoutSec: 30, sleep: sleeper() });
  assert.match(r.reason, /after 1 retry/);
  assert.equal(cancelled, 1);
});

test("nim stream: a cut-off stream with only reasoning keeps the truncation note on the reasoning-only body", async () => {
  const f = fakeFetch([() => streamRes([delta({ reasoning_content: "mulling" })], { err: timeoutErr() })]);
  const r = await runNim(f, { timeoutSec: 9 });
  assert.equal(r.degraded, true);
  assert.equal(r.body, "[reasoning only: model returned no final answer]\n\nmulling\n\n[truncated: timed out after 9s]");
});
