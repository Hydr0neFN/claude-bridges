#!/usr/bin/env node

// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// src/config.ts
function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
function loadPerToolTimeouts(env) {
  const out = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_TIMEOUT_")) continue;
    const tool = key.slice("AGY_TIMEOUT_".length).toLowerCase();
    if (!tool) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out[tool] = n;
  }
  return out;
}
function loadConfig(env = process.env) {
  return {
    agyPath: env.AGY_PATH || "agy",
    timeoutSec: positiveInt(env.AGY_TIMEOUT, 1200),
    timeoutExplicit: positiveInt(env.AGY_TIMEOUT, 0) > 0,
    perToolTimeouts: loadPerToolTimeouts(env),
    maxOutputChars: positiveInt(env.AGY_MAX_OUTPUT_CHARS, 5e4),
    defaultModel: env.AGY_DEFAULT_MODEL || void 0,
    skipPermissions: env.AGY_SKIP_PERMISSIONS !== "false",
    sandbox: env.AGY_SANDBOX === "true",
    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback",
    retries: positiveInt(env.AGY_RETRIES, 2)
  };
}

// src/models.ts
// PATCH(agy-bridge-vendored, 2026-08-15): `agy models` now prints two tab-separated
// columns ("gemini-3.7-flash-high\tGemini 3.7 Flash (High)") plus a "Fetching available
// models..." header. Keeping the whole line made every canonicalize() lookup miss ->
// silent "no preferred model available" -> all delegations ran agy's own default.
// Keep only the first column and drop non-id lines.
function parseModels(output) {
  return output.split("\n").map((l) => l.trim().replace(/\s*\(current\)$/, "").split(/[\t ]+/)[0]).filter((l) => l.length > 0 && !l.endsWith("...") && /^[a-z0-9][a-z0-9.\-]*$/i.test(l));
}
// PATCH(agy-bridge-vendored): agy >=1.1.x lists models as slugs ("gemini-3.6-flash-high")
// while the bundled chains use display names ("Gemini 3.6 Flash (High)"). Exact-string
// matching silently dropped every chain entry -> "no preferred model available".
// Match on a normalized key instead, and always return the CLI's own canonical spelling.
function normModel(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}
function canonicalize(name, available) {
  const key = normModel(name);
  return available.find((a) => normModel(a) === key);
}
var ModelRegistry = class {
  constructor(fetchListing) {
    this.fetchListing = fetchListing;
  }
  fetchListing;
  listing = null;
  pending = null;
  async available() {
    if (this.listing) return this.listing;
    this.pending ??= this.fetchListing().then(parseModels).catch(() => null);
    const result = await this.pending;
    if (result) this.listing = result;
    else this.pending = null;
    return result;
  }
  async resolve(opts) {
    const r = await this.resolveChain(opts);
    return { model: r.models[0], note: r.note };
  }
  /**
   * Returns every viable model in preference order so callers can fail over
   * (e.g. on quota exhaustion). `[undefined]` means "let agy pick".
   */
  async resolveChain(opts) {
    const available = await this.available();
    if (opts.explicit) {
      if (available === null) {
        return {
          models: [opts.explicit],
          note: "could not list agy models; passing model through unvalidated"
        };
      }
      const explicitCanonical = canonicalize(opts.explicit, available);
      if (explicitCanonical) return { models: [explicitCanonical] };
      throw new Error(
        `Model "${opts.explicit}" is not available. Available models:
${available.join("\n")}`
      );
    }
    if (available === null) {
      return { models: [void 0], note: "could not list agy models; using agy's own default model" };
    }
    const chainModels = opts.chain.map((m) => canonicalize(m, available)).filter((m) => m !== void 0);
    const defaultCanonical = opts.defaultModel ? canonicalize(opts.defaultModel, available) : void 0;
    // PATCH-DEFAULT-FIRST-20260912: AGY_DEFAULT_MODEL is the operator's current-tier
    // choice; it must be tried BEFORE a hardcoded chain (e.g. ASYNC_CHAIN) that goes
    // stale whenever a new model tier ships. Previously the default was appended last,
    // so every no-explicit-model call silently ran the stale chain's first entry.
    const models = defaultCanonical ? [defaultCanonical, ...chainModels.filter((m) => m !== defaultCanonical)] : chainModels;
    if (models.length === 0) {
      return { models: [void 0], note: "no preferred model available; using agy's own default model" };
    }
    return { models };
  }
};

