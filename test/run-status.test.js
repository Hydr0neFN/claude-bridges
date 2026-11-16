import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStatusDir, createRunStatus, pruneRuns } from "../lib/run-status.js";
import { runPanel } from "../lib/panel.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-run-status-"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("runStatusDir: uses CONSULT_RUNS_DIR when set, else <home>/.claude/state/consult-runs", () => {
  assert.equal(runStatusDir({ CONSULT_RUNS_DIR: "/tmp/custom-runs" }, "/h"), "/tmp/custom-runs");
  assert.equal(runStatusDir({}, "/h"), path.join("/h", ".claude", "state", "consult-runs"));
});

test("state transitions queued -> running -> ok/failed/skipped with valid atomic JSON at every step", () => {
  const dir = tmpDir();
  let nowMs = 1763300000000;
  const st = createRunStatus({
    kind: "all",
    question: "Should we ship?",
    order: ["copilot", "codex", "agy", "nim:x"],
    rounds: 1,
    dir,
    now: () => nowMs,
    pid: 4242,
  });

  const expectedFile = path.join(dir, "1763300000000-4242.json");
  assert.equal(st.file, expectedFile);
  assert.ok(fs.existsSync(expectedFile));
  assert.ok(!fs.existsSync(`${expectedFile}.tmp`));

  let doc = readJson(expectedFile);
  assert.equal(doc.v, 1);
  assert.equal(doc.id, "1763300000000-4242");
  assert.equal(doc.pid, 4242);
  assert.equal(doc.kind, "all");
  assert.equal(doc.startedAt, 1763300000000);
  assert.equal(doc.endedAt, null);
  assert.equal(doc.round, 1);
  assert.equal(doc.rounds, 1);
  assert.equal(doc.summary, null);
  assert.deepEqual(
    doc.engines,
    ["copilot", "codex", "agy", "nim:x"].map((name) => ({
      name,
      model: name === "nim:x" ? "x" : null,
      state: "queued",
      startedAt: null,
      endedAt: null,
      reason: null,
      note: null,
    })),
  );

  // start copilot
  nowMs += 100;
  st.start("copilot");
  doc = readJson(expectedFile);
  assert.equal(doc.engines[0].state, "running");
  assert.equal(doc.engines[0].startedAt, 1763300000100);
  assert.equal(doc.engines[0].endedAt, null);
  assert.equal(doc.engines[1].state, "queued");
  assert.ok(!fs.existsSync(`${expectedFile}.tmp`));

  // settle copilot -> ok (with degraded: true still counts as ok)
  nowMs += 200;
  st.settle("copilot", { engine: "copilot", ok: true, degraded: true, body: "SECRET_BODY_DO_NOT_WRITE" });
  doc = readJson(expectedFile);
  assert.equal(doc.engines[0].state, "ok");
  assert.equal(doc.engines[0].endedAt, 1763300000300);
  assert.equal(doc.engines[0].reason, null);
  assert.equal(doc.engines[0].note, null);
  assert.ok(!fs.readFileSync(expectedFile, "utf8").includes("SECRET_BODY_DO_NOT_WRITE"));

  // start + settle codex -> skipped
  nowMs += 50;
  st.start("codex");
  nowMs += 10;
  st.settle("codex", { engine: "codex", ok: false, skipped: true, reason: "skipped: locked until 2026-11-16 22:54" });
  doc = readJson(expectedFile);
  assert.equal(doc.engines[1].state, "skipped");
  assert.match(doc.engines[1].reason, /^skipped: locked/);

  // start + settle agy -> ok via gemini fallback (engine differs from label)
  nowMs += 50;
  st.start("agy");
  nowMs += 100;
  st.settle("agy", { engine: "agy->gemini:gemini-4-hydrogen", ok: true, body: "ok" });
  doc = readJson(expectedFile);
  assert.equal(doc.engines[2].state, "ok");
  assert.equal(doc.engines[2].note, "agy->gemini:gemini-4-hydrogen");

  // start + settle nim:x -> failed, reason clipped at 100 chars
  nowMs += 50;
  st.start("nim:x");
  nowMs += 100;
  st.settle("nim:x", { engine: "nim:x", ok: false, reason: "R".repeat(150) });
  doc = readJson(expectedFile);
  assert.equal(doc.engines[3].state, "failed");
  assert.equal(doc.engines[3].reason.length, 100);

  // end -> sets endedAt and clips summary at 300 chars
  nowMs += 50;
  st.end("S".repeat(350));
  doc = readJson(expectedFile);
  assert.equal(doc.endedAt, nowMs);
  assert.equal(doc.summary.length, 300);
  assert.ok(!fs.existsSync(`${expectedFile}.tmp`));
});

test("question truncation: first non-empty trimmed line, max 140 chars, no prompt body beyond 140 chars", () => {
  const dir = tmpDir();
  const longLine = `  ${"Q".repeat(200)}  `;
  const prompt = `\n   \n${longLine}\nSECRET_SECOND_LINE_BODY\n`;
  const st = createRunStatus({
    kind: "first",
    question: prompt,
    order: ["copilot", "codex"],
    rounds: 1,
    dir,
    now: () => 1763300001000,
    pid: 123,
  });

  const raw = fs.readFileSync(st.file, "utf8");
  const doc = JSON.parse(raw);
  assert.equal(doc.question, "Q".repeat(140));
  assert.equal(doc.question.length, 140);
  assert.ok(!raw.includes("SECRET_SECOND_LINE_BODY"));
  assert.ok(!raw.includes("Q".repeat(141)));
});

