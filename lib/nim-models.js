// Bi-weekly check for newly listed NVIDIA NIM models.
//
// One GET /v1/models every 14 days, diffed against the ids seen before. A listing
// is not proof a model is callable for this key, so the notice only says "worth a
// look". Results land in a cache file that agents (and an external hook) read;
// nothing here ever blocks a consult or throws.
//
// Cache: <CLAUDE_BRIDGES_CACHE_DIR || ~/.cache/claude-bridges>/nim-models.json
//   { "checkedAt": <ms>,        // last SUCCESSFUL listing (unchanged by a failure); 0 = never succeeded
//     "attemptAt": <ms>,        // last attempt, stamped before the network work
//     "baselineAt": <ms>,       // when `seen` was first recorded
//     "seen": [ids],            // every id ever listed
//     "new": [ids],             // chat-ish ids first listed by the latest successful check
//     "error": null|"string" }  // last listing failure, redacted; `new`/`seen` kept from before
// `new` is replaced at every successful check. No key material is ever stored.
//
// Notice throttle (shared with an external Python hook, so the contract below is exact):
// <same dir>/nim-notice.json = { "key": "<checkedAt>:<new ids joined by ,>", "count", "windowStart": <ms>, "cooldownUntil": <ms> }
// The notice shows at most 3 times per key, then stays silent for a day; a new key (new check result) starts over.
// Stale = checkedAt is older than the TTL (14 days) AND attemptAt is older than 1 day, so a
// failing catalog is retried daily instead of silencing checks for a whole TTL.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { resolveNimKey, redact, nimBase, parseSpec } from "./engines.js";
import { cacheFilePath, writeCache, isFresh, REPO_DIR } from "./updates.js";

export const DEFAULT_CHECK_DAYS = 14;
export const MAX_NOTICE_IDS = 6;
export const NOTICE_MAX_SHOWS = 3;
export const NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_ATTEMPT_MS = 24 * 60 * 60 * 1000;
const LIST_TIMEOUT_SEC = 30;

/** Ids matching this are not chat models (embeddings, guards, speech, ...) and are not reported as new. */
export const NIM_NON_CHAT_RE = /embed|rerank|retriev|safety|guard|reward|parse|clip|ocr|vlm-embed|tts|asr|whisper/i;

export const nimCachePath = (env = process.env, home = os.homedir()) =>
  path.join(path.dirname(cacheFilePath(env, home)), "nim-models.json");

export const nimNoticePath = (env = process.env, home = os.homedir()) =>
  path.join(path.dirname(nimCachePath(env, home)), "nim-notice.json");

/** Check interval in ms; NIM_MODELS_CHECK_DAYS overrides when a positive number. */
export function nimTtlMs(env = process.env) {
  const days = Number(env.NIM_MODELS_CHECK_DAYS);
  return (days > 0 ? days : DEFAULT_CHECK_DAYS) * 24 * 60 * 60 * 1000;
}

/** True when an order contains a nim entry (bare `nim` or `nim:<model>`). */
export const orderUsesNim = (order) => (order || []).some((spec) => parseSpec(spec).engine === "nim");

export function readNimCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isFinite(c.checkedAt) || !Array.isArray(c.seen) || !Array.isArray(c.new)) return null;
    const attemptAt = Number.isFinite(c.attemptAt) ? c.attemptAt : c.checkedAt;
    return { ...c, attemptAt, new: c.new.filter((id) => typeof id === "string") };
  } catch {
    return null;
  }
}

/** Due for a check: the last success is older than the TTL and the last attempt older than a day. */
export function isStale(cache, now, env = process.env) {
  if (!cache) return true;
  return !isFresh(cache, now, nimTtlMs(env)) && !isFresh({ checkedAt: cache.attemptAt }, now, RETRY_AFTER_ATTEMPT_MS);
}

