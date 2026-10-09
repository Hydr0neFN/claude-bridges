// Engine runners used by consult-bridge and consult-cli. Binary resolution is
// shared with the legacy solo bridges through lib/common.js. Every engine
// resolves to { engine, ok, body } or { engine, ok: false, reason }.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { runCli, resolveCopilot, resolveCodex, resolveAgy, resolveGrok, NotInstalledError } from "./common.js";

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

// deeperseeker proxy (DeepSeek web account fronted as an OpenAI-compatible API).
// Unlike the CLI engines this one is a plain HTTP call: it has no cwd, no shell
// and no file access, so it only ever sees the prompt text.
function deepseekCreds() {
  const base = process.env.DEEPSEEKER_BASE || "http://127.0.0.1:4000";
  const model = process.env.DEEPSEEKER_MODEL || "v4.1flash";
  let key = process.env.DEEPSEEKER_API_KEY || "";
  if (!key) {
    // Secret lives in the proxy's own .env so it never lands in this repo.
    const envPath =
      process.env.DEEPSEEKER_ENV_PATH ||
      path.join(os.homedir(), "Claude", "deeperseeker", ".env");
    try {
      const m = fs.readFileSync(envPath, "utf8").match(/^DEEPSEEKER_API_KEY=(.*)$/m);
      if (m) key = m[1].trim();
    } catch {
      /* proxy not installed on this machine */
    }
  }
  return { base, model, key };
}

const fail = (engine, reason) => ({ engine, ok: false, reason });

/** Map a spawn/resolve error to a clear failure (never a raw ENOENT). */
export function launchFailure(engine, e) {
  if (e instanceof NotInstalledError) return fail(engine, e.message.replace(/^[^:]+: /, ""));
  if (e.code === "ENOENT") return fail(engine, `not installed (${e.message})`);
  return fail(engine, `launch failed: ${e.message}`);
}

function outcome(engine, res, body, timeoutSec) {
  const stderrTail = res.stderr.trim().slice(-400);
  if (res.timedOut) return fail(engine, `timed out after ${timeoutSec}s`);
  if (res.code !== 0) return fail(engine, `exit ${res.code}${stderrTail ? `: ${stderrTail}` : ""}`);
  if (!body) return fail(engine, `empty output${stderrTail ? `: ${stderrTail}` : ""}`);
  return { engine, ok: true, body };
}

/** Run a CLI engine; `resolve` yields { cmd, pre } or throws NotInstalledError. */
async function launch(engine, resolve, args, cwd, timeoutSec, bodyOf) {
  let res;
  try {
    const { cmd, pre } = resolve();
    res = await runCli({ cmd, args: [...pre, ...args], cwd, timeoutSec });
  } catch (e) {
    return launchFailure(engine, e);
  }
  return outcome(engine, res, bodyOf ? bodyOf(res) : res.stdout.trim(), timeoutSec);
}

const COPILOT_MODEL_REJECTED = /Model "[^"]*" from --model flag is not available/;

/** True when Copilot rejected the --model flag (e.g. auto-only Student plan). */
export function copilotRejectedModel(res) {
  return res.code !== 0 && COPILOT_MODEL_REJECTED.test(`${res.stderr}\n${res.stdout}`);
}

export function copilotArgs({ prompt, cwd, model, effort }) {
  return [
    "-p", prompt, "-C", cwd, ...COPILOT_PERM_ARGS,
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--reasoning-effort", effort] : []),
  ];
}

export function codexArgs({ prompt, cwd, outFile, model, effort }) {
  return [
    "exec", prompt, "-C", cwd, "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-o", outFile,
    ...(model ? ["-m", model] : []),
    ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
  ];
}

export const ENGINES = {
  async copilot({ prompt, cwd, timeoutSec, model, effort }) {
    model = model || process.env.COPILOT_MODEL || undefined;
    effort = effort || process.env.COPILOT_EFFORT || undefined;
    let res;
    try {
      const { cmd, pre } = resolveCopilot();
      const run = (m) => runCli({ cmd, args: [...pre, ...copilotArgs({ prompt, cwd, model: m, effort })], cwd, timeoutSec });
      res = await run(model);
      if (model && copilotRejectedModel(res)) {
        // Auto-only plans (e.g. Copilot Student) reject --model: retry once on auto.
        res = await run(undefined);
        return outcome(`copilot (auto; ${model} unavailable on this plan)`, res, res.stdout.trim(), timeoutSec);
      }
    } catch (e) {
      return launchFailure("copilot", e);
    }
    return outcome("copilot", res, res.stdout.trim(), timeoutSec);
  },

  async codex({ prompt, cwd, timeoutSec, model, effort }) {
    model = model || process.env.CODEX_MODEL || undefined;
    effort = effort || process.env.CODEX_EFFORT || undefined;
    const outFile = path.join(os.tmpdir(), `consult-codex-${process.pid}-${randomUUID()}.txt`);
    const args = codexArgs({ prompt, cwd, outFile, model, effort });
    const result = await launch("codex", resolveCodex, args, cwd, timeoutSec, (res) => {
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
    return launch("agy", resolveAgy, args, cwd, timeoutSec);
  },

  async deepseek({ prompt, timeoutSec }) {
    const { base, model, key } = deepseekCreds();
    const bad = (reason) => fail("deepseek", reason);
    if (!key) return bad("no DEEPSEEKER_API_KEY (env or deeperseeker .env)");
    let res;
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(timeoutSec * 1000),
      });
    } catch (e) {
      const why = e.name === "TimeoutError" ? `timed out after ${timeoutSec}s` : `unreachable: ${e.message}`;
      return bad(`${why} (${base})`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return bad(`HTTP ${res.status}${detail ? `: ${detail.trim().slice(0, 300)}` : ""}`);
    }
    let body;
    try {
      const json = await res.json();
      body = (json.choices?.[0]?.message?.content || "").trim();
    } catch (e) {
      return bad(`bad JSON: ${e.message}`);
    }
    return body ? { engine: "deepseek", ok: true, body } : bad("empty output");
  },

  grok({ prompt, cwd, timeoutSec }) {
    const args = [
      "--cwd",
      cwd,
      "--output-format",
      "plain",
      "--no-alt-screen",
      "--no-plan",
      "-p",
      prompt,
    ];
    return launch("grok", resolveGrok, args, cwd, timeoutSec);
  },
};

export const ENGINE_NAMES = Object.keys(ENGINES);
