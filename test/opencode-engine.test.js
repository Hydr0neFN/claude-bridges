import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrder, parseArgs } from "../lib/args.js";
import { resolveOpenCode, NotInstalledError } from "../lib/common.js";
import { recordLock, LOCKABLE } from "../lib/locks.js";
import {
  ENGINES, MODEL_ENGINES, OPENCODE_CHAIN, DEFAULT_OPENCODE_MODEL, opencodeChain, opencodeModels, opencodeTimeoutSec,
  parseOpenCodeJson, runSpec,
} from "../lib/engines.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [M1, M2, M3, M4, M5] = OPENCODE_CHAIN;
const textLine = (t) => JSON.stringify({ type: "text", part: { text: t } });
const finish = JSON.stringify({ type: "step_finish", part: { reason: "stop", cost: 0 } });
const okOut = (t) => `${JSON.stringify({ type: "step_start" })}\n${textLine(t)}\n${finish}\n`;

/** Fake opencode: a node script; scenario[model] = { stdout, stderr, code, hang }. Logs every call to log.json. */
function fake(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-oc-"));
  const log = path.join(dir, "log.json");
  const script = path.join(dir, "opencode.js");
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario));
  fs.writeFileSync(script, `
const fs = require("fs");
const args = process.argv.slice(2);
const model = args[args.indexOf("-m") + 1].replace(/^opencode\\//, "");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const sc = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "scenario.json"))}, "utf8"));
  const calls = fs.existsSync(${JSON.stringify(log)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(log)}, "utf8")) : [];
  calls.push({ args, model, stdin, cwd: process.cwd() });
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(calls));
  const s = sc[model] || {};
  if (s.hang) return setTimeout(() => {}, 60000);
  process.stdout.write(s.stdout || "");
  process.stderr.write(s.stderr || "");
  process.exit(s.code ?? 0);
});
`);
  return { env: { OPENCODE_PATH: script }, calls: () => (fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : []) };
}

test("opencode is registered: model engine, lockable, last of the old default and then azure, gemini", () => {
  assert.ok(MODEL_ENGINES.includes("opencode"));
  assert.ok(LOCKABLE.includes("opencode"));
  assert.deepEqual(parseOrder(undefined).slice(-4), ["openrouter", "opencode", "azure", "gemini"]);
  assert.equal(parseArgs(["--opencode-model", "big-pickle", "x"]).opencodeModel, "big-pickle");
  assert.deepEqual(parseOrder(`opencode:${DEFAULT_OPENCODE_MODEL},opencode`), ["opencode"]);
});

test("chain: five free models, no deepseek or nemotron, env override and model-first ordering", () => {
  assert.equal(OPENCODE_CHAIN.length, 5);
  assert.deepEqual(OPENCODE_CHAIN, ["beam-free", "glm-5.3-flash-free", "mimo-v2.6-flash-free", "big-pickle", "flint-40b-free"]);
  assert.ok(!OPENCODE_CHAIN.some((m) => /deepseek|nemotron/.test(m)));
  assert.deepEqual(opencodeChain({ OPENCODE_CHAIN: " a , b ,," }), ["a", "b"]);
  assert.deepEqual(opencodeChain({}), OPENCODE_CHAIN);
  assert.deepEqual(opencodeModels(M3, {}), [M3, M1, M2, M4, M5]);
  assert.equal(opencodeTimeoutSec({}), 300);
  assert.equal(opencodeTimeoutSec({ OPENCODE_TIMEOUT: "9999" }), 600);
});

test("parseOpenCodeJson: joins text parts; plain output loses ANSI and the header line", () => {
  assert.equal(parseOpenCodeJson(`${textLine("ok")}\n${textLine(" more")}\n${finish}\n`).text, "ok more");
  assert.equal(parseOpenCodeJson("> build · beam-free\n\x1b[0mok\n").text, "ok");
  assert.equal(parseOpenCodeJson("> plan · some-model\n\x1b[0m\n").text, "");
  assert.deepEqual(parseOpenCodeJson(`${JSON.stringify({ type: "error", error: { name: "X" } })}\n`).errors.length, 1);
});

test("opencode: answer comes from the json text parts; stdin prompt, plan agent, no --auto, label names the model", async () => {
  const f = fake({ [M1]: { stdout: okOut("ok") } });
  const r = await ENGINES.opencode({ prompt: "Reply with exactly: ok", env: f.env });
  assert.deepEqual(r, { engine: `opencode:${M1}`, ok: true, body: "ok" });
  const [c] = f.calls();
  assert.equal(c.stdin, "Reply with exactly: ok");
  assert.deepEqual(c.args, ["run", "-m", `opencode/${M1}`, "--agent", "plan", "--format", "json"]);
  assert.ok(!c.args.includes("--auto"));
});

