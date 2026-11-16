// Panel runner shared by consult-cli and consult-bridge: every engine runs
// concurrently with its own timeout (enforced inside the engine), and each
// result is handed to onSettle the moment that engine finishes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLI_ENGINES = new Set(["copilot", "codex", "agy", "opencode"]);

const SERIAL_MEM_THRESHOLD_BYTES = 12 * 1024 ** 3; // 12 GiB

/** Whether CLI engines should run one at a time (`CONSULT_CLI_SERIAL=1|0`, or auto when total RAM <= 12 GiB). */
export function cliSerialEnabled(env = process.env, totalmem = os.totalmem()) {
  const raw = env?.CONSULT_CLI_SERIAL;
  if (raw === "1") return true;
  if (raw === "0") return false;
  return totalmem <= SERIAL_MEM_THRESHOLD_BYTES;
}

/** Run `order` engines concurrently (or serialize `serial(spec)` specs in a one-slot queue); `onSettle(name, result)` fires per engine as it finishes. */
export async function runPanel({ order, run, onSettle, serial }) {
  const execOne = async (name) => {
    let r;
    try {
      r = await run(name);
    } catch (e) {
      r = { engine: name, ok: false, reason: `crashed: ${e.message}` };
    }
    try {
      await onSettle?.(name, r);
    } catch {
      /* a failing sink must not lose the other engines */
    }
    return r;
  };

  let tail = null;
  const enqueue = (fn) => {
    const next = tail ? tail.then(fn, fn) : fn();
    tail = next.catch(() => {});
    return next;
  };

  return Promise.all(
    order.map((name) => (serial?.(name) ? enqueue(() => execOne(name)) : execOne(name))),
  );
}

/** Mode first: a reasoning-only reply (`degraded`) is shown in panels but is not a final answer. */
export const isFinal = (r) => r.ok && !r.degraded;

/**
 * Sequential fallback chain. -> { result, trail: ["engine: why", ...] }.
 * `result` is the first final answer; failing that, the first reasoning-only reply (check
 * `result.degraded`) as a last resort; null only when every engine failed outright.
 */
export async function runChain(order, run) {
  const trail = [];
  let lastResort = null;
  for (const name of order) {
    const r = await run(name);
    if (isFinal(r)) return { result: r, trail };
    if (r.ok) lastResort ??= r;
    trail.push(`${r.engine}: ${r.ok ? "reasoning only, no final answer" : r.reason}`);
  }
  return { result: lastResort, trail };
}

/** Meta note for a mode-first result that is only reasoning, else null. */
export const lastResortNote = (r) =>
  r.degraded ? `no final answer from any engine; showing ${r.engine}'s reasoning` : null;

// Failure reasons that more auth/login work could fix (not 429, timeouts, empty or reasoning-only replies).
const AUTH_LIKE = /auth|log ?in|credential|not installed|launch failed|HTTP 40[13]\b|no [A-Z_]*API_KEY/i;

/** Auth hint for the all-engines-failed text, or "" when no failure looks auth/launch related. */
export function authHint(failures) {
  return failures.some((f) => AUTH_LIKE.test(f)) ? "\n\nCheck auth (copilot login / codex login), then retry." : "";
}

/** One whole stdout section for a settled engine. */
export function formatSection(r) {
  return `## ${r.engine}\n\n${r.ok ? r.body : `[failed] ${r.reason}`}\n`;
}

/** Final summary line for mode all; null when nothing answered (caller reports failure instead). */
export function summaryLine(results) {
  const good = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok && !r.skipped).map((r) => `${r.engine}: ${r.reason}`);
  const skipped = results.filter((r) => r.skipped).map((r) => `${r.engine}: ${r.reason.replace(/^skipped: /, "")}`);
  const notes = good.filter((r) => r.note).map((r) => `${r.engine}: ${r.note}`);
  if (!good.length) return null;
  return `[consult] mode: all | answered: ${good.map((r) => r.engine).join(", ")}${failed.length ? ` | failed: ${failed.join("; ")}` : ""}${skipped.length ? ` | skipped: ${skipped.join("; ")}` : ""}${notes.length ? ` | note: ${notes.join("; ")}` : ""}`;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Spec names like `nim:z-ai/glm-5.3` must not become subdirs or hit reserved Windows chars/device names. */
export function safeFileName(name) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";
  return WIN_RESERVED.test(safe) ? `_${safe}` : safe;
}

/** Write <dir>/<safe name>.md atomically (tmp + rename) so a reader never sees a partial file. */
export function writeEngineResult(dir, name, r) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(name)}.md`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, formatSection(r));
  fs.renameSync(tmp, file);
}

export function writeDone(dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "_done");
  fs.writeFileSync(`${file}.tmp`, `${text}\n`);
  fs.renameSync(`${file}.tmp`, file);
}