// src/runner.ts
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { readFile, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { randomUUID } from "crypto";
import path from "path";

// src/quota.ts
var DEFAULT_COOLDOWN_SEC = 15 * 60;
var QUOTA_RE = /RESOURCE_EXHAUSTED \(code 429\)/;
var RESET_RE = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/;
function parseResetDuration(text) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!m || !m[1] && !m[2] && !m[3]) return void 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  let out = "";
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (sec || !out) out += `${sec}s`;
  return out;
}
function detectQuota(log) {
  if (!QUOTA_RE.test(log)) return null;
  const reset = RESET_RE.exec(log)?.[1];
  const resetSeconds = reset ? parseResetDuration(reset) : void 0;
  return { resetText: resetSeconds !== void 0 ? reset : void 0, resetSeconds };
}
// PATCH-TRANSIENT-RETRY-20260830: agy's startup eligibility check hits Google endpoints and fails
// intermittently under parallel load. Those failures are retryable; a hard model/prompt
// error is not. Keep them apart so only the retryable ones burn a retry.
var TRANSIENT_RE = /eligibility check failed|failed to get profile picture|tls handshake timeout|net\/http|i\/o timeout|connection reset|connection refused|\bEOF\b|context canceled|context deadline exceeded|deadline exceeded|unavailable|temporarily unavailable|\b50[0234]\b|oauth2|token refresh|language server shutting down/i;
// PATCH-TOOLARG-RETRY-20260830: agy validates the model's own tool-call arguments against a
// protobuf schema (CortexStepRunCommand.wait_ms_before_async is a varint). When Gemini
// emits e.g. {"WaitMsBeforeAsync":"0"} the run dies with
//   invalid arguments: - at '/WaitMsBeforeAsync': got string, want integer
// That is a nondeterministic model-output defect, not a caller error, so it is worth a
// retry -- a resample almost always emits a well-formed call. Kept narrow on purpose:
// it must see BOTH "invalid arguments" and a JSON-pointer "at '/...'" so a genuine bad
// argument from the bridge is still a hard failure.
var TOOLARG_RE = /invalid arguments/i;
var TOOLARG_POINTER_RE = /at '\/[A-Za-z0-9_]+'/;
function isModelToolArgError(text) {
  return typeof text === "string" && TOOLARG_RE.test(text) && TOOLARG_POINTER_RE.test(text);
}
// PATCH-PRINTTIMEOUT-20260905: when agy's own --print-timeout (which the bridge sets from
// timeoutSec) expires, agy exits non-zero with the opaque stderr "timeout waiting for
// response". Echoed verbatim it looks like a network fault, so the real cause -- our own
// timeout budget being too small -- stayed invisible. Rewrite it to name the knob.
var PRINT_TIMEOUT_RE = /timeout waiting for response/i;
function describeFailure(detail, timeoutSec) {
  return PRINT_TIMEOUT_RE.test(detail) ? `agy hit its own --print-timeout of ${timeoutSec}s waiting for the model. Raise this tool's timeoutSec (or AGY_TIMEOUT) if the query legitimately needs longer.` : `agy failed: ${detail}`;
}
function isTransient(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return TRANSIENT_RE.test(text) || isModelToolArgError(text);
}
var TransientError = class extends Error {
  constructor(model, detail) {
    super(`agy transient failure on ${model ?? "agy's default model"}: ${detail}`);
    this.name = "TransientError";
    this.model = model;
    this.detail = detail;
  }
  model;
  detail;
};
var QuotaError = class extends Error {
  constructor(model, info) {
    const who = model ?? "agy's default model";
    const when = info.resetText ? ` Quota resets in ${info.resetText}.` : "";
    super(`Quota exhausted for ${who} (RESOURCE_EXHAUSTED 429).${when}`);
    this.model = model;
    this.name = "QuotaError";
    this.resetSeconds = info.resetSeconds;
    this.resetText = info.resetText;
  }
  model;
  resetSeconds;
  resetText;
};
var CooldownRegistry = class {
  constructor(now = Date.now) {
    this.now = now;
  }
  now;
  until = /* @__PURE__ */ new Map();
  set(model, resetSeconds) {
    this.until.set(model, this.now() + (resetSeconds ?? DEFAULT_COOLDOWN_SEC) * 1e3);
  }
  cooling(model) {
    const t = this.until.get(model);
    return t !== void 0 && t > this.now();
  }
  describe(model) {
    const t = this.until.get(model);
    return formatDuration(t === void 0 ? 0 : (t - this.now()) / 1e3);
  }
};