test("opencode: runs in an empty temp dir, never the repo or the given cwd, and removes it", async () => {
  const f = fake({ [M1]: { stdout: okOut("ok") } });
  await ENGINES.opencode({ prompt: "hi", cwd: REPO, env: f.env });
  const [c] = f.calls();
  const real = (p) => fs.realpathSync(p);
  assert.notEqual(real(path.dirname(c.cwd)), real(REPO));
  assert.equal(real(path.dirname(c.cwd)), real(os.tmpdir()));
  assert.match(path.basename(c.cwd), /^consult-opencode-/);
  assert.equal(fs.existsSync(c.cwd), false);
});

test("opencode chain: steps on empty, quota, 5xx and nonzero exit; the label is the model that answered", async () => {
  const f = fake({
    [M1]: { stdout: `${finish}\n` }, // empty answer
    [M2]: { stdout: JSON.stringify({ type: "error", error: { name: "FreeUsageLimitError" } }) + "\n", code: 1 },
    [M3]: { stderr: "HTTP 503 service unavailable", code: 1 },
    [M4]: { stderr: "boom", code: 2 },
    [M5]: { stdout: okOut("fifth") },
  });
  const r = await ENGINES.opencode({ prompt: "hi", env: f.env });
  assert.deepEqual(r, { engine: `opencode:${M5}`, ok: true, body: "fifth" });
  assert.deepEqual(f.calls().map((c) => c.model), [M1, M2, M3, M4, M5]);
});

test("opencode chain: an auth error stops the chain", async () => {
  const f = fake({ [M1]: { stderr: "401 Unauthorized: invalid API key", code: 1 }, [M2]: { stdout: okOut("never") } });
  const r = await ENGINES.opencode({ prompt: "hi", env: f.env });
  assert.equal(r.ok, false);
  assert.match(r.reason, /auth error/);
  assert.deepEqual(f.calls().map((c) => c.model), [M1]);
});

test("opencode: Free usage limit text is a quota failure that locks the engine", async () => {
  const dflt = { stderr: "Free usage limit reached for this model", code: 1 };
  const f = fake(Object.fromEntries(OPENCODE_CHAIN.map((m) => [m, dflt])));
  const r = await ENGINES.opencode({ prompt: "hi", env: f.env });
  assert.equal(r.ok, false);
  assert.match(r.reason, /usage limit/i);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oc-locks-")), "locks.json");
  assert.ok(recordLock("opencode", r.reason, { file }), "parseLimit recognises the reason");
});

test("opencode: OPENCODE_CHAIN override and --opencode-model start the chain where told", async () => {
  const f = fake({ x: { stdout: okOut("from x") } });
  const r = await ENGINES.opencode({ prompt: "hi", env: { ...f.env, OPENCODE_CHAIN: "x,y" } });
  assert.equal(r.engine, "opencode:x");
  const g = fake({ [M3]: { stderr: "oops", code: 1 }, [M1]: { stdout: okOut("one") } });
  const r2 = await runSpec("opencode", { prompt: "hi", env: g.env }, { opencode: { model: M3 } });
  assert.equal(r2.engine, `opencode:${M1}`);
  assert.deepEqual(g.calls().map((c) => c.model), [M3, M1]);
});

test("opencode: an explicit opencode:<other model> runs only that model", async () => {
  const f = fake({ [M4]: { stderr: "oops", code: 1 } });
  const r = await runSpec(`opencode:${M4}`, { prompt: "hi", env: f.env });
  assert.equal(r.ok, false);
  assert.deepEqual(f.calls().map((c) => c.model), [M4]);
});

test("opencode: a hanging model times out and the chain steps on", async () => {
  const f = fake({ [M1]: { hang: true }, [M2]: { stdout: okOut("late") } });
  const r = await ENGINES.opencode({ prompt: "hi", timeoutSec: 1, env: f.env, model: M1, explicit: false });
  // 1 s total budget: the first step times out, the second is skipped (budget gone) -> failure naming the timeout
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/);
});

test("opencode: not installed -> NotInstalled failure, no crash", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-empty-"));
  assert.throws(() => resolveOpenCode({ env: { PATH: empty }, platform: "linux" }), NotInstalledError);
  const r = await ENGINES.opencode({ prompt: "hi", env: { PATH: empty, OPENCODE_PATH: "" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not installed/);
});

test("resolveOpenCode: a Windows .cmd shim resolves to the program it launches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shim-"));
  const exe = path.join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "");
  fs.writeFileSync(path.join(dir, "opencode.cmd"), '@ECHO off\r\nSETLOCAL\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n');
  const r = resolveOpenCode({ env: { PATH: dir }, platform: "win32" });
  assert.deepEqual(r, { cmd: exe, pre: [] });
  fs.writeFileSync(path.join(dir, "opencode.cmd"), "@ECHO off\r\nrem nothing\r\n");
  assert.throws(() => resolveOpenCode({ env: { PATH: dir }, platform: "win32" }), NotInstalledError);
});