async function listModelIds({ base, key, fetchImpl }) {
  const res = await fetchImpl(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(LIST_TIMEOUT_SEC * 1000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail.trim().slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()).data;
  if (!Array.isArray(data)) throw new Error("unexpected /v1/models response");
  const ids = [...new Set(data.map((m) => m?.id).filter((id) => typeof id === "string" && id))];
  if (!ids.length) throw new Error("empty model list");
  return ids;
}

/**
 * Run (or skip) one check in-process. Throttled unless `force`.
 * -> { skipped: "no key"|"fresh"|null, cache }. Never throws.
 */
export async function refreshNimModels({
  force = false, env = process.env, home = os.homedir(), file = nimCachePath(env, home),
  now = Date.now(), fetchImpl = fetch, readFile,
} = {}) {
  const key = resolveNimKey({ env, home, readFile });
  const prev = readNimCache(file);
  if (!key) return { skipped: "no key", cache: prev };
  if (!force && !isStale(prev, now, env)) return { skipped: "fresh", cache: prev };

  // Stamp the attempt first so a killed or concurrent run does not retry on every call.
  const base = prev ?? { checkedAt: 0, attemptAt: now, baselineAt: now, seen: [], new: [], error: null };
  writeCache(file, { ...base, attemptAt: now });

  let ids;
  try {
    ids = await listModelIds({ base: nimBase(env), key, fetchImpl });
  } catch (e) {
    const why = e.name === "TimeoutError" ? `timed out after ${LIST_TIMEOUT_SEC}s` : e.message;
    const cache = { ...base, attemptAt: now, error: redact(`listing failed: ${why}`, key) };
    writeCache(file, cache);
    return { skipped: null, cache };
  }

  // Empty `seen` = first successful check: record a baseline, report nothing.
  const known = new Set(base.seen);
  const cache = {
    checkedAt: now,
    attemptAt: now,
    baselineAt: known.size ? base.baselineAt : now,
    seen: [...new Set([...base.seen, ...ids])],
    new: known.size ? ids.filter((id) => !known.has(id) && !NIM_NON_CHAT_RE.test(id)) : [],
    error: null,
  };
  writeCache(file, cache);
  return { skipped: null, cache };
}

/** One notice line for agents, or null when nothing is new. */
export function formatNimNotice(cache) {
  const ids = cache?.new || [];
  if (!ids.length) return null;
  const shown = ids.slice(0, MAX_NOTICE_IDS).join(", ");
  const more = ids.length > MAX_NOTICE_IDS ? ` (+${ids.length - MAX_NOTICE_IDS} more)` : "";
  const date = new Date(cache.checkedAt).toISOString().slice(0, 10);
  return `[consult] NIM: ${ids.length} new model${ids.length === 1 ? "" : "s"} since ${date}: ${shown}${more} -> worth a look in a separate session; try --order nim:<id>`;
}

/** Throttle key for a cache: identifies one check result. */
export const noticeKey = (cache) => `${cache.checkedAt}:${(cache.new || []).join(",")}`;

/**
 * Pure throttle rule. `state` is the previous file content (anything; unusable = none).
 * -> the next state to persist when the notice may be shown now, or null when it must stay silent.
 */
export function noticeAllowed(state, key, now) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  let st = state && typeof state === "object" && state.key === key ? state : null;
  st = st ? { ...st, count: num(st.count), windowStart: num(st.windowStart), cooldownUntil: num(st.cooldownUntil) }
    : { key, count: 0, windowStart: 0, cooldownUntil: 0 };
  if (now < st.cooldownUntil) return null;
  // `now < windowStart` = the clock moved back; start a fresh window instead of waiting it out.
  if (now - st.windowStart >= NOTICE_WINDOW_MS || now < st.windowStart) st = { ...st, count: 0, windowStart: now };
  const count = st.count + 1;
  return { ...st, count, cooldownUntil: count >= NOTICE_MAX_SHOWS ? now + NOTICE_WINDOW_MS : 0 };
}

/**
 * Notice text for a cache, gated by the shared throttle file. -> { text, commit }.
 * `text` is null when there is nothing new or the throttle says silent. Call `commit()` only
 * once the text was actually printed/appended. Any file problem fails open (shows; commit is best effort).
 * Known and accepted: read-decide-write has no lock, so processes starting at the same moment can each
 * show the notice once before any of them writes; the cap can be exceeded by simultaneous starts.
 */
export function nimNoticeGate(cache, {
  env = process.env, home = os.homedir(), file = nimNoticePath(env, home), now,
} = {}) {
  const none = { text: null, commit() {} };
  const text = formatNimNotice(cache);
  if (!text) return none;
  const key = noticeKey(cache);
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null; // missing or corrupt = no previous state
    }
  };
  if (!noticeAllowed(read(), key, now ?? Date.now())) return none;
  return {
    text,
    // Re-apply the rule to the file as it is NOW: other runs may have written since the decision,
    // and a stale snapshot would overwrite their count. If the rule already says silent (a parallel run
    // used up the shows), keep that state as is.
    commit() {
      const next = noticeAllowed(read(), key, now ?? Date.now());
      if (next) writeCache(file, next);
    },
  };
}

/** Spawn `consult-cli.js --refresh-nim-models` detached (same pattern as updates.spawnRefresh). */
export function spawnNimRefresh() {
  try {
    const child = spawn(process.execPath, [path.join(REPO_DIR, "consult-cli.js"), "--refresh-nim-models"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best effort */
  }
}

/**
 * Cheap, synchronous view for short-lived callers: the cached result now, plus a
 * detached refresh when the cache is stale and a key exists. Never touches the network.
 * Callers only invoke this for runs whose order includes nim.
 */
export function peekNimModels({
  env = process.env, home = os.homedir(), file = nimCachePath(env, home), now = Date.now(),
  detach = spawnNimRefresh, readFile,
} = {}) {
  const cache = readNimCache(file);
  if (isStale(cache, now, env) && resolveNimKey({ env, home, readFile })) detach?.();
  return cache;
}
