// Update checks for the engine CLIs and for this repo itself.
//
// Never installs anything unless applyUpdates() is called (via --update).
// Checks are throttled to once per CACHE_TTL_MS through a cache file, run with
// short timeouts, and never throw: a failed check just reports nothing.

import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, resolveCopilot, resolveCodex, resolveAgy } from "./common.js";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function cacheFilePath(env = process.env, home = os.homedir()) {
  return path.join(env.CLAUDE_BRIDGES_CACHE_DIR || path.join(home, ".cache", "claude-bridges"), "updates.json");
}

export function readCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(c.items) && Number.isFinite(c.checkedAt) ? c : null;
  } catch {
    return null;
  }
}

export function writeCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch {
    /* cache is best effort */
  }
}

export const isFresh = (cache, now = Date.now(), ttl = CACHE_TTL_MS) =>
  !!cache && now - cache.checkedAt >= 0 && now - cache.checkedAt < ttl;

/** One footer line, or null when nothing is outdated. */
export function formatFooter(items, command = `node ${path.join(REPO_DIR, "consult-cli.js")} --update`) {
  if (!items?.length) return null;
  const parts = items.map((i) => {
    if (i.kind === "repo") return `${i.name} ${i.behind} commit${i.behind === 1 ? "" : "s"} behind`;
    const v = i.current && i.latest ? ` ${i.current} -> ${i.latest}` : "";
    return `${i.name}${v}${i.token ? "" : " (update manually)"}`;
  });
  return `[consult] updates available: ${parts.join("; ")} -- run: ${command}`;
}

/** Cask token when `realPath` lives under a Homebrew Caskroom, else null. */
export function caskToken(realPath) {
  const m = /\/Caskroom\/([^/]+)\//.exec(realPath || "");
  return m ? m[1] : null;
}

/** Extract outdated casks from `brew outdated --cask --json=v2` output, keyed by token. */
export function parseBrewOutdated(stdout) {
  try {
    const casks = JSON.parse(stdout).casks || [];
    return new Map(
      casks.map((c) => [c.name, { current: (c.installed_versions || []).slice(-1)[0], latest: c.current_version }]),
    );
  } catch {
    return new Map();
  }
}

/** Heuristic for `copilot version` output of a non-brew install. */
export function copilotSaysOutdated(text) {
  return !/latest version/i.test(text) && /update available|new(er)? version|can be updated|upgrade/i.test(text);
}

// Never let git block on a credential or host-key prompt.
export const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };

const quiet = async (run, cmd, args, opts) => {
  try {
    return await run({ cmd, args, ...opts });
  } catch {
    return null;
  }
};

/** Gather outdated items. `run` is runCli-compatible; all inputs injectable for tests. */
export async function collectUpdates({
  run = runCli,
  repoDir = REPO_DIR,
  resolvers = { copilot: resolveCopilot, codex: resolveCodex, agy: resolveAgy },
  realpath = fs.realpathSync,
  timeoutSec = 15,
} = {}) {
  const engines = [];
  for (const [name, resolve] of Object.entries(resolvers)) {
    try {
      const { cmd, pre } = resolve();
      let real = cmd;
      try {
        real = realpath(cmd);
      } catch {
        /* keep unresolved path */
      }
      engines.push({ name, cmd, pre, token: caskToken(real) || caskToken(cmd) });
    } catch {
      /* not installed: nothing to update */
    }
  }

  const items = [];
  const tokens = engines.filter((e) => e.token);
  if (tokens.length) {
    // --greedy: casks with auto_updates true (e.g. copilot-cli) are otherwise never listed.
    const r = await quiet(run, "brew", ["outdated", "--cask", "--greedy", "--json=v2"], { timeoutSec });
    const outdated = r && r.code === 0 ? parseBrewOutdated(r.stdout) : new Map();
    for (const e of tokens) {
      const o = outdated.get(e.token);
      if (o) items.push({ kind: "cli", name: e.name, token: e.token, current: o.current, latest: o.latest });
    }
  }
  const copilot = engines.find((e) => e.name === "copilot" && !e.token);
  if (copilot) {
    const r = await quiet(run, copilot.cmd, [...copilot.pre, "version"], { timeoutSec });
    if (r && r.code === 0 && copilotSaysOutdated(r.stdout)) items.push({ kind: "cli", name: "copilot", token: null });
  }

  const fetched = await quiet(run, "git", ["-C", repoDir, "fetch", "--quiet"], { timeoutSec, env: GIT_ENV });
  if (fetched && fetched.code === 0) {
    const r = await quiet(run, "git", ["-C", repoDir, "rev-list", "--count", "HEAD..@{u}"], { timeoutSec });
    const behind = r && r.code === 0 ? Number(r.stdout.trim()) : 0;
    if (behind > 0) items.push({ kind: "repo", name: "claude-bridges", behind });
  }
  return items;
}