// src/runner.ts
var execFileAsync = promisify(execFile);
var SESSIONS_FILE = path.join(
  homedir(),
  ".gemini",
  "antigravity-cli",
  "cache",
  "last_conversations.json"
);
var execWithClosedStdin = (file, args, options) => {
  const promise = execFileAsync(file, args, { ...options, windowsHide: true });
  promise.child.stdin?.end();
  return promise;
};
var MAX_STDOUT_CHARS = 64 * 1024 * 1024;
var MAX_STDERR_CHARS = 1024 * 1024;
function spawnDetached(file, args, cwd, stdinData) {
  const child = spawn(file, args, { cwd, detached: process.platform !== "win32", windowsHide: true });
  if (stdinData !== void 0 && child.stdin) {
    child.stdin.on("error", () => {
    });
    child.stdin.write(`${stdinData}
`);
    child.stdin.end();
  } else {
    child.stdin?.end();
  }
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    if (out.length < MAX_STDOUT_CHARS) out += d.toString();
  });
  child.stderr?.on("data", (d) => {
    if (err.length < MAX_STDERR_CHARS) err += d.toString();
  });
  let exited = false;
  const done = new Promise((resolve) => {
    let exitCode = null;
    let closeFallback;
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      // PATCH-TRANSIENT-RETRY-20260830: a large stdout can still be draining when "exit" fires;
      // 2s truncated it into a spurious empty result. Wait longer for "close".
      closeFallback = setTimeout(() => resolve({ code: exitCode }), 15e3);
      closeFallback.unref();
    });
    child.on("close", (code) => {
      exited = true;
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code: code ?? exitCode });
    });
    child.on("error", (e) => {
      exited = true;
      resolve({ code: null, error: e });
    });
  });
  return {
    stdout: () => out,
    stderr: () => err,
    wait: () => done,
    kill: (signal) => {
      if (exited || child.pid === void 0) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
        }
      }
    }
  };
}
var defaultDeps = {
  spawnChild: spawnDetached,
  readLog: async (logPath) => {
    try {
      return await readFile(logPath, "utf8");
    } catch {
      return "";
    }
  },
  removeLog: (logPath) => rm(logPath, { force: true }),
  readSessionsFile: () => readFile(SESSIONS_FILE, "utf8"),
  makeLogPath: () => path.join(tmpdir(), `agy-bridge-${process.pid}-${randomUUID()}.log`)
};
function buildArgs(req, cfg, logPath) {
  const timeoutSec = req.timeoutSec ?? cfg.timeoutSec;
  const args = [];
  if (cfg.skipPermissions) args.push("--dangerously-skip-permissions");
  if (cfg.sandbox) args.push("--sandbox");
  args.push("--add-dir", req.cwd);
  args.push("--log-file", logPath);
  if (req.conversationId) args.push("--conversation", req.conversationId);
  if (req.model) args.push("--model", req.model);
  args.push(
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    `${timeoutSec}s`,
    "-p",
    ""
  );
  return args;
}
function buildStdin(prompt) {
  return JSON.stringify({
    event: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] }
  });
}
function parseStreamResult(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes('"result"')) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj?.event !== "result" || !obj.result) continue;
    const r = obj.result;
    return {
      parsed: true,
      response: typeof r.response === "string" ? r.response : "",
      status: r.status,
      error: r.error || void 0,
      conversationId: r.conversation_id || void 0,
      usage: r.usage || void 0,
      durationSeconds: r.duration_seconds
    };
  }
  return { parsed: false, response: stdout };
}
function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}

