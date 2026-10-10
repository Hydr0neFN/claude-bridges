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

// Defence in depth: a key must never reach a failure reason, an out-dir file or a log.
const NIM_KEY_RE = /nvapi-[A-Za-z0-9_-]+/g;

/** Mask NIM-style keys (and `secret`, if given) in text bound for user-visible output. */
export function redact(text, secret) {
  let out = String(text).replace(NIM_KEY_RE, "nvapi-***");
  if (secret) out = out.split(secret).join("***");
  return out;
}

const fail = (engine, reason) => ({ engine, ok: false, reason: redact(reason) });

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
    ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
  ];
}

export const DEFAULT_NIM_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const NIM_BASE = "https://integrate.api.nvidia.com";

/** NIM API base URL without a trailing slash. */
export const nimBase = (env = process.env) => (env.NIM_BASE || NIM_BASE).replace(/\/+$/, "");
const NIM_DEFAULT_KEY_FILE = ".nvidia-nim-key";
const RETRY_DEFAULT_MS = 5000;
const RETRY_CAP_MS = 15000;
const RETRY_MARGIN_MS = 5000;

export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultReadFile = (p) => fs.readFileSync(p, "utf8");

/** NIM key: NIM_API_KEY env, else the trimmed key file ("" when neither exists). Never logs it. */
export function resolveNimKey({ env = process.env, home = os.homedir(), readFile = defaultReadFile } = {}) {
  if (env.NIM_API_KEY) return env.NIM_API_KEY.trim();
  try {
    return readFile(env.NIM_KEY_PATH || path.join(home, NIM_DEFAULT_KEY_FILE)).trim();
  } catch {
    return "";
  }
}

/** Retry-After (numeric seconds) -> ms, else 5 s; always capped at 15 s. */
export function retryDelayMs(retryAfter) {
  const sec = /^\d+(\.\d+)?$/.test(String(retryAfter ?? "").trim()) ? Number(retryAfter) : null;
  return Math.min(sec === null ? RETRY_DEFAULT_MS : sec * 1000, RETRY_CAP_MS);
}

const LEADING_THINK = /^\s*<think>([\s\S]*?)<\/think>/;

/**
 * Split a leading <think> block from the answer. Only a block at the very start
 * counts: answers may legitimately quote the tags later, and must not be cut there.
 */
function splitThink(text) {
  const m = LEADING_THINK.exec(text);
  if (m) return { answer: text.slice(m[0].length).trim(), thoughts: m[1].trim() };
  // An unterminated <think> at the start means the model never left its reasoning.
  const t = text.trimStart();
  if (t.startsWith("<think>")) return { answer: "", thoughts: t.slice(7).trim() };
  return { answer: text.trim(), thoughts: "" };
}

/**
 * Pull the user-facing text out of a chat-completions JSON -> { ok, body, degraded? } | { ok: false, reason }.
 * `degraded` marks a reasoning-only reply: shown in panels, but not a real answer for fallback chains.
 */
export function extractAnswer(json) {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const finish = choice?.finish_reason;
  const { answer, thoughts } = splitThink(typeof msg.content === "string" ? msg.content : "");
  let body = answer;
  let degraded = false;
  if (!body) {
    const explicit = String(msg.reasoning_content || msg.reasoning || "").replace(/<\/?think>/g, "").trim();
    const reasoning = explicit || thoughts;
    if (reasoning) (degraded = true), (body = `[reasoning only: model returned no final answer]\n\n${reasoning}`);
  }
  if (!body) return { ok: false, reason: `empty output (finish_reason: ${finish ?? "unknown"})` };
  if (finish === "length") body += "\n\n[truncated: hit max_tokens]";
  return degraded ? { ok: true, body, degraded } : { ok: true, body };
}

/**
 * POST an OpenAI-compatible chat completion. -> { ok: true, json } | a failure result.
 * `retry429` retries once on HTTP 429 (honouring a numeric Retry-After, capped).
 */