/**
 * Throttled check. Fresh cache -> returned without any work. Otherwise the
 * attempt is stamped in the cache immediately (so a process killed mid-check
 * does not retry on every run), then replaced with the result.
 * `result.items` is the best known outdated list; `result.pending` resolves
 * once a live check finishes (resolves to the same shape).
 */
export function checkUpdates({ force = false, now = Date.now(), file = cacheFilePath(), collect = collectUpdates, detach = null } = {}) {
  const cache = readCache(file);
  if (!force && isFresh(cache, now)) {
    return { items: cache.items, fromCache: true, pending: Promise.resolve({ items: cache.items, fromCache: true }) };
  }
  const previous = cache?.items || [];
  writeCache(file, { checkedAt: now, items: previous });
  if (detach) {
    // Short-lived callers: refresh in a detached child so exit is never delayed.
    detach(file);
    return { items: previous, fromCache: true, pending: Promise.resolve({ items: previous, fromCache: true }) };
  }
  const pending = collect()
    .catch(() => previous)
    .then((items) => {
      writeCache(file, { checkedAt: now, items });
      return { items, fromCache: false };
    });
  return { items: previous, fromCache: true, pending };
}

/** Spawn lib/refresh-updates.js detached; it writes the cache file when done. */
export function spawnRefresh(file) {
  try {
    const child = spawn(process.execPath, [path.join(REPO_DIR, "lib", "refresh-updates.js"), file], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best effort */
  }
}

/** Wait for a live result for at most `ms`, else fall back to the cached items. */
export async function settle(check, ms) {
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r({ items: check.items, fromCache: true }), ms);
    timer.unref?.();
  });
  const r = await Promise.race([check.pending, timeout]);
  clearTimeout(timer);
  return r;
}

/** Apply updates: brew upgrade for outdated casks, git pull --ff-only for the repo. Returns { log, failed }. */
export async function applyUpdates({ items, run = runCli, repoDir = REPO_DIR, timeoutSec = 600 } = {}) {
  const log = [];
  let failed = false;
  const tokens = items.filter((i) => i.kind === "cli" && i.token).map((i) => i.token);
  for (const i of items.filter((i) => i.kind === "cli" && !i.token)) log.push(`${i.name}: not brew-managed, update it manually`);
  if (tokens.length) {
    const r = await quiet(run, "brew", ["upgrade", "--cask", ...tokens], { timeoutSec });
    if (r && r.code === 0) log.push(`brew upgrade --cask ${tokens.join(" ")}: done`);
    else (failed = true), log.push(`brew upgrade failed: ${(r?.stderr || "no output").trim().slice(-300)}`);
  }
  if (items.some((i) => i.kind === "repo")) {
    const st = await quiet(run, "git", ["-C", repoDir, "status", "--porcelain"], { timeoutSec: 15 });
    if (!st || st.code !== 0) (failed = true), log.push("claude-bridges: cannot read git status, not pulling");
    else if (st.stdout.trim()) (failed = true), log.push("claude-bridges: refusing to pull, repo has uncommitted changes");
    else {
      const r = await quiet(run, "git", ["-C", repoDir, "pull", "--ff-only"], { timeoutSec: 60, env: GIT_ENV });
      if (r && r.code === 0) log.push("claude-bridges: git pull --ff-only done");
      else (failed = true), log.push(`claude-bridges: pull failed: ${(r?.stderr || "no output").trim().slice(-300)}`);
    }
  }
  if (!log.length) log.push("nothing to update");
  return { log, failed };
}
