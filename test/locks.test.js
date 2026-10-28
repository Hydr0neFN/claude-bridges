import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseLimit, recordLock, activeLocks, unlock, withLocks, readLocks, lockedReason } from "../lib/locks.js";
import { parseArgs } from "../lib/args.js";
import { summaryLine } from "../lib/panel.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-locks-")), "state", "locks.json");
const NOW = new Date(2026, 9, 28, 12, 0).getTime(); // 2026-10-28 12:00 local

const CODEX = "exit 1: ERROR: You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 16th, 2026 10:54 PM.";

test("parseLimit: Codex reset time is read as local time", () => {
  const p = parseLimit(CODEX, NOW);
  assert.equal(p.until, new Date(2026, 10, 16, 22, 54).getTime());
  assert.match(p.label, /reset time/);
  assert.equal(parseLimit("usage limit, try again at Nov 16th, 2026 12:05 AM", NOW).until, new Date(2026, 10, 16, 0, 5).getTime());
  assert.equal(parseLimit("usage limit, try again at Nov 16th, 2026 12:05 PM", NOW).until, new Date(2026, 10, 16, 12, 5).getTime());
});

test("parseLimit: a reset time already in the past falls back to +24 h", () => {
  const p = parseLimit("usage limit, try again at Oct 1st, 2026 10:54 PM", NOW);
  assert.equal(p.until, NOW + 24 * 3600 * 1000);
});

test("parseLimit: HTTP 429 with Retry-After", () => {
  assert.equal(parseLimit("HTTP 429: Retry-After: 120", NOW).until, NOW + 120000);
  const date = new Date(NOW + 3600000).toUTCString();
  assert.equal(parseLimit(`HTTP 429 retry-after: ${date}`, NOW).until, Date.parse(date));
  assert.equal(parseLimit("HTTP 429: too many requests", NOW), null, "plain 429 is a throttle, never a lock");
  assert.equal(parseLimit("rate-limited (HTTP 429, after 1 retry)", NOW), null);
});

test("parseLimit: monthly credit exhaustion locks to 00:00 UTC on the 1st", () => {
  for (const t of ["You have exceeded your monthly quota for premium requests", "monthly credits exhausted", "Quota exceeded for this month"]) {
    const p = parseLimit(t, NOW);
    assert.equal(p?.until, Date.UTC(2026, 10, 1), t);
    assert.equal(p.label, "monthly credits");
  }
  assert.equal(parseLimit("quota exhausted", Date.UTC(2026, 11, 31, 23)).until, Date.UTC(2026, 11, 31, 23) + 86400000, "no month word = +24 h");
  assert.equal(parseLimit("monthly credits exhausted", Date.UTC(2026, 11, 31, 23)).until, Date.UTC(2027, 0, 1));
});

test("parseLimit: other recognised limit text is +24 h; unknown errors never lock", () => {
  assert.equal(parseLimit("exit 1: Quota exceeded for model", NOW).until, NOW + 86400000);
  assert.equal(parseLimit("exit 1: you are out of credits", NOW).until, NOW + 86400000);
  for (const t of ["exit 1: boom", "timed out after 300s", "not installed (looked in /a)", "empty output", "exit 1: auth failed, please log in", "", undefined]) {
    assert.equal(parseLimit(t, NOW), null, String(t));
  }
});

test("recordLock / activeLocks / unlock: file state, expiry, lockable engines only", () => {
  const file = tmpFile();
  assert.equal(recordLock("codex", "exit 1: boom", { file, now: NOW }), null);
  assert.ok(!fs.existsSync(file));
  assert.equal(recordLock("nim", "usage limit reached", { file, now: NOW }), null, "http engines are not lockable");
  const e = recordLock("codex", CODEX, { file, now: NOW });
  assert.equal(e.until, new Date(2026, 10, 16, 22, 54).toISOString());
  assert.equal(e.at, new Date(NOW).toISOString());
  assert.ok(activeLocks(file, NOW).codex);
  assert.deepEqual(activeLocks(file, Date.parse(e.until) + 1), {}, "expiry is automatic");
  // a shorter new limit never shortens an active lock
  assert.equal(recordLock("codex", "quota exceeded", { file, now: NOW }).until, e.until);
  recordLock("copilot", "monthly quota exceeded", { file, now: NOW });
  assert.deepEqual(unlock("codex", { file }), ["codex"]);
  assert.deepEqual(Object.keys(readLocks(file)), ["copilot"]);
  assert.deepEqual(unlock("nope", { file }), []);
  assert.deepEqual(unlock("all", { file }), ["copilot"]);
  assert.deepEqual(readLocks(file), {});
});

test("readLocks: corrupt or missing file means no locks", () => {
  const file = tmpFile();
  assert.deepEqual(readLocks(file), {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(readLocks(file), {});
});

test("withLocks: limit failure locks, next call is skipped without running, --ignore-locks bypasses", async () => {
  const file = tmpFile();
  let calls = 0;
  const fake = async (spec) => (calls++, { engine: spec, ok: false, reason: CODEX });
  const run = withLocks(fake, { file, now: () => NOW });
  const r1 = await run("codex", {}, {});
  assert.equal(calls, 1);
  assert.match(r1.reason, /now locked until 2026-11-16 22:54/);
  const r2 = await run("codex", {}, {});
  assert.equal(calls, 1, "locked engine not called");
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, "skipped: locked until 2026-11-16 22:54 (usage limit, engine reset time)");
  assert.equal((await run("codex:gpt-x", {}, {})).skipped, true, "engine:model specs honour the lock too");
  const ign = withLocks(fake, { file, now: () => NOW, ignore: true });
  await ign("codex", {}, {});
  assert.equal(calls, 2);
  // unknown error: no lock
  const file2 = tmpFile();
  const boom = withLocks(async (s) => ({ engine: s, ok: false, reason: "exit 1: boom" }), { file: file2, now: () => NOW });
  await boom("copilot", {}, {});
  assert.deepEqual(readLocks(file2), {});
  // lock of another engine is untouched
  assert.equal((await run("copilot", {}, {})).skipped, undefined);
});

test("lockedReason and summaryLine show skipped engines separately", () => {
  const e = { until: new Date(2026, 10, 16, 22, 54).toISOString(), reason: "usage limit, engine reset time" };
  const res = [
    { engine: "deepseek", ok: true, body: "x" },
    { engine: "nim", ok: false, reason: "boom" },
    { engine: "codex", ok: false, skipped: true, reason: lockedReason(e) },
  ];
  assert.equal(summaryLine(res), "[consult] mode: all | answered: deepseek | failed: nim: boom | skipped: codex: locked until 2026-11-16 22:54 (usage limit, engine reset time)");
});

test("parseArgs: --unlock, --ignore-locks, --locks", () => {
  const a = parseArgs(["--unlock", "codex", "--ignore-locks", "--locks"]);
  assert.equal(a.unlock, "codex");
  assert.equal(a.ignoreLocks, true);
  assert.equal(a.locks, true);
  assert.equal(parseArgs([]).unlock, null);
  assert.equal(parseArgs([]).ignoreLocks, false);
});
