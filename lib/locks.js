// Quota locks: an engine that reports a usage/quota limit is skipped until its reset time.
// State lives outside git (default ~/.claude/state/consult-locks.json, env CONSULT_LOCKS_FILE):
// { "<engine>": { until: ISO, reason: "...", at: ISO } }. Expiry is automatic; unknown errors never lock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Engines whose quota can run out for days or a month (CLI subscriptions). HTTP engines only hit short per-minute limits. */
export const LOCKABLE = ["copilot", "codex", "agy"];

const DAY_MS = 24 * 3600 * 1000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Quota-style limit text. A bare "rate limit" / HTTP 429 is a per-minute throttle and does not match.
const LIMIT_TEXT = /usage limit|\bquota\b[^.\n]{0,60}(exceed|exhaust|reach|used|remain|depleted)|(exceed|exhaust|reach|ran out|out of|no)[^.\n]{0,40}\b(quota|credits?|usage)\b|credits? (exceeded|exhausted|depleted)|premium requests?[^.\n]{0,40}(exceed|exhaust|limit)/i;
const MONTH_TEXT = /\bmonth(ly)?\b/i;
// "try again at Nov 16th, 2026 10:54 PM" (Codex), local time of the machine.
const RESET_AT = /(?:try again|resets?|available again)(?: at| on)?\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i;
const RETRY_AFTER = /retry[- ]after\W{0,3}\s*(\d+(?:\.\d+)?|[A-Za-z]{3},[^;|\n]+GMT)/i;

/**
 * Failure reason -> { until: ms, label } for a recognised limit, else null.
 * Order: engine-given reset time, 429 + Retry-After, monthly credits (00:00 UTC on the 1st), other limit text (+24 h).
 */
export function parseLimit(reason, now = Date.now()) {
  const text = String(reason ?? "");
  const m = RESET_AT.exec(text);
  if (m && (LIMIT_TEXT.test(text) || /limit/i.test(text))) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mon >= 0) {
      const h = m[6] ? Number(m[4]) % 12 + (/pm/i.test(m[6]) ? 12 : 0) : Number(m[4]);
      const until = new Date(Number(m[3]), mon, Number(m[2]), h, Number(m[5])).getTime();
      if (until > now) return { until, label: "usage limit, engine reset time" };
    }
  }
  if (/\b429\b/.test(text)) {
    const r = RETRY_AFTER.exec(text);
    if (r) {
      const sec = /^\d/.test(r[1]) ? Number(r[1]) : (Date.parse(r[1]) - now) / 1000;
      if (sec > 0) return { until: now + sec * 1000, label: "HTTP 429 Retry-After" };
    }
  }
  if (LIMIT_TEXT.test(text)) {
    if (MONTH_TEXT.test(text)) {
      const d = new Date(now);
      return { until: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), label: "monthly credits" };
    }
    return { until: now + DAY_MS, label: "limit text, +24 h" };
  }
  return null;
}

export const lockFile = (env = process.env) =>
  env.CONSULT_LOCKS_FILE || path.join(os.homedir(), ".claude", "state", "consult-locks.json");

/** All lock entries on file (tolerant: missing/corrupt file = none). */
export function readLocks(file = lockFile()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeLocks(file, locks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(locks, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const live = (e, now) => e && Date.parse(e.until) > now;

/** Active (unexpired) locks only. */
export function activeLocks(file = lockFile(), now = Date.now()) {
  return Object.fromEntries(Object.entries(readLocks(file)).filter(([, e]) => live(e, now)));
}

/** Local "YYYY-MM-DD HH:MM" for a lock's `until`. */
export function localTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const lockedReason = (e) => `skipped: locked until ${localTime(e.until)} (${e.reason})`;

/** Lock `engine` when `reason` is a recognised limit and the engine is lockable. -> the entry, or null. */
export function recordLock(engine, reason, { file = lockFile(), now = Date.now() } = {}) {
  if (!LOCKABLE.includes(engine)) return null;
  const p = parseLimit(reason, now);
  if (!p) return null;
  const locks = activeLocks(file, now);
  const prev = locks[engine];
  if (prev && Date.parse(prev.until) >= p.until) return prev;
  const entry = { until: new Date(p.until).toISOString(), reason: p.label, at: new Date(now).toISOString() };
  locks[engine] = entry;
  try {
    writeLocks(file, locks);
  } catch {
    return null; // an unwritable state dir must never break a consult run
  }
  return entry;
}

/** Remove the lock of one engine or "all". -> engines that were unlocked. */
export function unlock(target, { file = lockFile() } = {}) {
  const locks = readLocks(file);
  const names = target === "all" ? Object.keys(locks) : Object.hasOwn(locks, target) ? [target] : [];
  for (const n of names) delete locks[n];
  if (names.length) writeLocks(file, locks);
  return names;
}

/**
 * Wrap a `run(spec, base, perEngine)` (runSpec): a locked engine is skipped without being called, and a
 * recognised limit failure writes the lock. `ignore` bypasses both the check and the write.
 */
export function withLocks(run, { ignore = false, file = lockFile(), now = () => Date.now() } = {}) {
  return async (spec, base, perEngine) => {
    const engine = String(spec).split(":")[0];
    if (!ignore) {
      const e = activeLocks(file, now())[engine];
      if (e) return { engine: spec, ok: false, skipped: true, reason: lockedReason(e) };
    }
    const r = await run(spec, base, perEngine);
    if (!ignore && !r.ok && !r.skipped) {
      const e = recordLock(engine, r.reason, { file, now: now() });
      if (e) return { ...r, reason: `${r.reason} | now locked until ${localTime(e.until)} (${e.reason})` };
    }
    return r;
  };
}