async function chatCompletion({
  engine, base, key, model, prompt, timeoutSec, maxTokens, retry429 = false,
  fetchImpl = fetch, sleep = defaultSleep,
}) {
  const bad = (reason) => fail(engine, redact(reason, key));
  const deadline = Date.now() + timeoutSec * 1000;
  const post = () =>
    fetchImpl(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        stream: false,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      // One budget across the retry, so a 429 cannot double the wall time.
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
  let res;
  try {
    res = await post();
    if (res.status === 429 && retry429) {
      await res.text().catch(() => "");
      const delay = retryDelayMs(res.headers?.get("retry-after"));
      // Leave room for the second request; otherwise sleeping would only burn the timeout.
      if (delay >= deadline - Date.now() - RETRY_MARGIN_MS) {
        return bad("rate limited (HTTP 429, no time left to retry; key shares a ~40 RPM trial budget)");
      }
      await sleep(delay);
      res = await post();
      if (res.status === 429) {
        return bad("rate limited (HTTP 429, after 1 retry; key shares a ~40 RPM trial budget)");
      }
    }
  } catch (e) {
    const why = e.name === "TimeoutError" ? `timed out after ${timeoutSec}s` : `unreachable: ${e.message}`;
    return bad(`${why} (${base})`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return bad(`HTTP ${res.status}${detail ? `: ${redact(detail, key).trim().slice(0, 300)}` : ""}`);
  }
  try {
    return { ok: true, json: await res.json() };
  } catch (e) {
    return bad(`bad JSON: ${e.message}`);
  }
}

/** Shared tail of the HTTP engines: request, then extract the answer. */
async function askChat(args) {
  const r = await chatCompletion(args);
  if (!r.ok) return r;
  const a = extractAnswer(r.json);
  if (!a.ok) return fail(args.engine, a.reason);
  // A model may echo the key it was never given; mask it before it reaches stdout or --out-dir.
  return { engine: args.engine, ok: true, body: redact(a.body, args.key), ...(a.degraded && { degraded: true }) };
}

/** "engine" or "engine:model" (first colon only; model ids contain "/") -> { engine, model|null }. */
export function parseSpec(spec) {
  const s = String(spec).trim();
  const i = s.indexOf(":");
  if (i < 0) return { engine: s, model: null };
  return { engine: s.slice(0, i).trim(), model: s.slice(i + 1).trim() };
}

/** Engines that accept a per-call model, i.e. may appear as engine:model. */
export const MODEL_ENGINES = ["copilot", "codex", "nim", "deepseek"];

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

  // Paused since 2026-10-10 (Student re-verification pending): not in the default order; restore by adding it back there.
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

  async deepseek({ prompt, timeoutSec, model, fetchImpl, sleep }) {
    const creds = deepseekCreds();
    // A per-call model labels the result so several deepseek models stay distinguishable.
    const engine = model ? `deepseek:${model}` : "deepseek";
    if (!creds.key) return fail(engine, "no DEEPSEEKER_API_KEY (env or deeperseeker .env)");
    return askChat({
      engine, base: creds.base, key: creds.key, model: model || creds.model, prompt, timeoutSec, fetchImpl, sleep,
    });
  },

  // NVIDIA NIM hosted API (free trial key). Plain HTTP like deepseek: prompt text only.
  async nim({ prompt, timeoutSec, model, env = process.env, home, readFile, fetchImpl, sleep }) {
    model = model || env.NIM_MODEL || DEFAULT_NIM_MODEL;
    const engine = `nim:${model}`;
    const key = resolveNimKey({ env, home, readFile });
    if (!key) return fail(engine, "no NIM_API_KEY (env or ~/.nvidia-nim-key)");
    return askChat({
      engine,
      base: nimBase(env),
      key,
      model,
      prompt,
      timeoutSec,
      maxTokens: Number(env.NIM_MAX_TOKENS) > 0 ? Math.floor(Number(env.NIM_MAX_TOKENS)) : 8192,
      retry429: true,
      fetchImpl,
      sleep,
    });
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

/**
 * Run one order entry ("nim:a/b", "codex", ...). `base` = { prompt, cwd, timeoutSec };
 * `perEngine` = CLI-flag options keyed by engine. A model in the spec beats the flag.
 */
export async function runSpec(spec, base, perEngine = {}) {
  const { engine, model } = parseSpec(spec);
  if (!Object.hasOwn(ENGINES, engine)) return fail(spec, "unknown engine");
  return ENGINES[engine]({ ...base, ...perEngine[engine], ...(model ? { model } : {}) });
}
