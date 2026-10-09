// Shared helpers for the copilot-bridge and codex-bridge MCP servers.
// Kept dependency-light and standalone so each bridge is easy to read and tweak.

import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const OUTPUT_CAP_BYTES = 16 * 1024 * 1024; // hard ceiling on captured stream size

export const okText = (text) => ({ content: [{ type: "text", text }] });
export const errText = (text) => ({ content: [{ type: "text", text }], isError: true });

export function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n\n[bridge: output truncated at ${max} chars; full length was ${text.length} chars.]`,
    truncated: true,
  };
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    // Copilot double-spawns a native binary; kill the whole tree.
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* best effort */
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* best effort */
    }
  }
}

/**
 * Spawn a CLI with an argv array (never through a shell) and collect stdout/stderr.
 * Resolves with { stdout, stderr, code, timedOut } — it does not reject on non-zero exit;
 * only a spawn failure (e.g. ENOENT) rejects.
 */
export function runCli({ cmd, args, cwd, timeoutSec = 600 }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }

    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      if (out.length < OUTPUT_CAP_BYTES) out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (err.length < OUTPUT_CAP_BYTES) err += d.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutSec * 1000);
    timer.unref?.();

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, code, timedOut });
    });

    // Never block on stdin.
    child.stdin?.end();
  });
}

/** Thrown when a CLI cannot be located; `searched` lists the directories tried. */
export class NotInstalledError extends Error {
  constructor(tool, searched) {
    super(`${tool}: not installed (looked in ${searched.join(path.delimiter) || "PATH"})`);
    this.name = "NotInstalledError";
    this.tool = tool;
    this.searched = searched;
  }
}

/**
 * Directories searched for a CLI: PATH first, then (non-win32 only) the usual
 * install dirs that a GUI-launched MCP server's thin PATH tends to miss.
 */
export function searchDirs({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  if (platform !== "win32") dirs.push("/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"));
  return [...new Set(dirs)];
}

/** Find the first of `names` in the search dirs. Returns { path, searched } (path null when absent). */
export function findBinary(names, opts = {}) {
  const exists = opts.exists || fs.existsSync;
  const dirs = searchDirs(opts);
  for (const dir of dirs) {
    for (const name of [].concat(names)) {
      const full = path.join(dir, name);
      try {
        if (exists(full)) return { path: full, searched: dirs };
      } catch {
        /* ignore */
      }
    }
  }
  return { path: null, searched: dirs };
}

export function whichExe(name) {
  return findBinary(name).path;
}

/** How to invoke a JS entrypoint or native exe as { cmd, pre } for runCli. */
function fromBinPath(p) {
  return p.toLowerCase().endsWith(".js") ? { cmd: process.execPath, pre: [p] } : { cmd: p, pre: [] };
}

/**
 * Generic resolver: explicit override env, then PATH (+ extra dirs), then, on
 * win32 only, the given fallback. Throws NotInstalledError when nothing is found
 * on non-win32. `opts` (env/platform/home/exists) exists for tests.
 */
export function resolveTool(tool, { overrideEnv, names, winFallback, ...opts }) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  if (overrideEnv && env[overrideEnv]) return fromBinPath(env[overrideEnv]);
  const found = findBinary(names, { ...opts, env, platform });
  if (found.path) return { cmd: found.path, pre: [] };
  if (platform === "win32" && winFallback) return winFallback();
  throw new NotInstalledError(tool, found.searched);
}

/**
 * Copilot: on Windows prefer the npm JS loader (re-spawns the native binary);
 * elsewhere resolve `copilot` from PATH. Override with COPILOT_BRIDGE_BIN.
 */
export function resolveCopilot(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const exists = opts.exists || fs.existsSync;
  if (platform === "win32" && !env.COPILOT_BRIDGE_BIN) {
    const appdata = env.APPDATA || path.join(opts.home || os.homedir(), "AppData", "Roaming");
    const loader = path.join(appdata, "npm", "node_modules", "@github", "copilot", "npm-loader.js");
    if (exists(loader)) return { cmd: process.execPath, pre: [loader] };
  }
  return resolveTool("copilot", {
    overrideEnv: "COPILOT_BRIDGE_BIN",
    names: platform === "win32" ? ["copilot.exe"] : ["copilot"],
    winFallback: () => ({ cmd: "copilot", pre: [] }),
    ...opts,
  });
}

/** Codex: PATH first; Windows falls back to the per-user install dir. Override with CODEX_BRIDGE_BIN. */
export function resolveCodex(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  return resolveTool("codex", {
    overrideEnv: "CODEX_BRIDGE_BIN",
    names: ["codex.exe", "codex"],
    winFallback: () => ({
      cmd: path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      pre: [],
    }),
    ...opts,
  });
}

/** agy: AGY_PATH, PATH, then (win32 only) the per-user install dir. Returns { cmd, pre }. */
export function resolveAgy(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  return resolveTool("agy", {
    overrideEnv: "AGY_PATH",
    names: ["agy.exe", "agy"],
    winFallback: () => ({ cmd: path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "agy", "bin", "agy.exe"), pre: [] }),
    ...opts,
  });
}

/** grok: GROK_PATH, PATH, then (win32 only) ~/.grok/bin. Returns { cmd, pre }. */
export function resolveGrok(opts = {}) {
  const home = opts.home || os.homedir();
  return resolveTool("grok", {
    overrideEnv: "GROK_PATH",
    names: ["grok.exe", "grok"],
    winFallback: () => ({ cmd: path.join(home, ".grok", "bin", "grok.exe"), pre: [] }),
    ...opts,
  });
}

export function startServer(name, version, register) {
  const server = new McpServer({ name, version });
  register(server);
  server.connect(new StdioServerTransport()).catch((e) => {
    console.error(`${name} failed to start:`, e);
    process.exit(1);
  });
}