test("round2 defaults round to 2 and rounds to 2", () => {
  const dir = tmpDir();
  const st = createRunStatus({
    kind: "round2",
    question: "Re-evaluate",
    order: ["copilot", "codex"],
    rounds: 2,
    dir,
    now: () => 1763300002000,
    pid: 99,
  });
  const doc = readJson(st.file);
  assert.equal(doc.kind, "round2");
  assert.equal(doc.round, 2);
  assert.equal(doc.rounds, 2);
});

test("newRound resets only the named engines and preserves others' state", () => {
  const dir = tmpDir();
  let t = 1763300003000;
  const st = createRunStatus({
    kind: "debate",
    question: "A or B?",
    order: ["copilot", "codex", "nim:m"],
    rounds: 3,
    dir,
    now: () => t,
    pid: 55,
  });

  t += 10;
  st.start("copilot");
  st.start("codex");
  st.start("nim:m");
  t += 20;
  st.settle("copilot", { ok: true, body: "A" });
  st.settle("codex", { ok: false, reason: "timeout" });
  st.settle("nim:m", { ok: true, body: "B", note: "chain note" });

  // Round 2 only runs copilot and nim:m; codex failed R1 and must keep its failed state.
  t += 10;
  st.newRound(2, ["copilot", "nim:m"]);
  const doc = readJson(st.file);
  assert.equal(doc.round, 2);
  assert.deepEqual(doc.engines[0], {
    name: "copilot",
    model: null,
    state: "queued",
    startedAt: null,
    endedAt: null,
    reason: null,
    note: null,
  });
  assert.deepEqual(doc.engines[1], {
    name: "codex",
    model: null,
    state: "failed",
    startedAt: 1763300003010,
    endedAt: 1763300003030,
    reason: "timeout",
    note: null,
  });
  assert.deepEqual(doc.engines[2], {
    name: "nim:m",
    model: "m",
    state: "queued",
    startedAt: null,
    endedAt: null,
    reason: null,
    note: null,
  });
});

test("pruneRuns removes old run files only and ignores missing/bad dirs", () => {
  const dir = tmpDir();
  const nowMs = 1763400000000;
  const dayMs = 24 * 3600 * 1000;

  const oldFile = path.join(dir, "1000-1.json");
  const freshFile = path.join(dir, "2000-2.json");
  const otherFile = path.join(dir, "notes.txt");
  fs.writeFileSync(oldFile, "{}\n");
  fs.writeFileSync(freshFile, "{}\n");
  fs.writeFileSync(otherFile, "keep\n");

  const oldSec = (nowMs - dayMs - 1000) / 1000;
  const freshSec = (nowMs - 1000) / 1000;
  fs.utimesSync(oldFile, oldSec, oldSec);
  fs.utimesSync(otherFile, oldSec, oldSec);
  fs.utimesSync(freshFile, freshSec, freshSec);

  pruneRuns(dir, nowMs, dayMs);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  assert.equal(fs.existsSync(otherFile), true);

  // Missing directory or file path does not throw
  assert.doesNotThrow(() => pruneRuns(path.join(dir, "missing"), nowMs));
  assert.doesNotThrow(() => pruneRuns(otherFile, nowMs));
});

test("write error (dir is a regular file) does not throw on create or any update", () => {
  const root = tmpDir();
  const notADir = path.join(root, "file-not-dir");
  fs.writeFileSync(notADir, "occupied");

  let st;
  assert.doesNotThrow(() => {
    st = createRunStatus({
      kind: "all",
      question: "q",
      order: ["copilot"],
      rounds: 1,
      dir: notADir,
      now: () => 1763300004000,
      pid: 77,
    });
    st.start("copilot");
    st.settle("copilot", { ok: true, body: "ok" });
    st.newRound(2, ["copilot"]);
    st.end("done");
  });
});

test("serial mode via runPanel keeps queued CLI engines in 'queued' state until their turn starts", async () => {
  const dir = tmpDir();
  const st = createRunStatus({
    kind: "all",
    question: "serial check",
    order: ["copilot", "codex"],
    rounds: 1,
    dir,
    now: () => 1763300005000,
    pid: 88,
  });

  const snapshots = [];
  await runPanel({
    order: ["copilot", "codex"],
    serial: () => true,
    run: async (name) => {
      st.start(name);
      snapshots.push({ who: name, engines: readJson(st.file).engines.map((e) => [e.name, e.state]) });
      await new Promise((r) => setTimeout(r, 15));
      const res = { engine: name, ok: true, body: "ok" };
      st.settle(name, res);
      return res;
    },
  });

  assert.deepEqual(snapshots[0], {
    who: "copilot",
    engines: [["copilot", "running"], ["codex", "queued"]],
  });
  assert.deepEqual(snapshots[1], {
    who: "codex",
    engines: [["copilot", "ok"], ["codex", "running"]],
  });
});

test("engines[].model: from an engine:model label at start, then from the engine that answered", () => {
  const dir = tmpDir();
  const st = createRunStatus({ kind: "all", question: "q", order: ["agy:gemini-4-argon-high", "azure", "codex"], dir, now: () => 1, pid: 7 });
  let doc = readJson(st.file);
  assert.deepEqual(doc.engines.map((e) => e.model), ["gemini-4-argon-high", null, null]);
  st.settle("azure", { ok: true, engine: "azure:gpt-6.1-sol", body: "B" });
  st.settle("codex", { skipped: true, reason: "locked" });
  doc = readJson(st.file);
  assert.equal(doc.engines[1].model, "gpt-6.1-sol");
  assert.equal(doc.engines[2].model, null);
});
