// Panel runner shared by consult-cli and consult-bridge: every engine runs
// concurrently with its own timeout (enforced inside the engine), and each
// result is handed to onSettle the moment that engine finishes.

import fs from "node:fs";
import path from "node:path";

/** Run `order` engines concurrently. `run(name)` -> result; `onSettle(name, result)` fires per engine in completion order. */
export async function runPanel({ order, run, onSettle }) {
  return Promise.all(
    order.map(async (name) => {
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
    }),
  );
}

/** One whole stdout section for a settled engine. */
export function formatSection(r) {
  return `## ${r.engine}\n\n${r.ok ? r.body : `[failed] ${r.reason}`}\n`;
}

/** Final summary line for mode all; null when nothing answered (caller reports failure instead). */
export function summaryLine(results) {
  const good = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok).map((r) => `${r.engine}: ${r.reason}`);
  if (!good.length) return null;
  return `[consult] mode: all | answered: ${good.map((r) => r.engine).join(", ")}${failed.length ? ` | failed: ${failed.join("; ")}` : ""}`;
}

/** Write <dir>/<name>.md atomically (tmp + rename) so a reader never sees a partial file. */
export function writeEngineResult(dir, name, r) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
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
