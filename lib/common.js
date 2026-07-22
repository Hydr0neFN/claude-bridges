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

export function whichExe(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      if (fs.existsSync(full)) return full;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** How to invoke a JS entrypoint or native exe as { cmd, pre } for runCli. */
function fromBinPath(p) {
  return p.toLowerCase().endsWith(".js") ? { cmd: process.execPath, pre: [p] } : { cmd: p, pre: [] };
}

/**
 * Copilot ships a JS loader (npm-loader.js) that re-spawns the platform native binary.
 * Running it with node is the canonical entrypoint. Override with COPILOT_BRIDGE_BIN.
 */
export function resolveCopilot() {
  if (process.env.COPILOT_BRIDGE_BIN) return fromBinPath(process.env.COPILOT_BRIDGE_BIN);
  const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const loader = path.join(appdata, "npm", "node_modules", "@github", "copilot", "npm-loader.js");
  if (fs.existsSync(loader)) return { cmd: process.execPath, pre: [loader] };
  // Last resort: hope a `copilot` shim is resolvable (may require it be a real exe).
  return { cmd: whichExe("copilot.exe") || "copilot", pre: [] };
}

/**
 * Codex installs a native codex.exe on PATH. Prefer that; fall back to the known
 * per-user install location. Override with CODEX_BRIDGE_BIN.
 */
export function resolveCodex() {
  if (process.env.CODEX_BRIDGE_BIN) return fromBinPath(process.env.CODEX_BRIDGE_BIN);
  const onPath = whichExe("codex.exe") || whichExe("codex");
  if (onPath) return { cmd: onPath, pre: [] };
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return { cmd: path.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"), pre: [] };
}

export function startServer(name, version, register) {
  const server = new McpServer({ name, version });
  register(server);
  server.connect(new StdioServerTransport()).catch((e) => {
    console.error(`${name} failed to start:`, e);
    process.exit(1);
  });
}
