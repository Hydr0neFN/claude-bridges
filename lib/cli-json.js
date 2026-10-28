// The --json envelope of consult-cli (same contract as agent-mesh docs/cli-json.md): exactly one object on stdout,
// {ok, code, message, data}; exit codes 0 ok, 1 other, 2 usage, 3 config, 4 network, 5 auth, 6 not found.
// Pure helpers only; consult-cli.js decides when to print. Text mode (no --json) does not use any of this.
import path from "node:path";
import { safeFileName } from "./panel.js";

export const EXIT = { ok: 0, other: 1, usage: 2, config: 3, network: 4, auth: 5, notFound: 6 };

const clip = (t, n = 400) => { const x = String(t ?? ""); return x.length > n ? `${x.slice(0, n)}...` : x; };

export const envelope = (ok, code, message, data = {}) => ({ ok, code, message, data });

// Order matters: the first match wins. Codes are stable (append-only).
const FAILURE_CODES = [
  ["QUOTA_EXHAUSTED", /\b429\b|rate.?limit|quota|exhaust|too many requests|usage limit|out of credits|insufficient (credit|funds|balance)|\b402\b|free pool at/i],
  ["AUTH_FAILED", /auth|log ?in|credential|HTTP 40[13]\b|no [A-Z_]*API_KEY|no key/i],
  ["NOT_INSTALLED", /not installed|launch failed|ENOENT/i],
  ["TIMEOUT", /time(d)? ?out|timeout/i],
  ["EMPTY_OUTPUT", /empty output|reasoning only/i],
  ["CRASHED", /^crashed:/i],
];

/** Stable failure code for an engine's failure reason (UPPER_SNAKE); ENGINE_ERROR when nothing matches. */
export function failureCode(reason) {
  const s = String(reason ?? "");
  for (const [code, re] of FAILURE_CODES) if (re.test(s)) return code;
  return "ENGINE_ERROR";
}

/** One engine's entry. `outDir` set -> the body is in <outDir>/<engine>.md (path given); else (or `inlineBody`) the body is inlined. */
export function engineEntry(r, { outDir, inlineBody = false } = {}) {
  const e = { engine: r.engine, ok: !!r.ok, code: r.ok ? (r.degraded ? "DEGRADED" : "OK") : failureCode(r.reason) };
  if (!r.ok) e.reason = clip(r.reason);
  else {
    e.chars = String(r.body ?? "").length;
    if (r.degraded) e.degraded = true;
    if (outDir) e.file = path.join(outDir, `${safeFileName(r.engine)}.md`);
    if (inlineBody || !outDir) e.body = r.body ?? "";
  }
  return e;
}

/** The envelope of a finished mode-all or mode-first run. `results`: engine results in settle order. */
export function runEnvelope({ mode, results, outDir, trail = [] }) {
  const engines = results.map((r) => engineEntry(r, { outDir, inlineBody: mode === "first" }));
  const answered = engines.filter((e) => e.ok).map((e) => e.engine);
  const quota = engines.filter((e) => e.code === "QUOTA_EXHAUSTED").map((e) => e.engine);
  const data = {
    mode,
    answered,
    failed: engines.filter((e) => !e.ok).map((e) => e.engine),
    quota_exhausted: quota,
    ...(outDir ? { out_dir: outDir, done_file: path.join(outDir, "_done") } : {}),
    ...(trail.length ? { failover: trail.map((t) => clip(t)) } : {}),
    engines,
  };
  if (!answered.length) return envelope(false, "ALL_ENGINES_FAILED", `all engines failed: ${engines.map((e) => `${e.engine}: ${e.code}`).join(", ")}`, data);
  return envelope(true, "OK", `answered: ${answered.join(", ")}${data.failed.length ? ` | failed: ${data.failed.join(", ")}` : ""}`, data);
}
