import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ENGINES, DEFAULT_AGY_MODEL, DEFAULT_AGY_FALLBACK_MODEL, agyModel, agyFallbackModel, runSpec,
} from "../lib/engines.js";
import { withLocks, readLocks, activeLocks, localTime, unlock } from "../lib/locks.js";
import { summaryLine } from "../lib/panel.js";
import { engineEntry } from "../lib/cli-json.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "consult-cli.js");
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-agy-locks-")), "state", "locks.json");
const NOW = new Date(2026, 10, 16, 12, 0).getTime(); // 2026-11-16 12:00 local

const PRIMARY = DEFAULT_AGY_MODEL;
const FALLBACK = DEFAULT_AGY_FALLBACK_MODEL;

/** Fake agy CLI (.js run via process.execPath): scenario[model] = { stdout, stderr, code, delayMs, hang }. */
function fakeAgy(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-"));
  const log = path.join(dir, "log.json");
  const script = path.join(dir, "agy.js");
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario));
  fs.writeFileSync(script, `
const fs = require("fs");
const args = process.argv.slice(2);
const mi = args.indexOf("--model");
const model = mi >= 0 ? args[mi + 1] : "";
const ti = args.indexOf("--print-timeout");
const timeoutArg = ti >= 0 ? args[ti + 1] : "";
const sc = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "scenario.json"))}, "utf8"));
const calls = fs.existsSync(${JSON.stringify(log)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(log)}, "utf8")) : [];
calls.push({ args, model, timeoutArg });
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(calls));
const s = sc[model] || {};
if (s.hang) return setTimeout(() => {}, 60000);
const done = () => {
  if (s.stdout) process.stdout.write(s.stdout);
  if (s.stderr) process.stderr.write(s.stderr);
  process.exit(s.code ?? 0);
};
if (s.delayMs) setTimeout(done, s.delayMs);
else done();
`);
  return {
    env: { AGY_PATH: script },
    calls: () => (fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : []),
  };
}

test("agyModel / agyFallbackModel defaults and overrides", () => {
  assert.equal(DEFAULT_AGY_MODEL, "gemini-4-neon-high");
  assert.equal(DEFAULT_AGY_FALLBACK_MODEL, "gemini-4-argon-high");
  assert.equal(agyModel({}), DEFAULT_AGY_MODEL);
  assert.equal(agyModel({ AGY_CONSULT_MODEL: "" }), "");
  assert.equal(agyFallbackModel({}), DEFAULT_AGY_FALLBACK_MODEL);
  assert.equal(agyFallbackModel({ AGY_FALLBACK_MODEL: "" }), "");
  assert.equal(agyFallbackModel({ AGY_FALLBACK_MODEL: "  " }), "");
  assert.equal(agyFallbackModel({ AGY_FALLBACK_MODEL: "custom-fb" }), "custom-fb");
});

test("agy: primary succeeds -> labelled agy:<primary>, no note, no locks", async () => {
  const file = tmpFile();
  const f = fakeAgy({ [PRIMARY]: { stdout: "argon ok\n" } });
  const run = withLocks(runSpec, { file, now: () => NOW });
  const r = await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 60, env: f.env }, {});
  assert.deepEqual(r, { engine: `agy:${PRIMARY}`, ok: true, body: "argon ok" });
  assert.deepEqual(f.calls().map((c) => c.model), [PRIMARY]);
  assert.deepEqual(readLocks(file), {});
});

