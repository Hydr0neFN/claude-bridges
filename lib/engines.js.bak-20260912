// Slim engine runners used by consult-bridge's fallback chain.
// Deliberately independent of copilot-bridge/codex-bridge so the individual
// (already-tested) bridges carry zero refactor risk. ~30 duplicated lines, accepted.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { runCli, resolveCopilot, resolveCodex, whichExe } from "./common.js";

// Same restrictive posture as copilot-bridge: no writes, read/search/git-gh only.
const COPILOT_PERM_ARGS = [
  "-s",
  "--no-color",
  "--no-ask-user",
  "--deny-tool=write",
  "--allow-tool=shell(ls)",
  "--allow-tool=shell(dir)",
  "--allow-tool=shell(cat)",
  "--allow-tool=shell(type)",
  "--allow-tool=shell(head)",
  "--allow-tool=shell(tail)",
  "--allow-tool=shell(grep)",
  "--allow-tool=shell(rg)",
  "--allow-tool=shell(find)",
  "--allow-tool=shell(pwd)",
  "--allow-tool=shell(wc)",
  "--allow-tool=shell(git:*)",
  "--allow-tool=shell(gh:*)",
];

function resolveAgy() {
  if (process.env.AGY_PATH) return process.env.AGY_PATH;
  const onPath = whichExe("agy.exe") || whichExe("agy");
  if (onPath) return onPath;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "agy", "bin", "agy.exe");
}

function outcome(engine, res, body) {
  const stderrTail = res.stderr.trim().slice(-400);
  if (res.timedOut) return { engine, ok: false, reason: "timed out", body };
  if (res.code !== 0) {
    return { engine, ok: false, reason: `exit ${res.code}${stderrTail ? `: ${stderrTail}` : ""}`, body };
  }
  if (!body) {
    return { engine, ok: false, reason: `empty output${stderrTail ? `: ${stderrTail}` : ""}` };
  }
  return { engine, ok: true, body };
}

async function launch(engine, cmd, args, cwd, timeoutSec, bodyOf) {
  let res;
  try {
    res = await runCli({ cmd, args, cwd, timeoutSec });
  } catch (e) {
    return { engine, ok: false, reason: `launch failed: ${e.message}` };
  }
  return outcome(engine, res, bodyOf ? bodyOf(res) : res.stdout.trim());
}

export const ENGINES = {
  copilot({ prompt, cwd, timeoutSec }) {
    const { cmd, pre } = resolveCopilot();
    return launch("copilot", cmd, [...pre, "-p", prompt, "-C", cwd, ...COPILOT_PERM_ARGS], cwd, timeoutSec);
  },

  async codex({ prompt, cwd, timeoutSec }) {
    const { cmd, pre } = resolveCodex();
    const outFile = path.join(os.tmpdir(), `consult-codex-${process.pid}-${randomUUID()}.txt`);
    const args = [
      ...pre,
      "exec",
      prompt,
      "-C",
      cwd,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-o",
      outFile,
    ];
    const result = await launch("codex", cmd, args, cwd, timeoutSec, (res) => {
      let finalMsg = "";
      try {
        finalMsg = fs.readFileSync(outFile, "utf8").trim();
      } catch {
        /* codex may have errored before writing */
      }
      return finalMsg || res.stdout.trim();
    });
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      /* best effort */
    }
    return result;
  },

  agy({ prompt, cwd, timeoutSec }) {
    // Same invocation shape agy-bridge uses (skip-permissions + print-timeout).
    const args = [
      "--dangerously-skip-permissions",
      "--add-dir",
      cwd,
      "--print-timeout",
      `${timeoutSec}s`,
      "-p",
      prompt,
    ];
    return launch("agy", resolveAgy(), args, cwd, timeoutSec);
  },
};

export const ENGINE_NAMES = Object.keys(ENGINES);