[agy-bridge: output truncated at ${max} chars; full length was ${text.length} chars. Ask a narrower question or raise AGY_MAX_OUTPUT_CHARS.]`,
    truncated: true
  };
}
function describeRun(result) {
  const bits = [];
  const u = result.usage;
  if (u && (u.input_tokens || u.output_tokens)) {
    let t = `tokens: ${u.input_tokens ?? 0} in / ${u.output_tokens ?? 0} out`;
    if (u.cache_read_tokens) t += `, ${u.cache_read_tokens} cached`;
    bits.push(t);
  }
  if (typeof result.durationSeconds === "number" && result.durationSeconds > 0) {
    bits.push(`took: ${result.durationSeconds.toFixed(1)}s`);
  }
  return bits;
}
async function runAgy(req, cfg, deps = defaultDeps) {
  const timeoutSec = req.timeoutSec ?? cfg.timeoutSec;
  const pollMs = deps.pollMs ?? 1e3;
  const graceMs = deps.graceMs ?? 15e3;
  const killGraceMs = deps.killGraceMs ?? 5e3;
  const logPath = deps.makeLogPath();
  const stdout = await new Promise((resolve, reject) => {
    const child = deps.spawnChild(
      cfg.agyPath,
      buildArgs(req, cfg, logPath),
      req.cwd,
      buildStdin(req.prompt)
    );
    let settled = false;
    let polling = false;
    const timers = [];
    const killChild = () => {
      child.kill("SIGTERM");
      const escalate = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      escalate.unref?.();
    };
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      for (const t of timers) clearTimeout(t);
      req.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const poller = setInterval(async () => {
      if (polling || settled) return;
      polling = true;
      try {
        const log = await deps.readLog(logPath);
        if (settled) return;
        const quota = detectQuota(log);
        if (quota) {
          killChild();
          finish(() => reject(new QuotaError(req.model, quota)));
        }
      } finally {
        polling = false;
      }
    }, pollMs);
    timers.push(
      setTimeout(() => {
        killChild();
        finish(
          () => reject(new Error(`agy timed out after ${timeoutSec}s (AGY_TIMEOUT to adjust).`))
        );
      }, timeoutSec * 1e3 + graceMs)
    );
    const onAbort = () => {
      killChild();
      finish(() => reject(new Error("agy run cancelled by client.")));
    };
    if (req.signal?.aborted) {
      onAbort();
      return;
    }
    req.signal?.addEventListener("abort", onAbort, { once: true });
    void child.wait().then(async ({ code, error }) => {
      if (settled) return;
      if (error?.code === "ENOENT") {
        finish(
          () => reject(
            new Error(
              `agy CLI not found at "${cfg.agyPath}". Install the Antigravity CLI (https://antigravity.google/docs/cli-getting-started) or set AGY_PATH.`
            )
          )
        );
        return;
      }
      if (error) {
        finish(() => reject(new Error(`agy failed: ${error.message}`)));
        return;
      }
      const parsed = parseStreamResult(child.stdout());
      const out = (parsed.response || "").trim();
      if (parsed.parsed && parsed.status === "ERROR") {
        const detail = parsed.error || "agy reported an error with no detail.";
        const quota = detectQuota(detail) ?? detectQuota(await deps.readLog(logPath));
        finish(
          () => reject(
            quota ? new QuotaError(req.model, quota) : isTransient(detail) ? new TransientError(req.model, detail) : new Error(describeFailure(detail, timeoutSec))
          )
        );
        return;
      }
      if (code !== 0) {
        const stderr = child.stderr().trim();
        finish(
          () => reject(
            isTransient(stderr) ? new TransientError(req.model, stderr) : new Error(stderr ? describeFailure(stderr, timeoutSec) : `agy exited with code ${code}.`)
          )
        );
        return;
      }
      if (!out) {
        const quota = detectQuota(await deps.readLog(logPath));
        finish(
          () => reject(
            quota ? new QuotaError(req.model, quota) : new TransientError(
              req.model,
              "agy returned empty output (no result line on stdout)"
            )
          )
        );
        return;
      }
      finish(() => resolve({ out, meta: parsed }));
    });
  }).finally(() => void deps.removeLog(logPath).catch(() => {
  }));
  const { text, truncated } = truncate(stdout.out, cfg.maxOutputChars);
  let sessionId = stdout.meta.conversationId;
  if (!sessionId) {
    try {
      const map = JSON.parse(await deps.readSessionsFile());
      sessionId = map[path.resolve(req.cwd)];
    } catch {
      sessionId = void 0;
    }
  }
  return {
    output: text,
    truncated,
    sessionId,
    usage: stdout.meta.usage,
    durationSeconds: stdout.meta.durationSeconds
  };
}