test("agy: quota on Neon -> Argon answers, Neon model lock written, no engine lock, failover note present", async () => {
  const file = tmpFile();
  const argonReset = "exit 1: usage limit reached, try again at Nov 23rd, 2026 12:00 PM";
  const expectedUntil = new Date(2026, 10, 23, 12, 0).toISOString();
  const f = fakeAgy({
    [PRIMARY]: { stderr: argonReset, code: 1 },
    [FALLBACK]: { stdout: "hydrogen ok\n" },
  });
  const run = withLocks(runSpec, { file, now: () => NOW });
  const r = await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 60, env: f.env }, {});

  assert.equal(r.ok, true);
  assert.equal(r.engine, `agy:${FALLBACK}`);
  assert.equal(r.body, "hydrogen ok");
  assert.equal(r.note, `fallback: neon quota-locked until ${localTime(expectedUntil)}`);
  assert.deepEqual(f.calls().map((c) => c.model), [PRIMARY, FALLBACK]);

  const locks = readLocks(file);
  assert.deepEqual(Object.keys(locks), [`agy:${PRIMARY}`]);
  assert.equal(locks[`agy:${PRIMARY}`].until, expectedUntil);

  assert.match(summaryLine([r]), new RegExp(`answered: agy:${FALLBACK} \\| note: agy:${FALLBACK}: fallback: neon quota-locked until `));
  assert.equal(engineEntry(r).note, r.note);
});

test("agy: Neon lock live -> Neon skipped and Argon runs directly", async () => {
  const file = tmpFile();
  const f1 = fakeAgy({
    [PRIMARY]: { stderr: "exit 1: Quota exceeded for model", code: 1 },
    [FALLBACK]: { stdout: "first hydrogen\n" },
  });
  const run = withLocks(runSpec, { file, now: () => NOW });
  await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 60, env: f1.env }, {});

  const f2 = fakeAgy({
    [PRIMARY]: { stdout: "should not run\n" },
    [FALLBACK]: { stdout: "second hydrogen\n" },
  });
  const r2 = await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 60, env: f2.env }, {});
  assert.equal(r2.ok, true);
  assert.equal(r2.engine, `agy:${FALLBACK}`);
  assert.equal(r2.body, "second hydrogen");
  assert.match(r2.note, /^fallback: neon quota-locked until /);
  assert.deepEqual(f2.calls().map((c) => c.model), [FALLBACK]);
});

test("agy: both quota -> Argon model lock and engine-level agy lock written; next call skips agy", async () => {
  const file = tmpFile();
  const argonErr = "exit 1: usage limit reached, try again at Nov 23rd, 2026 12:00 PM";
  const hydroErr = "exit 1: usage limit reached, try again at Nov 16th, 2026 5:00 PM";
  const hydroUntil = new Date(2026, 10, 16, 17, 0).toISOString();
  const f = fakeAgy({
    [PRIMARY]: { stderr: argonErr, code: 1 },
    [FALLBACK]: { stderr: hydroErr, code: 1 },
  });
  const run = withLocks(runSpec, { file, now: () => NOW });
  const r1 = await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 60, env: f.env }, {});

  assert.equal(r1.ok, false);
  assert.match(r1.reason, /now locked until 2026-11-16 17:00/);
  const locks = readLocks(file);
  assert.deepEqual(Object.keys(locks).sort(), ["agy", `agy:${PRIMARY}`, `agy:${FALLBACK}`].sort());
  assert.equal(locks[`agy:${FALLBACK}`].until, hydroUntil);
  assert.equal(locks.agy.until, hydroUntil);

  // Next call while engine lock is live skips agy entirely.
  const f2 = fakeAgy({ [FALLBACK]: { stdout: "never\n" } });
  const r2 = await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 60, env: f2.env }, {});
  assert.equal(r2.skipped, true);
  assert.equal(f2.calls().length, 0);
});

test("agy: non-quota failure (crash, auth, timeout) -> no fallback, no locks", async () => {
  for (const sc of [
    { [PRIMARY]: { stderr: "boom", code: 1 }, [FALLBACK]: { stdout: "never" } },
    { [PRIMARY]: { stderr: "401 unauthorized, please log in", code: 1 }, [FALLBACK]: { stdout: "never" } },
    { [PRIMARY]: { hang: true }, [FALLBACK]: { stdout: "never" } },
  ]) {
    const file = tmpFile();
    const f = fakeAgy(sc);
    const run = withLocks(runSpec, { file, now: () => NOW });
    const r = await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 1, env: f.env }, {});
    assert.equal(r.ok, false);
    assert.deepEqual(f.calls().map((c) => c.model), [PRIMARY]);
    assert.deepEqual(readLocks(file), {});
  }
});

