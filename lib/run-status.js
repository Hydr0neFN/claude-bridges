// Live run status file for consult-cli (contract v1): atomic JSON under
// $CONSULT_RUNS_DIR or ~/.claude/state/consult-runs/<startedAt>-<pid>.json.
// Every write and prune is wrapped in try/catch so status tracking never fails a consult run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DAY_MS = 24 * 3600 * 1000;
const QUESTION_MAX = 140;
const REASON_MAX = 100;
const NOTE_MAX = 100;
const SUMMARY_MAX = 300;

export const runStatusDir = (env = process.env, home = os.homedir()) =>
  env?.CONSULT_RUNS_DIR || path.join(home, ".claude", "state", "consult-runs");

const clip = (s, max) => {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
};

function formatQuestion(prompt) {
  const line = String(prompt ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || "";
  return line.slice(0, QUESTION_MAX);
}

/** Model part of an `engine:model` label (split at the first `:`), else null. */
export const modelOf = (label) => {
  const s = String(label ?? "");
  const i = s.indexOf(":");
  return i < 0 ? null : clip(s.slice(i + 1), NOTE_MAX);
};

const makeEngine = (name, state = "queued", startedAt = null) => ({
  name: String(name),
  model: modelOf(name),
  state,
  startedAt,
  endedAt: null,
  reason: null,
  note: null,
});

/** Delete run status files in `dir` whose mtime is older than `maxAgeMs`. Never throws. */
export function pruneRuns(dir = runStatusDir(), now = Date.now(), maxAgeMs = DAY_MS) {
  try {
    const nowMs = typeof now === "function" ? now() : now;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".json") && !ent.name.endsWith(".json.tmp")) continue;
      try {
        const filePath = path.join(dir, ent.name);
        const st = fs.statSync(filePath);
        if (nowMs - st.mtimeMs > maxAgeMs) fs.unlinkSync(filePath);
      } catch {
        // ignore per-file stat/unlink errors
      }
    }
  } catch {
    // ignore missing or unreadable status dir
  }
}

/**
 * Create a live run status tracker and immediately write the initial `<startedAt>-<pid>.json` file.
 * Methods `start`, `settle`, `newRound`, `end` update the record and rewrite it atomically.
 */
export function createRunStatus({
  kind,
  question,
  order = [],
  rounds,
  round,
  dir = runStatusDir(),
  now = Date.now,
  pid = process.pid,
} = {}) {
  const nowFn = typeof now === "function" ? now : () => now;
  const startedAt = nowFn();
  const id = `${startedAt}-${pid}`;
  const file = path.join(dir, `${id}.json`);
  const record = {
    v: 1,
    id,
    pid,
    kind,
    startedAt,
    endedAt: null,
    question: formatQuestion(question),
    round: round ?? (kind === "round2" ? 2 : 1),
    rounds: rounds ?? (kind === "round2" ? 2 : 1),
    engines: (order || []).map((name) => makeEngine(name)),
    summary: null,
  };

  const write = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
      fs.renameSync(tmp, file);
    } catch {
      // status file must never fail a consult run
    }
  };

  write();

  return {
    id,
    file,
    start(name) {
      const t = nowFn();
      const label = String(name);
      const entry = record.engines.find((e) => e.name === label);
      if (entry) {
        entry.state = "running";
        entry.startedAt = t;
        entry.endedAt = null;
        entry.reason = null;
        entry.note = null;
      } else {
        record.engines.push(makeEngine(label, "running", t));
      }
      write();
    },
    settle(name, result) {
      const t = nowFn();
      const label = String(name);
      let entry = record.engines.find((e) => e.name === label);
      if (!entry) {
        entry = makeEngine(label);
        record.engines.push(entry);
      }
      entry.endedAt = t;
      if (result?.skipped) {
        entry.state = "skipped";
        entry.reason = clip(result.reason, REASON_MAX);
        entry.note = null;
      } else if (result?.ok) {
        entry.state = "ok";
        entry.reason = null;
        const noteText = result.note || (result.engine && result.engine !== label ? result.engine : null);
        entry.note = clip(noteText, NOTE_MAX);
        const ran = modelOf(result.engine) || clip(result.model, NOTE_MAX);
        if (ran) entry.model = ran;
      } else {
        entry.state = "failed";
        entry.reason = clip(result?.reason, REASON_MAX);
        entry.note = null;
      }
      write();
    },
    newRound(nextRound, names = []) {
      record.round = nextRound;
      const active = new Set((names || []).map(String));
      for (const entry of record.engines) {
        if (!active.has(entry.name)) continue;
        entry.state = "queued";
        entry.startedAt = null;
        entry.endedAt = null;
        entry.reason = null;
        entry.note = null;
        active.delete(entry.name);
      }
      for (const name of active) record.engines.push(makeEngine(name));
      write();
    },
    end(summary) {
      record.endedAt = nowFn();
      record.summary = clip(summary, SUMMARY_MAX);
      write();
    },
  };
}