// src/tools.ts
import path2 from "path";
import { z } from "zod";
var OUTPUT_RULES = "Answer directly with no preamble or closing remarks. Be thorough but concise. Cite file:line for every code-level finding.";
function resolveFiles(files, cwd) {
  return files.map((f) => path2.isAbsolute(f) ? f : path2.resolve(cwd, f));
}
var commonShape = {
  cwd: z.string().optional().describe("Absolute path to the working directory / project root. Defaults to the server's cwd."),
  model: z.string().optional().describe(
    "Override the model (exact name from `agy models`, e.g. \"gemini-3.7-flash-high\", \"gemini-3.1-pro-high\"). Normally omit \u2014 the tool routes automatically."
  )
};
var TOOLS = [
  {
    name: "analyze_files",
    description: "Delegate file analysis to the Antigravity CLI (Gemini) instead of reading files yourself. USE THIS whenever a file is large (>200 lines) or the task spans more than 3 files: logs, database dumps, generated code, cross-file reviews, comparisons. The files never enter your context \u2014 only the answer does.",
    schema: {
      files: z.array(z.string()).min(1).describe("File paths to analyze (relative to cwd or absolute)."),
      question: z.string().describe("What you want to know about these files."),
      ...commonShape
    },
    chain: ["gemini-3.8-flash-high", "gemini-3.7-flash-high"],
    timeoutSec: 300,
    buildPrompt(args, cwd) {
      const files = resolveFiles(args.files, cwd);
      return `Read and analyze these files:
${files.map((f) => `- ${f}`).join("\n")}

Question: ${args.question}

${OUTPUT_RULES}`;
    }
  },
  {
    name: "deep_search",
    description: "Delegate codebase archaeology to the Antigravity CLI: git log/diff/blame spelunking, wide greps across a repo, 'when/why did X change', 'where is Y used'. USE THIS instead of running many search commands yourself \u2014 it saves your context.",
    schema: {
      query: z.string().describe("What to find, e.g. 'when was the auth middleware refactored and why'."),
      ...commonShape
    },
    chain: ["gemini-3.8-flash-medium", "gemini-3.7-flash-medium", "gemini-3.7-flash-high"],
    timeoutSec: 180,
    buildPrompt(args) {
      return `Search this repository to answer the following. Use git log, git diff, git blame, and grep as needed.

Query: ${args.query}

Report findings with commit hashes where relevant. ${OUTPUT_RULES}`;
    }
  },
  {
    name: "web_lookup",
    description: "Delegate a web/documentation lookup to the Antigravity CLI (Gemini with web access): library docs, API references, error messages, current versions, external knowledge. USE THIS when you need information you don't have or that may be newer than your training data.",
    schema: {
      query: z.string().describe("What to look up on the web."),
      ...commonShape
    },
    chain: ["gemini-3.8-flash-medium", "gemini-3.7-flash-medium", "gemini-3.7-flash-high"],
    // PATCH-WEBLOOKUP-TIMEOUT-20260905: was 120 -- the lowest of any tool, and it is passed
    // straight to agy as --print-timeout. A grounded lookup that fetches several pages
    // routinely runs past 2min, so agy self-aborted with "timeout waiting for response"
    // on most real queries. 300 matches agy's own --print-timeout default (5m).
    timeoutSec: 300,
    buildPrompt(args) {
      return `Look up on the web: ${args.query}

Include source URLs for key claims. ${OUTPUT_RULES}`;
    }
  },
  {
    name: "adversarial_review",
    description: "Get an adversarial second opinion from a different model family (Gemini Pro). ALWAYS use this for plan critiques, design reviews, and pre-merge code review: it hunts for flaws, edge cases, security issues, and unstated assumptions you may have missed.",
    schema: {
      content: z.string().optional().describe("Inline content to review (plan, diff, code snippet)."),
      files: z.array(z.string()).optional().describe("File paths to review instead of inline content."),
      focus: z.string().optional().describe("Optional focus area, e.g. 'security', 'concurrency'."),
      ...commonShape
    },
    chain: ["gemini-3.8-flash-high", "gemini-3.7-flash-high", "claude-opus-4-6-thinking"],  // ROUTING-20260830: flash-high measured level with pro on adversarial review and 2.1x faster
    timeoutSec: 300,
    buildPrompt(args, cwd) {
      const files = args.files;
      const content = args.content;
      if (!content && !files?.length) {
        throw new Error("adversarial_review requires either `content` or `files`.");
      }
      const subject = content ? `Review the following:

${content}` : `Read and review these files:
${resolveFiles(files, cwd).map((f) => `- ${f}`).join("\n")}`;
      const focus = args.focus ? `
Focus especially on: ${args.focus}.` : "";
      return `You are an adversarial reviewer. Find real flaws: bugs, edge cases, security issues, performance traps, unstated assumptions, and simpler alternatives.${focus}

${subject}

Rank findings by severity (critical/major/minor) and justify each. Do not pad with praise or restate the input. ${OUTPUT_RULES}`;
    }
  },
  {
    name: "follow_up",
    description: "Continue a previous Antigravity session by session_id (returned by every other tool). USE THIS for follow-up questions about a prior delegation \u2014 the full prior context is already on agy's side, so you don't resend anything.",
    schema: {
      session_id: z.string().describe("The session id returned by a previous agy-bridge call."),
      question: z.string().describe("The follow-up question."),
      ...commonShape
    },
    chain: [],
    timeoutSec: 300,
    buildPrompt(args) {
      return args.question;
    }
  },
  {
    name: "delegate",
    description: "Raw delegation to the Antigravity CLI for heavy tasks that don't fit the other tools. agy has full tool access (shell, file reads, web) in the given cwd.",
    schema: {
      prompt: z.string().describe("The complete task prompt for agy."),
      ...commonShape
    },
    chain: ["gemini-3.8-flash-high", "gemini-3.7-flash-high"],
    timeoutSec: 600,
    buildPrompt(args) {
      return args.prompt;
    }
  }
];

// src/jobs.ts (local patch - background job store)
import { mkdir, writeFile, readdir } from "fs/promises";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

