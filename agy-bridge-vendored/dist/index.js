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
    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback"
  };
}

// src/models.ts
function parseModels(output) {
  return output.split("\n").map((l) => l.trim().replace(/\s*\(current\)$/, "")).filter((l) => l.length > 0);
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
      if (available.includes(opts.explicit)) return { models: [opts.explicit] };
      throw new Error(
        `Model "${opts.explicit}" is not available. Available models:
${available.join("\n")}`
      );
    }
    if (available === null) {
      return { models: [void 0], note: "could not list agy models; using agy's own default model" };
    }
    const models = opts.chain.filter((m) => available.includes(m));
    if (opts.defaultModel && available.includes(opts.defaultModel) && !models.includes(opts.defaultModel)) {
      models.push(opts.defaultModel);
    }
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
  const promise = execFileAsync(file, args, options);
  promise.child.stdin?.end();
  return promise;
};
var MAX_STDOUT_CHARS = 64 * 1024 * 1024;
var MAX_STDERR_CHARS = 1024 * 1024;
function spawnDetached(file, args, cwd) {
  const child = spawn(file, args, { cwd, detached: process.platform !== "win32", windowsHide: true });
  child.stdin?.end();
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
      closeFallback = setTimeout(() => resolve({ code: exitCode }), 2e3);
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
  args.push("--print-timeout", `${timeoutSec}s`, "-p", req.prompt);
  return args;
}
function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}

[agy-bridge: output truncated at ${max} chars; full length was ${text.length} chars. Ask a narrower question or raise AGY_MAX_OUTPUT_CHARS.]`,
    truncated: true
  };
}
async function runAgy(req, cfg, deps = defaultDeps) {
  const timeoutSec = req.timeoutSec ?? cfg.timeoutSec;
  const pollMs = deps.pollMs ?? 1e3;
  const graceMs = deps.graceMs ?? 15e3;
  const killGraceMs = deps.killGraceMs ?? 5e3;
  const logPath = deps.makeLogPath();
  const stdout = await new Promise((resolve, reject) => {
    const child = deps.spawnChild(cfg.agyPath, buildArgs(req, cfg, logPath), req.cwd);
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
      const out = child.stdout().trim();
      if (code !== 0) {
        const stderr = child.stderr().trim();
        finish(
          () => reject(new Error(stderr ? `agy failed: ${stderr}` : `agy exited with code ${code}.`))
        );
        return;
      }
      if (!out) {
        const quota = detectQuota(await deps.readLog(logPath));
        finish(
          () => reject(
            quota ? new QuotaError(req.model, quota) : new Error(
              "agy returned empty output (likely hit its print-timeout without a response)."
            )
          )
        );
        return;
      }
      finish(() => resolve(out));
    });
  }).finally(() => void deps.removeLog(logPath).catch(() => {
  }));
  const { text, truncated } = truncate(stdout, cfg.maxOutputChars);
  let sessionId;
  try {
    const map = JSON.parse(await deps.readSessionsFile());
    sessionId = map[path.resolve(req.cwd)];
  } catch {
    sessionId = void 0;
  }
  return { output: text, truncated, sessionId };
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
    'Override the model (exact name from `agy models`, e.g. "Gemini 3.1 Pro (High)"). Normally omit \u2014 the tool routes automatically.'
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
    chain: ["Gemini 3.5 Flash (High)", "Gemini 3.1 Pro (Low)"],
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
    chain: ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
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
    chain: ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 120,
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
    chain: ["Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)", "Gemini 3.5 Flash (High)"],
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
    chain: ["Gemini 3.5 Flash (High)"],
    timeoutSec: 600,
    buildPrompt(args) {
      return args.prompt;
    }
  }
];

// src/server.ts
function createToolHandler(tool, cfg, registry, deps = defaultDeps, cooldowns = new CooldownRegistry()) {
  return async (args, extra) => {
    try {
      const cwd = args.cwd ?? process.cwd();
      const conversationId = args.session_id;
      const prompt = tool.buildPrompt(args, cwd);
      const timeoutSec = cfg.perToolTimeouts[tool.name] ?? (cfg.timeoutExplicit ? cfg.timeoutSec : tool.timeoutSec);
      const resolution = conversationId ? { models: [void 0], note: void 0 } : await registry.resolveChain({
        explicit: args.model,
        chain: tool.chain,
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
        try {
          result = await runAgy(
            { prompt, cwd, model, conversationId, timeoutSec, signal: extra?.signal },
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
            continue;
          }
          throw err;
        }
      }
      if (!result) {
        throw new Error(
          `All candidate models are quota-exhausted or cooling down:
${attempts.map((a) => `- ${a}`).join("\n")}
Retry after the quota resets, or pass an explicit \`model\`.`
        );
      }
      const meta = [`model: ${used ?? "agy default"}`];
      if (resolution.note) meta.push(`note: ${resolution.note}`);
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
  return server;
}

// src/index.ts
createServer().connect(new StdioServerTransport()).catch((err) => {
  console.error("agy-bridge failed to start:", err);
  process.exit(1);
});