test("agy: Argon quota then Hydrogen non-quota failure -> Argon locked, no Hydrogen or engine lock", async () => {
  const file = tmpFile();
  const f = fakeAgy({
    [PRIMARY]: { stderr: "exit 1: Quota exceeded for model", code: 1 },
    [FALLBACK]: { stderr: "exit 1: boom", code: 1 },
  });
  const run = withLocks(runSpec, { file, now: () => NOW });
  const r = await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 60, env: f.env }, {});
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(readLocks(file)), [`agy:${PRIMARY}`]);
});

test("agy: fallback runs with remaining time budget", async () => {
  const file = tmpFile();
  const f = fakeAgy({
    [PRIMARY]: { stderr: "exit 1: Quota exceeded for model", code: 1, delayMs: 1100 },
    [FALLBACK]: { stdout: "ok\n" },
  });
  const r = await ENGINES.agy({ prompt: "hi", cwd: os.tmpdir(), timeoutSec: 5, env: f.env, locksFile: file, now: NOW });
  assert.equal(r.ok, true);
  const calls = f.calls();
  assert.equal(calls[0].timeoutArg, "5s");
  assert.ok(Number(calls[1].timeoutArg.replace(/s$/, "")) <= 4, `expected <= 4s remaining, got ${calls[1].timeoutArg}`);
});

test("agy: AGY_FALLBACK_MODEL '' -> no fallback; quota writes engine lock as today", async () => {
  const file = tmpFile();
  const f = fakeAgy({
    [PRIMARY]: { stderr: "exit 1: Quota exceeded for model", code: 1 },
    [FALLBACK]: { stdout: "should not run\n" },
  });
  const env = { ...f.env, AGY_FALLBACK_MODEL: "" };
  const run = withLocks(runSpec, { file, now: () => NOW });
  const r = await run("agy", { prompt: "hi", cwd: os.tmpdir(), timeoutSec: 60, env }, {});
  assert.equal(r.ok, false);
  assert.deepEqual(f.calls().map((c) => c.model), [PRIMARY]);
  assert.deepEqual(Object.keys(readLocks(file)), ["agy"]);
});

test("consult-cli --locks lists model locks and --unlock agy clears engine + agy model locks", () => {
  const file = tmpFile();
  const future = Date.now() + 3600 * 1000;
  const f = fakeAgy({});
  void f;
  // Seed engine lock + model locks + an unrelated codex lock.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    agy: { until: new Date(future).toISOString(), reason: "limit text, +24 h", at: new Date().toISOString() },
    [`agy:${PRIMARY}`]: { until: new Date(future).toISOString(), reason: "usage limit, engine reset time", at: new Date().toISOString() },
    [`agy:${FALLBACK}`]: { until: new Date(future).toISOString(), reason: "limit text, +24 h", at: new Date().toISOString() },
    codex: { until: new Date(future).toISOString(), reason: "limit text, +24 h", at: new Date().toISOString() },
  }));

  const env = { ...process.env, CONSULT_LOCKS_FILE: file };
  const listed = spawnSync(process.execPath, [CLI, "--locks"], { encoding: "utf8", env, timeout: 10000 });
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, new RegExp(`agy:${PRIMARY}: locked until`));
  assert.match(listed.stdout, new RegExp(`agy:${FALLBACK}: locked until`));

  const unlocked = spawnSync(process.execPath, [CLI, "--unlock", "agy"], { encoding: "utf8", env, timeout: 10000 });
  assert.equal(unlocked.status, 0);
  assert.match(unlocked.stdout, /unlocked:.*agy:gemini-4-neon-high/);
  assert.deepEqual(Object.keys(readLocks(file)), ["codex"]);
  assert.deepEqual(Object.keys(activeLocks(file)), ["codex"]);
  assert.deepEqual(unlock("codex", { file }), ["codex"]);
});