var SELF_PATH = fileURLToPath(import.meta.url);
var JOBS_ROOT = path.join(homedir(), ".claude-bridges", "agy-jobs");
var JOB_LIMIT = 50;
var FINISHED = ["done", "error", "cancelled"];
var ASYNC_CHAIN = ["gemini-3.8-flash-high", "gemini-3.7-flash-high"];
function workspaceDir(cwd) {
  return path.join(JOBS_ROOT, createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12));
}
function jobPath(cwd, id) {
  return path.join(workspaceDir(cwd), `${id}.json`);
}
async function writeJob(job) {
  await mkdir(workspaceDir(job.cwd), { recursive: true });
  await writeFile(jobPath(job.cwd, job.id), JSON.stringify(job, null, 2), "utf8");
  return job;
}
async function readJob(cwd, id) {
  try {
    return JSON.parse(await readFile(jobPath(cwd, id), "utf8"));
  } catch {
    return void 0;
  }
}
async function listJobs(cwd) {
  let names;
  try {
    names = await readdir(workspaceDir(cwd));
  } catch {
    return [];
  }
  const jobs = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const j = await readJob(cwd, n.slice(0, -5));
    if (j) jobs.push(j);
  }
  return jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
async function reapJob(job) {
  if (!job || job.status !== "running" || pidAlive(job.pid)) return job;
  job.status = "error";
  job.error = "worker process died before producing a result.";
  job.finishedAt = Date.now();
  return writeJob(job);
}
async function evictJobs(cwd) {
  const jobs = await listJobs(cwd);
  if (jobs.length <= JOB_LIMIT) return;
  const excess = jobs.length - JOB_LIMIT;
  const finished = jobs.filter((j) => FINISHED.includes(j.status));
  for (const j of finished.slice(-excess)) {
    await rm(jobPath(cwd, j.id), { force: true }).catch(() => {
    });
  }
}
function summarizeJob(job) {
  const end = job.finishedAt ?? Date.now();
  const bits = [`${job.id}  ${job.status}`, `age: ${formatDuration((end - job.createdAt) / 1e3)}`];
  if (job.model) bits.push(`model: ${job.model}`);
  if (job.error) bits.push(`error: ${job.error}`);
  return bits.join(" | ");
}
function killJob(job) {
  if (!job.pid) return;
  if (process.platform === "win32") {
    const taskkill = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "taskkill.exe"
    );
    try {
      const tk = spawn(taskkill, ["/PID", String(job.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      tk.on("error", () => {
        try {
          process.kill(job.pid, "SIGTERM");
        } catch {
        }
      });
      tk.unref();
      return;
    } catch {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch {
      }
      return;
    }
  }
  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
    }
  }
}
async function startJob(args, cfg) {
  const cwd = args.cwd ?? process.cwd();
  const job = {
    id: randomUUID().slice(0, 8),
    tool: "delegate_async",
    prompt: args.prompt,
    cwd,
    model: args.model,
    timeoutSec: cfg.perToolTimeouts["delegate_async"] ?? cfg.perToolTimeouts["delegate"] ?? (cfg.timeoutExplicit ? cfg.timeoutSec : 600),
    status: "queued",
    createdAt: Date.now()
  };
  await writeJob(job);
  await evictJobs(cwd);
  const child = spawn(process.execPath, [SELF_PATH, "--job-worker", jobPath(cwd, job.id)], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  job.pid = child.pid;
  job.status = "running";
  job.startedAt = Date.now();
  return writeJob(job);
}
async function runJobWorker(jobFile) {
  const cfg = loadConfig();
  let job;
  try {
    job = JSON.parse(await readFile(jobFile, "utf8"));
  } catch {
    process.exit(1);
  }
  const registry = new ModelRegistry(async () => {
    const { stdout } = await execWithClosedStdin(cfg.agyPath, ["models"], {
      cwd: job.cwd,
      timeout: 3e4,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  });
  const patch = {};
  try {
    const { result, used, attempts, note } = await runWithFailover(
      {
        prompt: job.prompt,
        cwd: job.cwd,
        model: job.model,
        chain: ASYNC_CHAIN,
        timeoutSec: job.timeoutSec
      },
      cfg,
      registry,
      new CooldownRegistry()
    );
    patch.status = "done";
    patch.output = result.output;
    patch.truncated = result.truncated;
    patch.sessionId = result.sessionId;
    patch.usage = result.usage;
    patch.durationSeconds = result.durationSeconds;
    patch.model = used;
    patch.attempts = attempts;
    patch.note = note;
  } catch (err) {
    patch.status = "error";
    patch.error = err?.message ?? String(err);
  }
  patch.finishedAt = Date.now();
  try {
    const cur = JSON.parse(await readFile(jobFile, "utf8"));
    if (cur.status === "cancelled") process.exit(0);
    await writeFile(jobFile, JSON.stringify({ ...cur, ...patch }, null, 2), "utf8");
  } catch {
  }
  process.exit(patch.status === "done" ? 0 : 1);
}
var JOB_TOOLS = [
  {
    name: "delegate_async",
    description: "Start a delegation to the Antigravity CLI (Gemini) in the BACKGROUND and return a job id immediately, instead of blocking. USE THIS for heavy work you do not need the answer to right now: whole-repo audits, long refactor investigations, batch analysis. Keep working, then collect with job_result. For anything you need answered within the current turn, use delegate instead.",
    schema: {
      prompt: { required: true, desc: "The complete task prompt for agy." },
      cwd: { desc: "Absolute path to the working directory / project root. Defaults to the server's cwd." },
      model: { desc: "Override the model (exact name from `agy models`). Normally omit - the job routes automatically." }
    }
  },
  {
    name: "job_status",
    description: "Check background agy jobs started with delegate_async. Omit job_id to list every job for this working directory. Does not return output - use job_result for that.",
    schema: {
      job_id: { desc: "Job id to check. Omit to list all jobs for this cwd." },
      cwd: { desc: "Working directory the job belongs to. Defaults to the server's cwd." }
    }
  },
  {
    name: "job_result",
    description: "Retrieve the output of a finished background agy job. Errors if the job is still running - poll job_status first.",
    schema: {
      job_id: { required: true, desc: "Job id returned by delegate_async." },
      cwd: { desc: "Working directory the job belongs to. Defaults to the server's cwd." }
    }
  },
  {
    name: "job_cancel",
    description: "Cancel a running background agy job and kill its worker process.",
    schema: {
      job_id: { required: true, desc: "Job id returned by delegate_async." },
      cwd: { desc: "Working directory the job belongs to. Defaults to the server's cwd." }
    }
  }
];
function jobSchema(shape) {
  const out = {};
  for (const [k, v] of Object.entries(shape)) {
    out[k] = v.required ? z.string().describe(v.desc) : z.string().optional().describe(v.desc);
  }
  return out;
}
function jobText(text, isError) {
  return { content: [{ type: "text", text }], isError: isError || void 0 };
}
function createJobHandler(name, cfg) {
  return async (args) => {
    const cwd = args.cwd ?? process.cwd();
    try {
      if (name === "delegate_async") {
        const job = await startJob({ ...args, cwd }, cfg);
        return jobText(
          `[agy-bridge] background job started.\njob_id: ${job.id}\nCollect it later with job_result({ job_id: "${job.id}" }); check progress with job_status.`
        );
      }
      if (name === "job_status") {
        if (!args.job_id) {
          const jobs = await listJobs(cwd);
          if (!jobs.length) return jobText("[agy-bridge] no background jobs for this working directory.");
          for (const j of jobs) await reapJob(j);
          return jobText(jobs.map(summarizeJob).join("\n"));
        }
        const one = await readJob(cwd, args.job_id);
        if (!one) return jobText(`[agy-bridge] no such job: ${args.job_id}`, true);
        await reapJob(one);
        return jobText(summarizeJob(one));
      }
      const job = await readJob(cwd, args.job_id);
      if (!job) return jobText(`[agy-bridge] no such job: ${args.job_id}`, true);
      if (name === "job_cancel") {
        if (FINISHED.includes(job.status)) return jobText(`[agy-bridge] job ${job.id} already ${job.status}.`);
        killJob(job);
        job.status = "cancelled";
        job.finishedAt = Date.now();
        await writeJob(job);
        return jobText(`[agy-bridge] job ${job.id} cancelled.`);
      }
      await reapJob(job);
      if (!FINISHED.includes(job.status)) {
        return jobText(`[agy-bridge] job ${job.id} is still ${job.status}. Poll job_status and try again.`, true);
      }
      if (job.status !== "done") {
        return jobText(`[agy-bridge] job ${job.id} ${job.status}: ${job.error ?? "no output."}`, true);
      }
      const { text } = truncate(job.output ?? "", cfg.maxOutputChars);
      const meta = [`model: ${job.model ?? "agy default"}`];
      if (job.note) meta.push(`note: ${job.note}`);
      meta.push(...describeRun(job));
      if (job.attempts?.length) meta.push(`failover: ${job.attempts.join("; ")}`);
      if (job.sessionId) meta.push(`session: ${job.sessionId} (use follow_up to continue)`);
      return jobText(`${text}\n\n---\n[agy-bridge job ${job.id}] ${meta.join(" | ")}`);
    } catch (err) {
      return jobText(`[agy-bridge] ${name} failed: ${err?.message ?? err}`, true);
    }
  };
}

// src/server.ts
async function runWithFailover(req, cfg, registry, cooldowns, deps = defaultDeps) {
  const resolution = req.conversationId ? { models: [void 0], note: void 0 } : await registry.resolveChain({
    explicit: req.model,
    chain: req.chain,
    defaultModel: cfg.defaultModel
  });
  const attempts = [];
  let result;
  let used;
  for (const model of resolution.models) {
    if (model && cooldowns.cooling(model)) {
      attempts.push(`${model}: quota cooldown, ${cooldowns.describe(model)} left`);
      continue;
    }
    // PATCH-TRANSIENT-RETRY-20260830: retry the same model on a transient failure before moving
    // down the chain. Previously any non-quota error was rethrown on the first attempt.
    const maxRetries = cfg.retries ?? 2;
    let advanceToNextModel = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        result = await runAgy(
          {
            prompt: req.prompt,
            cwd: req.cwd,
            model,
            conversationId: req.conversationId,
            timeoutSec: req.timeoutSec,
            signal: req.signal
          },
          cfg,
          deps
        );
        used = model;
        break;
      } catch (err) {
        if (err instanceof QuotaError && model) {
          cooldowns.set(model, err.resetSeconds);
          attempts.push(
            `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`
          );
          advanceToNextModel = true;
          break;
        }
        if (err instanceof TransientError) {
          const label = model ?? "agy default";
          if (attempt < maxRetries) {
            attempts.push(`${label}: transient (${err.detail}) - retrying ${attempt + 1}/${maxRetries}`);
            await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
            continue;
          }
          attempts.push(`${label}: transient after ${maxRetries + 1} attempts (${err.detail})`);
          advanceToNextModel = true;
          break;
        }
        throw err;
      }
    }
    if (result) break;
    if (advanceToNextModel) continue;
  }
  if (!result) {
    throw new Error(
      `agy produced no result. Attempts:
${attempts.map((a) => `- ${a}`).join("\n")}
Retry after the quota resets, or pass an explicit \`model\`.`
    );
  }
  return { result, used, attempts, note: resolution.note };
}
function createToolHandler(tool, cfg, registry, deps = defaultDeps, cooldowns = new CooldownRegistry()) {
  return async (args, extra) => {
    try {
      const cwd = args.cwd ?? process.cwd();
      const timeoutSec = cfg.perToolTimeouts[tool.name] ?? (cfg.timeoutExplicit ? cfg.timeoutSec : tool.timeoutSec);
      const { result, used, attempts, note: resolutionNote } = await runWithFailover(
        {
          prompt: tool.buildPrompt(args, cwd),
          cwd,
          model: args.model,
          chain: tool.chain,
          conversationId: args.session_id,
          timeoutSec,
          signal: extra?.signal
        },
        cfg,
        registry,
        cooldowns,
        deps
      );
      const resolution = { note: resolutionNote };
      const meta = [`model: ${used ?? "agy default"}`];
      if (resolution.note) meta.push(`note: ${resolution.note}`);
      meta.push(...describeRun(result));
      if (attempts.length) meta.push(`failover: ${attempts.join("; ")}`);
      if (result.sessionId) meta.push(`session: ${result.sessionId} (use follow_up to continue)`);
      return {
        content: [{ type: "text", text: `${result.output}

---
[agy-bridge] ${meta.join(" | ")}` }]
      };
    } catch (err) {
      let text = err.message;
      if (cfg.onFailure === "strict") {
        text += "\n\n[agy-bridge strict mode] Delegation failed. Do NOT perform this work yourself in the main context \u2014 report the failure to the user and let them decide how to proceed.";
      }
      return {
        content: [{ type: "text", text }],
        isError: true
      };
    }
  };
}
function createServer() {
  const cfg = loadConfig();
  const registry = new ModelRegistry(async () => {
    const { stdout } = await execWithClosedStdin(cfg.agyPath, ["models"], {
      cwd: process.cwd(),
      timeout: 3e4,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  });
  const cooldowns = new CooldownRegistry();
  const server = new McpServer({ name: "agy-bridge", version: "0.4.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, registry, defaultDeps, cooldowns)
    );
  }
  for (const tool of JOB_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: jobSchema(tool.schema) },
      createJobHandler(tool.name, cfg)
    );
  }
  return server;
}

// src/index.ts
if (process.argv[2] === "--job-worker") {
  runJobWorker(process.argv[3]).catch((err) => {
    console.error("agy-bridge job worker failed:", err);
    process.exit(1);
  });
} else {
  createServer().connect(new StdioServerTransport()).catch((err) => {
    console.error("agy-bridge failed to start:", err);
    process.exit(1);
  });
}
