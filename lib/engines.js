// Engine runners used by consult-bridge and consult-cli. Binary resolution is
// shared with the legacy solo bridges through lib/common.js. Every engine
// resolves to { engine, ok, body } or { engine, ok: false, reason }.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { runCli, resolveCopilot, resolveCodex, resolveAgy, resolveGrok, resolveOpenCode, NotInstalledError } from "./common.js";

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
const OPENROUTER_KEY_RE = /sk-or-[A-Za-z0-9_-]+/g;
// Classic keys are AIza + 35 chars; newer AI Studio keys are AQ. + a token (seen 2026-11-06).
const GEMINI_KEY_RE = /AIza[0-9A-Za-z_-]{35}|AQ\.[A-Za-z0-9_-]{20,}/g;

// DeepSeek keys are sk- plus 32 alphanumerics; sk-or- (OpenRouter) is masked first and never matches this.
const DEEPSEEK_KEY_RE = /sk-[A-Za-z0-9]{24,}/g;

/** Mask NIM-, OpenRouter-, Gemini- and DeepSeek-style keys (and `secret`, if given) in text bound for user-visible output. */
export function redact(text, secret) {
  let out = String(text).replace(NIM_KEY_RE, "nvapi-***").replace(OPENROUTER_KEY_RE, "sk-or-***").replace(GEMINI_KEY_RE, (k) => (k.startsWith("AQ.") ? "AQ.***" : "AIza***")).replace(DEEPSEEK_KEY_RE, "sk-***");
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

export function copilotArgs({ prompt, cwd, model, effort, promptFile }) {
  return [
    "-p", promptText(prompt, promptFile), "-C", cwd, ...COPILOT_PERM_ARGS,
    ...(promptFile ? ["--add-dir", path.dirname(promptFile)] : []),
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--reasoning-effort", effort] : []),
  ];
}

export function codexArgs({ prompt, cwd, outFile, model, effort, promptFile }) {
  return [
    "exec", promptText(prompt, promptFile), "-C", cwd, "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-o", outFile,
    ...(model ? ["-m", model] : []),
    ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
  ];
}

// CLI engines get the prompt as an argument, and a Windows command line caps near 32K chars
// (spawn ENAMETOOLONG; agy has no stdin text mode either). A longer prompt is written once to a
// temp file that every engine of the run shares, and each engine is told to read it.
/** Longest prompt passed to a CLI engine as an argument. */
export const ARGV_PROMPT_MAX = 24000;

const spilled = new Map(); // prompt -> { file, refs }

/** Path of the shared file for a long prompt (written on first use), or null for a short one. */
export function acquirePromptFile(prompt) {
  if (prompt.length <= ARGV_PROMPT_MAX) return null;
  let entry = spilled.get(prompt);
  if (!entry) {
    const file = path.join(os.tmpdir(), `consult-prompt-${process.pid}-${randomUUID()}.md`);
    fs.writeFileSync(file, prompt, "utf8");
    entry = { file, refs: 0 };
    spilled.set(prompt, entry);
  }
  entry.refs++;
  return entry.file;
}

/** Drop one use of a long prompt's file; the last user removes it. */
export function releasePromptFile(prompt) {
  const entry = spilled.get(prompt);
  if (!entry || --entry.refs > 0) return;
  spilled.delete(prompt);
  try {
    fs.rmSync(entry.file, { force: true });
  } catch {
    /* best effort */
  }
}

/** The argument an engine gets: the prompt itself, or a pointer to its file. */
export function promptText(prompt, promptFile) {
  return promptFile
    ? `Your full task is in the file ${promptFile}. Read the whole file first, then respond to it exactly as if its contents were this message. Do not create, modify or delete any files.`
    : prompt;
}

async function withPromptFile(engine, prompt, run) {
  let promptFile;
  try {
    promptFile = acquirePromptFile(prompt);
  } catch (e) {
    return fail(engine, `cannot write prompt file: ${e.message}`);
  }
  try {
    return await run(promptFile);
  } finally {
    if (promptFile) releasePromptFile(prompt);
  }
}

/** Same invocation shape agy-bridge uses (skip-permissions + print-timeout). */
export function agyArgs({ prompt, cwd, timeoutSec, promptFile }) {
  const text = promptText(prompt, promptFile);
  return [
    "--dangerously-skip-permissions",
    "--add-dir",
    cwd,
    ...(promptFile ? ["--add-dir", path.dirname(promptFile)] : []),
    "--print-timeout",
    `${timeoutSec}s`,
    "-p",
    text,
  ];
}

export const DEFAULT_NIM_MODEL ="nvidia/nemotron-3-ultra-550b-a55b";
const NIM_BASE = "https://integrate.api.nvidia.com";

/** NIM API base URL without a trailing slash. */
export const nimBase = (env = process.env) => (env.NIM_BASE || NIM_BASE).replace(/\/+$/, "");
const NIM_DEFAULT_KEY_FILE = ".nvidia-nim-key";
const RETRY_DEFAULT_MS = 5000;
const RETRY_CAP_MS = 15000;
const RETRY_MARGIN_MS = 5000;
export const NIM_TIMEOUT_MAX_SEC = 600;
// Fallback chain of the nim engine (best quality-per-latency first; the eval is in README § nim). Left out on
// purpose: models that never return a final answer within the cap or answer weakly (see README).
// Family rule: no model family (vendor prefix / name stem) may also appear in OPENROUTER_CHAIN, so one panel
// never carries the same model twice (test/chains.test.js holds the two lists apart).
export const NIM_CHAIN = [
  DEFAULT_NIM_MODEL,
  "minimaxai/minimax-m3.1-flash",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "z-ai/glm-5.3-flash",
  "openai/gpt-oss-20b",
];
export const NIM_MAX_ATTEMPTS = 5;
// One chain step may use at most this long; 5 x 120 s fills the 600 s NIM cap exactly.
export const NIM_ATTEMPT_TIMEOUT_SEC = 120;
// A step with less than this left is not started (it could not even finish a 429 retry).
const NIM_MIN_ATTEMPT_SEC = 15;

/** The chain: NIM_CHAIN env (comma list of model ids) else the built-in NIM_CHAIN. */
export function nimChain(env = process.env) {
  const own = (env.NIM_CHAIN || "").split(",").map((m) => m.trim()).filter(Boolean);
  return own.length ? own : NIM_CHAIN;
}

/** Models one chained call tries, in order: the requested one first, then the rest of `chain`; at most `max`. */
const chainModels = (model, chain, max) => [model, ...chain.filter((m) => m !== model)].slice(0, max);

/** Models one chained nim call tries: the requested one first, then the rest of the chain; at most 5. */
export const nimModels = (model, env = process.env) => chainModels(model, nimChain(env), NIM_MAX_ATTEMPTS);

/**
 * NIM timeout in seconds: NIM_TIMEOUT (positive number) else 600, never above 600.
 * Independent of CONSULT_TIMEOUT: a slow model may wait, the panel runs engines in parallel anyway.
 */
export function nimTimeoutSec(env = process.env) {
  const n = Number(env.NIM_TIMEOUT);
  return n > 0 && Number.isFinite(n) ? Math.min(n, NIM_TIMEOUT_MAX_SEC) : NIM_TIMEOUT_MAX_SEC;
}

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

// Default is a different family from nim's default (nemotron-3-ultra), so the panel counts two distinct voices.
export const DEFAULT_OPENROUTER_MODEL = "poolside/laguna-s-2.1:free";
// ORDER RULE: most capable first, weakest last. Planted-bug review 2026-11-06: laguna and dots-3 answered 4/4;
// north-mini-code and flint-v1.0 returned "empty output (reasoning only)" (moved after dots-3); lfm-2.5-2.6b (2.6B) is
// the weakest and was rate-limited (429), so it stays last.
// Free-tier fallback chain, first = default. No family may also appear in NIM_CHAIN (so no nvidia/nemotron, minimax,
// z-ai, openai here). Left out on purpose: thinkingmachines/inkling[-small]:free (403, agentic harnesses only),
// google/gemma-4-*:free and xingchen-agi/xing4.0:free (rate-limited upstream on every call of the 2026-10-27 probe).
export const OPENROUTER_CHAIN = [
  DEFAULT_OPENROUTER_MODEL,
  "dots-studio/dots-3-note-preview:free",
  "cohere/north-mini-code:free",
  "recursive/flint-v1.0:free",
  "liquid/lfm-2.5-2.6b:free",
];
const OPENROUTER_BASE = "https://openrouter.ai/api";
const OPENROUTER_DEFAULT_KEY_FILE = ".openrouter-key";
const OPENROUTER_CREDIT_FILE = path.join(os.homedir(), ".cache", "or-credit.json");
const OPENROUTER_CREDIT_TTL_SEC = 300;
const OPENROUTER_CREDIT_STALE_SEC = 3600;
export const OPENROUTER_MAX_ATTEMPTS = 5;
// One chain step may use at most this long (the free models answered in 4-21 s on 2026-10-27); 5 x 60 s = the
// default whole-chain budget.
export const OPENROUTER_ATTEMPT_TIMEOUT_SEC = 60;
export const OPENROUTER_TIMEOUT_MAX_SEC = 600;
const OPENROUTER_DEFAULT_TIMEOUT_SEC = OPENROUTER_MAX_ATTEMPTS * OPENROUTER_ATTEMPT_TIMEOUT_SEC;
const OPENROUTER_TOKEN_RE = /sk-or-[A-Za-z0-9_-]+/;

/** OpenRouter key: OPENROUTER_API_KEY env, else the first sk-or-... token of the key file ("" when neither). Never logs it. */
export function resolveOpenRouterKey({ env = process.env, home = os.homedir(), readFile = defaultReadFile } = {}) {
  if (env.OPENROUTER_API_KEY?.trim()) return env.OPENROUTER_API_KEY.trim();
  try {
    return readFile(env.OPENROUTER_KEY_PATH || path.join(home, OPENROUTER_DEFAULT_KEY_FILE)).match(OPENROUTER_TOKEN_RE)?.[0] ?? "";
  } catch {
    return "";
  }
}

/** The chain: OPENROUTER_CHAIN env (comma list of model ids) else the built-in OPENROUTER_CHAIN. */
export function openRouterChain(env = process.env) {
  const own = (env.OPENROUTER_CHAIN || "").split(",").map((m) => m.trim()).filter(Boolean);
  return own.length ? own : OPENROUTER_CHAIN;
}

/** Models one chained openrouter call tries: the requested one first, then the rest of the chain; at most 5. */
export const openRouterModels = (model, env = process.env) => chainModels(model, openRouterChain(env), OPENROUTER_MAX_ATTEMPTS);

/** Whole-chain openrouter budget in seconds: OPENROUTER_TIMEOUT (positive number) else 300, never above 600. */
export function openRouterTimeoutSec(env = process.env) {
  const n = Number(env.OPENROUTER_TIMEOUT);
  return n > 0 && Number.isFinite(n) ? Math.min(n, OPENROUTER_TIMEOUT_MAX_SEC) : OPENROUTER_DEFAULT_TIMEOUT_SEC;
}

const creditNow = (now) => {
  const v = typeof now === "function" ? now() : now;
  const ms = Number.isFinite(v) ? v : Date.now();
  return ms > 1e12 ? Math.floor(ms / 1000) : ms;
};

/** The credit cache { ts, credit } from `cacheFile`, or null when missing or broken. */
function readOrCredit(cacheFile) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    return Number.isFinite(j?.ts) && Number.isFinite(j?.credit) ? j : null;
  } catch {
    return null;
  }
}

/** Store the credit cache (best effort: a read-only home must never fail a consult). */
function writeOrCredit(cacheFile, ts, credit) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify({ ts, credit })}\n`);
  } catch {
    /* best effort */
  }
}

/**
 * OpenRouter credit in USD (total_credits - total_usage), cached for 300 s in `cacheFile`.
 * A fresh cache is returned without a request; on a fetch error a cached value younger than
 * 1 h is used, else null. Never logs the key. `now` is a unix-seconds number or function.
 */
export async function openRouterCredit({ key, fetchImpl = fetch, now, cacheFile = OPENROUTER_CREDIT_FILE } = {}) {
  const ts = creditNow(now);
  const cached = readOrCredit(cacheFile);
  if (cached && ts - cached.ts < OPENROUTER_CREDIT_TTL_SEC) return cached.credit;
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json())?.data ?? {};
    const credit = Number(data.total_credits) - Number(data.total_usage);
    if (!Number.isFinite(credit)) throw new Error("bad credits response");
    writeOrCredit(cacheFile, ts, credit);
    return credit;
  } catch {
    return cached && ts - cached.ts < OPENROUTER_CREDIT_STALE_SEC ? cached.credit : null;
  }
}

// OpenCode CLI (official `opencode`, logged in to OpenCode Zen) on its FREE models. A CLI agent, so every call runs in a
// fresh empty temp dir with the read-only `plan` agent (never --auto), the prompt on stdin, and `--format json` output.
// Family rule: no deepseek / nemotron free model here (they collide with the deepseek and nim engines); model ids are
// bare names, run as opencode/<name>.
export const DEFAULT_OPENCODE_MODEL = "beam-free";
// Family rule (as for NIM_CHAIN / OPENROUTER_CHAIN): one panel never asks the same model twice. The first three models
// (the primary part) share no family with nim, openrouter or deepseek. The last two are RESERVE models: they ARE in the
// chain, but a reserve model is skipped while its owner engine is active in the same panel run (see reserveBlocked), and
// it runs when that provider is unavailable (owner not in the order, no key, or already finished without that family).
// Left out for good: deepseek-v4.1-flash-free (deepseek engine), nemotron-*-free (nim). OPENCODE_FAMILY maps each name
// to its canonical vendor/model id (test/chains.test.js).
// ORDER RULE (owner, 2026-11-06): every multi-model chain lists the most capable model first, so the weakest runs last
// as the final fallback. Opencode evidence (planted-bug review, all five found 4/4): beam-free (501B-A23B) is the most
// precise; big-pickle the most thorough; mimo and glm are mid; flint (2.5B active) is last (one doubtful finding, chatter).
export const OPENCODE_PRIMARY = [DEFAULT_OPENCODE_MODEL, "big-pickle", "mimo-v2.6-flash-free"];
export const OPENCODE_RESERVE = {
  "glm-5.3-flash-free": { owner: "nim", stem: "glm" },
  "flint-40b-free": { owner: "openrouter", stem: "flint" },
};
export const OPENCODE_CHAIN = [...OPENCODE_PRIMARY, ...Object.keys(OPENCODE_RESERVE)];
export const OPENCODE_FAMILY = {
  "beam-free": "reflection/beam-1.0-501b-a23b",
  "mimo-v2.6-flash-free": "xiaomi/mimo-v2.6-flash",
  "big-pickle": "opencode/big-pickle",
  "glm-5.3-flash-free": "z-ai/glm-5.3-flash",
  "flint-40b-free": "recursive/flint",
};
export const OPENCODE_MAX_ATTEMPTS = 5;
// A free-model answer took ~4 s on 2026-11-06; one chain step may use at most this long.
export const OPENCODE_ATTEMPT_TIMEOUT_SEC = 90;
export const OPENCODE_TIMEOUT_MAX_SEC = 600;
const OPENCODE_DEFAULT_TIMEOUT_SEC = 300;

/** The chain: OPENCODE_CHAIN env (comma list of model names) else the built-in OPENCODE_CHAIN. */
export function opencodeChain(env = process.env) {
  const own = (env.OPENCODE_CHAIN || "").split(",").map((m) => m.trim()).filter(Boolean);
  return own.length ? own : OPENCODE_CHAIN;
}

/** Models one chained opencode call tries: the requested one first, then the rest of the chain; at most 5. */
export const opencodeModels = (model, env = process.env) => chainModels(model, opencodeChain(env), OPENCODE_MAX_ATTEMPTS);

/**
 * True while a reserve model's owner engine is active in this panel run, so the same family would run twice at once.
 * `panel` = { order: ["nim", ...spec names], ran: [results so far] } from consult-cli; without it nothing is blocked.
 * The owner counts as unavailable (reserve allowed) when it is not in the order, has no key, or already finished
 * without that family in its label.
 */
export function reserveBlocked(model, panel, { env = process.env, home, readFile } = {}) {
  const r = OPENCODE_RESERVE[model];
  if (!r || !panel) return false;
  const inOrder = (panel.order ?? []).some((sp) => parseSpec(sp).engine === r.owner);
  if (!inOrder) return false;
  const key = r.owner === "nim" ? resolveNimKey({ env, home, readFile }) : resolveOpenRouterKey({ env, home, readFile });
  if (!key) return false;
  const done = (panel.ran ?? []).find((x) => String(x.engine ?? "").startsWith(`${r.owner}:`) || x.engine === r.owner);
  if (!done) return true; // owner still running (or not started): avoid
  return Boolean(done.ok) && String(done.engine).toLowerCase().includes(r.stem);
}

/** Whole-chain opencode budget in seconds: OPENCODE_TIMEOUT (positive number) else 300, never above 600. */
export function opencodeTimeoutSec(env = process.env) {
  const n = Number(env.OPENCODE_TIMEOUT);
  return n > 0 && Number.isFinite(n) ? Math.min(n, OPENCODE_TIMEOUT_MAX_SEC) : OPENCODE_DEFAULT_TIMEOUT_SEC;
}

export function opencodeArgs(model) {
  return ["run", "-m", model.includes("/") ? model : `opencode/${model}`, "--agent", "plan", "--format", "json"];
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OPENCODE_HEADER_RE = /^> (?:build|plan) · .*$/gm;
const OPENCODE_QUOTA_RE = /free usage limit|FreeUsageLimitError/i;
const OPENCODE_AUTH_RE = /unauthori[sz]ed|forbidden|\b40[13]\b|invalid[^.\n]{0,20}(api )?key|not logged in|log ?in required|authenticat/i;

/** `opencode run --format json` stdout -> { text, errors }: the `part.text` of "text" lines; "error" lines' messages. */
export function parseOpenCodeJson(stdout) {
  let text = "";
  const errors = [];
  let lines = 0;
  for (const line of stdout.split(/\r?\n/)) {
    let j;
    try {
      j = JSON.parse(line.replace(ANSI_RE, ""));
    } catch {
      continue;
    }
    if (!j || typeof j !== "object") continue;
    lines++;
    if (j.type === "text" && typeof j.part?.text === "string") text += j.part.text;
    else if (j.type === "error") errors.push(JSON.stringify(j.error ?? j).slice(0, 300));
  }
  // No JSON at all (older CLI / default format): the plain text minus ANSI codes and the "> build · model" header.
  if (!lines) text = stdout.replace(ANSI_RE, "").replace(OPENCODE_HEADER_RE, "");
  return { text: text.trim(), errors };
}

/** One opencode run on one model -> { ok: true, body } | { ok: false, reason, next } (`next`: try the following model). */
async function opencodeAttempt({ model, prompt, timeoutSec, resolve }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consult-opencode-"));
  try {
    const { cmd, pre } = resolve();
    const res = await runCli({ cmd, args: [...pre, ...opencodeArgs(model)], cwd: dir, timeoutSec, input: prompt });
    if (res.timedOut) return { ok: false, reason: `timed out after ${timeoutSec}s`, next: true };
    const { text, errors } = parseOpenCodeJson(res.stdout);
    if (res.code === 0 && text) return { ok: true, body: text };
    const detail = [...errors, res.stderr.replace(ANSI_RE, "").trim().slice(-400)].filter(Boolean).join(" | ");
    if (OPENCODE_QUOTA_RE.test(`${detail}\n${res.stdout}`)) return { ok: false, reason: "free usage limit reached (FreeUsageLimitError)", next: true };
    if (OPENCODE_AUTH_RE.test(detail)) return { ok: false, reason: `auth error: ${detail.slice(0, 300)}`, next: false };
    if (res.code !== 0) return { ok: false, reason: `exit ${res.code}${detail ? `: ${detail.slice(0, 300)}` : ""}`, next: true };
    return { ok: false, reason: `empty output${detail ? `: ${detail.slice(0, 300)}` : ""}`, next: true };
  } catch (e) {
    const f = launchFailure("opencode", e);
    return { ok: false, reason: f.reason, next: false }; // not installed / cannot launch: no model will fare better
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// Google Gemini API through its OpenAI-compatible endpoint. Plain HTTP like nim: prompt text only.
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const GEMINI_CHAIN = [DEFAULT_GEMINI_MODEL, "gemini-3.6-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_DEFAULT_KEY_FILE = ".gemini-api-key";
export const GEMINI_MAX_ATTEMPTS = GEMINI_CHAIN.length;
// One chain step may use at most this long; 4 x 90 s = the default whole-chain budget.
export const GEMINI_ATTEMPT_TIMEOUT_SEC = 90;
export const GEMINI_TIMEOUT_MAX_SEC = 600;
const GEMINI_DEFAULT_TIMEOUT_SEC = 360;
const GEMINI_TOKEN_RE = /AIza[0-9A-Za-z_-]{35}|AQ\.[A-Za-z0-9_-]{20,}/;

/** Gemini API base URL without a trailing slash (GEMINI_BASE overrides). */
export const geminiBase = (env = process.env) => (env.GEMINI_BASE || GEMINI_BASE).replace(/\/+$/, "");

/** Gemini key: GEMINI_API_KEY env, else the first AIza... or AQ.... token of the key file ("" when neither). Never logs it. */
export function resolveGeminiKey({ env = process.env, home = os.homedir(), readFile = defaultReadFile } = {}) {
  if (env.GEMINI_API_KEY?.trim()) return env.GEMINI_API_KEY.trim();
  try {
    return readFile(env.GEMINI_KEY_PATH || path.join(home, GEMINI_DEFAULT_KEY_FILE)).match(GEMINI_TOKEN_RE)?.[0] ?? "";
  } catch {
    return "";
  }
}

/** The chain: GEMINI_CHAIN env (comma list of model ids) else the built-in GEMINI_CHAIN. */
export function geminiChain(env = process.env) {
  const own = (env.GEMINI_CHAIN || "").split(",").map((m) => m.trim()).filter(Boolean);
  return own.length ? own : GEMINI_CHAIN;
}

/** Models one chained gemini call tries: the requested one first, then the rest of the chain; at most 4. */
export const geminiModels = (model, env = process.env) => chainModels(model, geminiChain(env), GEMINI_MAX_ATTEMPTS);

/** Whole-chain gemini budget in seconds: GEMINI_TIMEOUT (positive number) else 360, never above 600. */
export function geminiTimeoutSec(env = process.env) {
  const n = Number(env.GEMINI_TIMEOUT);
  return n > 0 && Number.isFinite(n) ? Math.min(n, GEMINI_TIMEOUT_MAX_SEC) : GEMINI_DEFAULT_TIMEOUT_SEC;
}

// Azure OpenAI (v1 chat completions API). Plain HTTP like nim: prompt text only. Opt-in (not in the default order);
// one model per call, no fallback chain. The gpt-5 family rejects temperature and max_tokens, so the body is minimal.
export const DEFAULT_AZURE_MODEL = "gpt-5-mini";
export const AZURE_TIMEOUT_MAX_SEC = 600;
const AZURE_DEFAULT_TIMEOUT_SEC = 300;
const AZURE_DEFAULT_MAX_TOKENS = 16000;
const AZURE_KEY_FILE = ".azure-openai-key";
const AZURE_ENDPOINT_FILE = ".azure-openai-endpoint";

/** First line, trimmed, of env var `name` else of ~/`file` ("" when neither). Never throws. */
function azureValue(name, file, { env, home, readFile }) {
  if (env[name]?.trim()) return env[name].trim();
  try {
    return readFile(path.join(home, file)).split(/\r?\n/)[0].trim();
  } catch {
    return "";
  }
}

/** Azure endpoint without trailing slashes: AZURE_OPENAI_ENDPOINT env, else ~/.azure-openai-endpoint ("" when neither). */
export const azureBase = ({ env = process.env, home = os.homedir(), readFile = defaultReadFile } = {}) =>
  azureValue("AZURE_OPENAI_ENDPOINT", AZURE_ENDPOINT_FILE, { env, home, readFile }).replace(/\/+$/, "");

/** Azure key: AZURE_OPENAI_KEY env, else ~/.azure-openai-key ("" when neither). Never logs it. */
export const resolveAzureKey = ({ env = process.env, home = os.homedir(), readFile = defaultReadFile } = {}) =>
  azureValue("AZURE_OPENAI_KEY", AZURE_KEY_FILE, { env, home, readFile });

/** The model: explicit/flag model, else AZURE_OPENAI_MODEL, else the default. */
export const azureModel = (model, env = process.env) => model || env.AZURE_OPENAI_MODEL || DEFAULT_AZURE_MODEL;

/** max_completion_tokens: AZURE_MAX_TOKENS (positive integer) else 16000. */
export function azureMaxTokens(env = process.env) {
  const n = Number(env.AZURE_MAX_TOKENS);
  return Number.isInteger(n) && n > 0 ? n : AZURE_DEFAULT_MAX_TOKENS;
}

/** Azure budget in seconds: AZURE_TIMEOUT (positive number) else 300, never above 600. */
export function azureTimeoutSec(env = process.env) {
  const n = Number(env.AZURE_TIMEOUT);
  return n > 0 && Number.isFinite(n) ? Math.min(n, AZURE_TIMEOUT_MAX_SEC) : AZURE_DEFAULT_TIMEOUT_SEC;
}

/** One Azure chat completion -> { engine: "azure:<model>", ok: true, body } | a failure result. The key is stripped from every reason. */
// Minimal fetch-like POST over node:https with agent:false (connection closes after the reply).
// Azure keeps the global fetch's keep-alive socket open; process.exit() then trips a libuv
// assertion on Windows (UV_HANDLE_CLOSING, exit 127). Only what azureAsk uses is implemented.
export function closingFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers };
    if (body != null) hdrs["Content-Length"] = Buffer.byteLength(body);
    const req = https.request(url, { method, headers: hdrs, agent: false, signal }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (n) => res.headers[String(n).toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on("error", (e) => reject(signal?.aborted && signal.reason ? signal.reason : e));
    req.end(body);
  });
}

async function azureAsk({ base, model, key, prompt, timeoutSec, maxTokens, fetchImpl = closingFetch }) {
  const engine = `azure:${model}`;
  const bad = (reason) => fail(engine, String(reason).split(key).join("***"));
  let res;
  try {
    res = await fetchImpl(`${base}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_completion_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
  } catch (e) {
    const why = e.name === "TimeoutError" ? `timed out after ${timeoutSec}s` : undiciReason(e) || `unreachable: ${e.message}`;
    return bad(`${why} (${base})`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // A Retry-After on a 429 goes into the reason so the lock logic (parseLimit) can read it.
    const retry = res.status === 429 && res.headers?.get("retry-after") ? ` | Retry-After: ${res.headers.get("retry-after")}` : "";
    return bad(`HTTP ${res.status}${detail ? `: ${detail.trim().slice(0, 300)}` : ""}${retry}`);
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return bad(e.name === "TimeoutError" ? `timed out after ${timeoutSec}s` : `bad JSON: ${e.message}`);
  }
  if (json?.error) return bad(`error: ${json.error.message ?? JSON.stringify(json.error)}`);
  const content = json?.choices?.[0]?.message?.content;
  const body = typeof content === "string" ? content.trim() : "";
  if (!body) return bad("empty content (reasoning models can spend the whole max_completion_tokens budget on reasoning; raise AZURE_MAX_TOKENS)");
  return { engine, ok: true, body: body.split(key).join("***") };
}

// Official DeepSeek API (api.deepseek.com), pay-per-token. Limited to Flash models. DeepSeek renames
// model ids over time, so the gate is a pattern, not a fixed list: an id must contain a `flash` token and must
// not contain `pro` or `reasoner` (so deepseek-flash, v4.1flash, deepseek-v6-flash pass; deepseek-v4-pro,
// deepseek-reasoner, deepseek-chat and deepseek-flash-pro do not). Checked right before any request is built.
// Default: `deepseek-flash`, the alias DeepSeek keeps pointed at its current Flash model (verified via GET /models).
export const DEFAULT_DSAPI_MODEL = "deepseek-flash";
const DSAPI_BASE = "https://api.deepseek.com";
const DSAPI_DEFAULT_KEY_FILE = ".deepseek-api-key";
const DSAPI_USAGE_FILE = ".dsapi-usage.json";
export const DSAPI_TIMEOUT_SEC = 90;
export const DSAPI_SOFT_ALARM_REQUESTS = 300; // requests/day; a warning footer only, never a stop
const DSAPI_TOKEN_RE = /sk-[A-Za-z0-9_-]+/;

// 2026-10-28 (owner): DS calls go to OpenRouter's paid credit first, the official API second. Same rule as
// ~/.claude/bin/ds-keyproxy.py: pinned flash model, data_collection deny, 401/402/403 from OpenRouter (bad key,
// credit gone) is sticky for this process, 429/5xx/network only fall through for that one request.
// DS_UPSTREAM=deepseek forces the official API. Without an OpenRouter key nothing changes.
export const DSAPI_OR_MODEL = "deepseek/deepseek-v4.1-flash";
const DSAPI_OR_TIMEOUT_SEC = 40;
const dsOrState = { off: false };
/** Test hook: forget a sticky OpenRouter failure. */
export const resetDsOpenRouterState = () => void (dsOrState.off = false);

// :free pool (1000 requests/day per account, shared by the panel and the agent flows): callers stop using :free models
// at remaining <= OR_FREE_RESERVE. Default 50 for agent flows, 200 for hosted test runs; the panel passes its own
// default (0: it is what the reserve protects, so no lookup at all, a 429 steps the chain on; set OR_FREE_RESERVE to apply one).
export const OR_FREE_RESERVE_DEFAULT = 50;
const orFreeCache = { at: 0, remaining: null };
/** Remaining :free requests today from GET /api/v1/key (cached 60 s); null when unknown (no key, error). Never throws. */
export async function openRouterFreeRemaining({ key, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!key) return null;
  if (orFreeCache.remaining !== null && now - orFreeCache.at < 60000) return orFreeCache.remaining;
  try {
    const res = await fetchImpl(`${OPENROUTER_BASE}/v1/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const n = (await res.json())?.data?.free_model_daily_requests?.remaining;
    if (!Number.isFinite(n)) return null;
    Object.assign(orFreeCache, { at: now, remaining: n });
    return n;
  } catch {
    return null;
  }
}
/** The reserve: OR_FREE_RESERVE env (>= 0 integer) else the caller's default. */
export function orFreeReserve(env = process.env, dflt = OR_FREE_RESERVE_DEFAULT) {
  const v = env.OR_FREE_RESERVE;
  return v !== undefined && /^\d+$/.test(String(v).trim()) ? Number(v) : dflt;
}
/** Test hook: forget the cached remaining count. */
export const resetOrFreeCache = () => void Object.assign(orFreeCache, { at: 0, remaining: null });

const DSAPI_FLASH_RE = /(^|[-_.:/])[a-z0-9.]*flash/i;
const DSAPI_FORBIDDEN_RE = /pro|reasoner/i;

/** True for a plausible model id that names a Flash model and nothing bigger; everything else is refused. */
export const isDsapiModel = (model) =>
  typeof model === "string" && /^[A-Za-z0-9._:/-]+$/.test(model) && DSAPI_FLASH_RE.test(model) && !DSAPI_FORBIDDEN_RE.test(model);

/** DeepSeek key: DEEPSEEK_API_KEY env, else the first sk-... token of the key file ("" when neither). Never logs it. */
export function resolveDsapiKey({ env = process.env, home = os.homedir(), readFile = defaultReadFile } = {}) {
  if (env.DEEPSEEK_API_KEY?.trim()) return env.DEEPSEEK_API_KEY.trim();
  try {
    return readFile(env.DSAPI_KEY_PATH || path.join(home, DSAPI_DEFAULT_KEY_FILE)).match(DSAPI_TOKEN_RE)?.[0] ?? "";
  } catch {
    return "";
  }
}

const localDay = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Today's counter ({ day, requests, promptTokens, completionTokens }); zeros for a missing, stale or broken file. */
export function readDsapiUsage({ home = os.homedir(), readFile = defaultReadFile, now = Date.now() } = {}) {
  const day = localDay(now);
  try {
    const j = JSON.parse(readFile(path.join(home, DSAPI_USAGE_FILE)));
    if (j?.day === day) {
      const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
      return { day, requests: n(j.requests), promptTokens: n(j.promptTokens), completionTokens: n(j.completionTokens) };
    }
  } catch {
    /* no counter yet */
  }
  return { day, requests: 0, promptTokens: 0, completionTokens: 0 };
}

/** Add to today's counter (best effort: a failing disk must never fail a consult). -> the new totals. */
export function bumpDsapiUsage({ requests = 0, promptTokens = 0, completionTokens = 0 }, { home = os.homedir(), now = Date.now(), readFile, writeFile } = {}) {
  const u = readDsapiUsage({ home, now, ...(readFile && { readFile }) });
  u.requests += requests;
  u.promptTokens += promptTokens;
  u.completionTokens += completionTokens;
  try {
    (writeFile || ((p, t) => fs.writeFileSync(p, t)))(path.join(home, DSAPI_USAGE_FILE), `${JSON.stringify(u)}\n`);
  } catch {
    /* best effort */
  }
  return u;
}

/** One-line soft-alarm footer once today's requests pass the threshold, else null. */
export function dsapiUsageNotice(opts = {}) {
  const u = readDsapiUsage(opts);
  if (u.requests <= DSAPI_SOFT_ALARM_REQUESTS) return null;
  return `[consult] dsapi: ${u.requests} requests today (soft alarm at ${DSAPI_SOFT_ALARM_REQUESTS}), ${u.promptTokens + u.completionTokens} tokens (${u.promptTokens} prompt + ${u.completionTokens} completion); flash is cheap, but check the account`;
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

/** Apply one dispatched SSE event payload to `st` ({ content, reasoning, finish, error, done }). */
function applyEventData(st, data) {
  if (data.trim() === "[DONE]") return (st.done = true);
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return false;
  }
  if (json?.error) st.error = json.error.message || JSON.stringify(json.error);
  const choice = json?.choices?.[0];
  if (!choice) return false;
  const delta = choice.delta ?? {};
  if (typeof delta.content === "string") st.content += delta.content;
  const reasoning = delta.reasoning_content || delta.reasoning;
  if (typeof reasoning === "string") st.reasoning += reasoning;
  if (choice.finish_reason) st.finish = choice.finish_reason;
  return false;
}

/**
 * Feed one SSE line (terminator already removed). `ev.data` collects the event's `data:` values
 * (one optional space after the colon is stripped); a blank line dispatches them joined by "\n".
 * Comments (`:`) and other fields (`event:`, `id:`, `retry:`) are ignored. -> true once [DONE] was seen.
 */
function feedSseLine(st, ev, line) {
  if (line === "") {
    if (!ev.data.length) return false;
    const data = ev.data.join("\n");
    ev.data = [];
    return applyEventData(st, data);
  }
  if (line.startsWith(":")) return false;
  const colon = line.indexOf(":");
  const field = colon < 0 ? line : line.slice(0, colon);
  if (field === "data") ev.data.push(colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, ""));
  return false;
}

const SSE_LINE_END = /\r\n|\n|\r/;

/** Split complete lines off `buf` (CRLF, LF or lone CR). A CR at the very end waits for a possible LF unless `final`. */
function takeSseLines(buf, final) {
  const lines = [];
  let m;
  while ((m = SSE_LINE_END.exec(buf))) {
    if (m[0] === "\r" && m.index + 1 === buf.length && !final) break;
    lines.push(buf.slice(0, m.index));
    buf = buf.slice(m.index + m[0].length);
  }
  if (final && buf) (lines.push(buf), (buf = ""));
  return { lines, rest: buf };
}

/** Read an SSE body into `st` (mutated as chunks arrive, so a mid-stream abort keeps the partial text). */
async function readSse(body, st) {
  const decoder = new TextDecoder();
  const ev = { data: [] };
  let buf = "";
  const feed = (final) => {
    const { lines, rest } = takeSseLines(buf, final);
    buf = rest;
    return lines.some((line) => feedSseLine(st, ev, line)); // stops at [DONE]
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    if (feed(false)) return; // leaving the loop cancels the body
  }
  buf += decoder.decode();
  if (feed(true)) return;
  feedSseLine(st, ev, ""); // EOF dispatches an event the server never terminated with a blank line
}

/** Streamed state -> the chat-completions shape extractAnswer reads. */
const streamedJson = (st) => ({
  choices: [{ message: { content: st.content, reasoning_content: st.reasoning }, finish_reason: st.finish }],
});

/** Release a response body we will not read, so its socket is not held until the deadline. */
const drain = (res) => void res.body?.cancel?.()?.catch?.(() => {});

// Two independent ~300 s limits apply: NVIDIA's gateway answers a real HTTP 504 when no response has started,
// and Node's fetch (undici) aborts after 300 s without headers (UND_ERR_HEADERS_TIMEOUT) or without a body
// chunk (UND_ERR_BODY_TIMEOUT, idle time between chunks, not total). Streaming keeps both quiet once the
// model has started answering.
const UNDICI_REASONS = {
  UND_ERR_HEADERS_TIMEOUT: "no response headers within ~300 s (client limit; the model did not start answering)",
  UND_ERR_BODY_TIMEOUT: "stream stalled, no data for ~300 s (client limit)",
};
const undiciReason = (e) => UNDICI_REASONS[e?.cause?.code] || UNDICI_REASONS[e?.code] || null;

/**
 * POST an OpenAI-compatible chat completion. -> { ok: true, json, note? } | a failure result.
 * `retry429` retries once on HTTP 429 (honouring a numeric Retry-After, capped).
 * `stream` requests SSE and rebuilds the completion from the deltas; if the reply is not
 * text/event-stream it is parsed as an ordinary completion. A stream cut off after some text
 * returns that text plus a `note`. `gateway` explains 502/504 as NVIDIA's ~300 s first-byte limit.
 */
async function chatCompletion({
  engine, base, key, model, prompt, timeoutSec, maxTokens, retry429 = false, stream = false, gateway = false,
  urlPath = "/v1/chat/completions", headers = {}, extraBody = {}, fetchImpl = fetch, sleep = defaultSleep,
}) {
  const bad = (reason) => fail(engine, redact(reason, key));
  const deadline = Date.now() + timeoutSec * 1000;
  const post = () =>
    fetchImpl(`${base}${urlPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...(stream ? { Accept: "text/event-stream" } : {}),
        ...headers,
      },
      body: JSON.stringify({
        model,
        stream,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        messages: [{ role: "user", content: prompt }],
        ...extraBody,
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
        drain(res);
        return bad("rate limited (HTTP 429, after 1 retry; key shares a ~40 RPM trial budget)");
      }
    }
  } catch (e) {
    const why = e.name === "TimeoutError" ? `timed out after ${timeoutSec}s` : undiciReason(e) || `unreachable: ${e.message}`;
    return bad(`${why} (${base})`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 504 = NVIDIA's gateway gave up waiting for the first byte (~300 s); 502 is a generic gateway error.
    if (gateway && res.status === 504) {
      return bad("NVIDIA gateway timeout (HTTP 504: the model did not start answering within ~300 s; free-tier queue stalled, try another model)");
    }
    if (gateway && res.status === 502) {
      return bad(`NVIDIA gateway error (HTTP 502)${detail ? `: ${redact(detail, key).trim().slice(0, 300)}` : ""}`);
    }
    return bad(`HTTP ${res.status}${detail ? `: ${redact(detail, key).trim().slice(0, 300)}` : ""}`);
  }
  if (stream && /text\/event-stream/i.test(res.headers?.get("content-type") || "")) {
    const st = { content: "", reasoning: "", finish: undefined, error: null, done: false };
    try {
      await readSse(res.body, st);
    } catch (e) {
      const why = e.name === "TimeoutError" ? `timed out after ${timeoutSec}s` : undiciReason(e) || `stream interrupted: ${e.message}`;
      if (!st.content && !st.reasoning) return bad(`${why} (${base})`);
      return { ok: true, json: streamedJson(st), note: `[truncated: ${redact(why, key)}]` };
    }
    const partial = st.content || st.reasoning;
    if (st.error) {
      if (!partial) return bad(`stream error: ${redact(st.error, key)}`);
      return { ok: true, json: streamedJson(st), note: `[truncated: stream error: ${redact(st.error, key)}]` };
    }
    // Neither [DONE] nor a finish_reason: the connection ended early, so the text may be incomplete.
    if (!st.done && !st.finish && partial) {
      return { ok: true, json: streamedJson(st), note: "[truncated: stream ended without [DONE]]" };
    }
    return { ok: true, json: streamedJson(st) };
  }
  try {
    return { ok: true, json: await res.json() };
  } catch (e) {
    const why = e.name === "TimeoutError" ? `timed out after ${timeoutSec}s` : undiciReason(e);
    return bad(why ? `${why} (${base})` : `bad JSON: ${e.message}`);
  }
}

/** Shared tail of the HTTP engines: request, then extract the answer. */
async function askChat(args) {
  const r = await chatCompletion(args);
  if (!r.ok) return r;
  const a = extractAnswer(r.json);
  if (!a.ok) return fail(args.engine, a.reason);
  // A cut-off stream keeps what arrived (answer or reasoning-only) and says how it was cut.
  const body = r.note ? `${a.body}\n\n${r.note}` : a.body;
  // A model may echo the key it was never given; mask it before it reaches stdout or --out-dir.
  return { engine: args.engine, ok: true, body: redact(body, args.key), ...(a.degraded && { degraded: true }) };
}

/** HTTP status of a failure from chatCompletion ("HTTP 429: ..."), else null. */
const httpStatus = (reason) => Number(/^HTTP (\d{3})\b/.exec(reason)?.[1]) || null;

/** True for the statuses a fallback chain steps past: 404 (no access / gone), 410 (end of life), 429 (rate limit), 5xx. */
const stepsPast = (status) => status === 404 || status === 410 || status === 429 || (status >= 500 && status <= 599);

/**
 * Whether the nim chain moves on after a failed attempt: any non-HTTP failure (timeout, network, gateway, rate limit
 * after its retry, stream error, empty output) and 404 (no access) / 410 (end of life) / 5xx do; auth and bad-request
 * style failures (400, 401, 402, 403, other 4xx) end the chain, since another model would fail the same way.
 */
const nimStepsOn = (reason) => {
  const status = httpStatus(reason);
  return status === null || stepsPast(status);
};

/**
 * The fallback walk shared by nim and openrouter. `attempt(model, sec)` -> { ok: true, engine, body, degraded? } or
 * { ok: false, reason, next } (`next` = whether the following model is worth trying). Each step gets at most
 * `stepSec` and what is left of the `timeoutSec` budget; a later step with under `minStepSec` left is skipped.
 * A reasoning-only reply (ok + degraded) steps on but is kept as the last resort. All failed -> one failure
 * labelled `label` that lists every attempt.
 */
async function walkChain({ models, label, timeoutSec, stepSec, minStepSec, attempt }) {
  const deadline = Date.now() + timeoutSec * 1000;
  const failures = [];
  let reasoningOnly;
  for (const m of models) {
    const left = Math.floor((deadline - Date.now()) / 1000);
    if (failures.length && left < minStepSec) {
      failures.push(`${m}: skipped, ${Math.max(left, 0)}s of the ${timeoutSec}s budget left`);
      break;
    }
    const r = await attempt(m, Math.max(1, Math.min(stepSec, left)));
    if (r.ok && !r.degraded) return r;
    if (r.ok) reasoningOnly ??= r;
    failures.push(`${m}: ${r.ok ? "empty output (reasoning only)" : r.reason}`);
    if (!r.ok && !r.next) break;
  }
  return reasoningOnly ?? fail(label, failures.join("; "));
}

/**
 * One OpenRouter request on one model -> { ok: true, body } | { ok: false, reason, next }.
 * `next` = whether the fallback chain should try the following model (404/410/429/5xx, timeout, network error,
 * empty or reasoning-only content); any other failure (bad key, bad request, no credit) ends the chain.
 */
async function openRouterAttempt({ model, key, prompt, timeoutSec, fetchImpl, sleep }) {
  const r = await chatCompletion({
    engine: "openrouter", base: OPENROUTER_BASE, urlPath: "/v1/chat/completions", key, model, prompt, timeoutSec,
    maxTokens: 1500,
    headers: { "HTTP-Referer": "claude-consult", "X-Title": "claude-consult" },
    fetchImpl, sleep,
  });
  if (!r.ok) {
    const status = httpStatus(r.reason);
    const reason = status === 429 ? `rate-limited (${r.reason})` : r.reason;
    // A 400 "not a valid model ID" is about this model (delisted), not the request: the next model may be fine.
    const badModel = status === 400 && /not a valid model/i.test(r.reason);
    return { ok: false, reason, next: status === null || stepsPast(status) || badModel };
  }
  // OpenRouter can answer 200 with an error object (e.g. an upstream 429/5xx).
  const err = r.json?.error;
  if (err) {
    const code = Number(err.code) || null;
    const msg = redact(String(err.message ?? JSON.stringify(err)), key).trim().slice(0, 300);
    return { ok: false, reason: `${code === 429 ? "rate-limited (HTTP 429)" : `error${code ? ` ${code}` : ""}`}: ${msg}`, next: code === null || stepsPast(code) };
  }
  const a = extractAnswer(r.json);
  // Reasoning-only is not an answer: treat it as empty and move on.
  if (!a.ok || a.degraded) return { ok: false, reason: a.ok ? "empty output (reasoning only)" : a.reason, next: true };
  return { ok: true, body: a.body };
}

/**
 * One Gemini request on one model -> { ok: true, body } | { ok: false, reason, next }.
 * `next` = whether the fallback chain should try the following model (404/410/429/5xx, timeout, network error,
 * empty or reasoning-only content); 400/401/403 and the other 4xx statuses end the chain.
 */
async function geminiAttempt({ base, model, key, prompt, timeoutSec, fetchImpl, sleep }) {
  const r = await chatCompletion({
    engine: "gemini", base, urlPath: "/chat/completions", key, model, prompt, timeoutSec, maxTokens: 1500, fetchImpl, sleep,
  });
  if (!r.ok) {
    const status = httpStatus(r.reason);
    const reason = status === 429 ? `rate-limited (${r.reason})` : r.reason;
    return { ok: false, reason, next: status === null || stepsPast(status) };
  }
  // A 200 carrying an error object is handled like its HTTP status.
  const err = r.json?.error;
  if (err) {
    const code = Number(err.code) || null;
    const msg = redact(String(err.message ?? JSON.stringify(err)), key).trim().slice(0, 300);
    return { ok: false, reason: `${code === 429 ? "rate-limited (HTTP 429)" : `error${code ? ` ${code}` : ""}`}: ${msg}`, next: code === null || stepsPast(code) };
  }
  const a = extractAnswer(r.json);
  // Reasoning-only is not an answer: treat it as empty and move on.
  if (!a.ok || a.degraded) return { ok: false, reason: a.ok ? "empty output (reasoning only)" : a.reason, next: true };
  return { ok: true, body: a.body };
}

/** Token counts from a chat completion's `usage` (0 when absent). */
const usageOf = (json) => {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return { prompt: n(json?.usage?.prompt_tokens), completion: n(json?.usage?.completion_tokens) };
};

/**
 * One official-DeepSeek-API call -> an engine result. Flash only (see isDsapiModel): a model that fails the
 * check is refused before the key is even read, so nothing is ever sent for it. One retry on 429 / 5xx / network
 * error / timeout (inside the same 90 s budget); 400/401/402/403 and other 4xx are final. Counts every request
 * and the response's token usage in ~/.dsapi-usage.json.
 */
async function dsapiAsk({ prompt, timeoutSec, model, label, env = process.env, home, readFile, writeFile, fetchImpl = fetch, sleep = defaultSleep, now }) {
  timeoutSec = Math.min(timeoutSec ?? DSAPI_TIMEOUT_SEC, DSAPI_TIMEOUT_SEC);
  const given = model !== undefined && model !== null;
  model = given ? model : env.DSAPI_MODEL?.trim() || DEFAULT_DSAPI_MODEL;
  const engine = label || (model === DEFAULT_DSAPI_MODEL ? "dsapi" : `dsapi:${model}`);
  if (!isDsapiModel(model)) {
    return fail(engine, `dsapi is limited to flash: model ${JSON.stringify(redact(String(model)).slice(0, 80))} refused (the id must name a flash model, never pro or reasoner); nothing was sent`);
  }
  const key = resolveDsapiKey({ env, home, readFile });
  const orKey = !dsOrState.off && String(env.DS_UPSTREAM ?? "").trim().toLowerCase() !== "deepseek" ? resolveOpenRouterKey({ env, home, readFile }) : "";
  if (!key && !orKey) return fail(engine, "no key (env DEEPSEEK_API_KEY or ~/.deepseek-api-key)");

  const deadline = Date.now() + timeoutSec * 1000;
  let orReason = "";
  if (orKey) {
    // OpenRouter credit first. The model is pinned here: the id given above only has to pass the flash gate.
    const r = await chatCompletion({
      engine, base: OPENROUTER_BASE, urlPath: "/v1/chat/completions", key: orKey, model: DSAPI_OR_MODEL, prompt,
      // capped so a hanging OpenRouter leaves the DeepSeek fallback most of the budget
      timeoutSec: Math.max(1, Math.min(DSAPI_OR_TIMEOUT_SEC, Math.ceil((deadline - Date.now()) / 1000))), maxTokens: 1500,
      extraBody: { provider: { data_collection: "deny" }, reasoning: { enabled: false } },
      headers: { "HTTP-Referer": "claude-consult", "X-Title": "claude-consult" },
      fetchImpl, sleep,
    });
    const a = r.ok && !r.json?.error ? extractAnswer(r.json) : null;
    if (a?.ok && !a.degraded) {
      return { engine, ok: true, body: redact(a.body, orKey), upstream: "openrouter" };
    }
    const st = r.ok ? Number(r.json?.error?.code) || null : httpStatus(r.reason);
    if (st === 401 || st === 402 || st === 403 || st === 404) dsOrState.off = true;
    orReason = r.ok ? (a?.ok ? "empty output (reasoning only)" : a?.reason ?? `error ${st ?? ""}`) : r.reason;
    if (!key) return fail(engine, `openrouter: ${orReason}`);
  }
  if (!key) return fail(engine, "no key (env DEEPSEEK_API_KEY or ~/.deepseek-api-key)");
  let retryAfter;
  const seeing = async (url, init) => {
    const res = await fetchImpl(url, init);
    retryAfter = res.headers?.get?.("retry-after");
    return res;
  };
  let requests = 0;
  const tokens = { prompt: 0, completion: 0 };
  let result;
  for (let attempt = 1; !result; attempt++) {
    requests++;
    const r = await chatCompletion({
      engine, base: DSAPI_BASE, urlPath: "/chat/completions", key, model, prompt,
      timeoutSec: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)), maxTokens: 1500,
      extraBody: { thinking: { type: "disabled" } }, // short consult answers; no hidden reasoning spend
      fetchImpl: seeing, sleep,
    });
    if (r.ok) {
      const u = usageOf(r.json);
      tokens.prompt += u.prompt;
      tokens.completion += u.completion;
      const a = extractAnswer(r.json);
      result = a.ok
        ? { engine, ok: true, body: redact(a.body, key), ...(a.degraded && { degraded: true }) }
        : fail(engine, a.reason);
      break;
    }
    const status = httpStatus(r.reason);
    const retryable = status === null || status === 429 || (status >= 500 && status <= 599);
    const delay = status === 429 ? retryDelayMs(retryAfter) : 2000;
    if (!retryable || attempt === 2 || delay + 3000 > deadline - Date.now()) {
      result = status === 429 ? fail(engine, `rate-limited (${r.reason})`) : r;
      break;
    }
    await sleep(delay);
  }
  bumpDsapiUsage({ requests, promptTokens: tokens.prompt, completionTokens: tokens.completion }, { home: home ?? os.homedir(), now, readFile, writeFile });
  return result;
}

/** True when a failed deepseek-proxy result means "the proxy is not usable here": no key, unreachable, or HTTP 5xx. */
const proxyDown = (r) => !r.ok && (/^no DEEPSEEKER_API_KEY/.test(r.reason) || /^unreachable\b/.test(r.reason) || /^HTTP 5\d\d\b/.test(r.reason));

/** "engine" or "engine:model" (first colon only; model ids contain "/") -> { engine, model|null }. */
export function parseSpec(spec) {
  const s = String(spec).trim();
  const i = s.indexOf(":");
  if (i < 0) return { engine: s, model: null };
  return { engine: s.slice(0, i).trim(), model: s.slice(i + 1).trim() };
}

/** Engines that accept a per-call model, i.e. may appear as engine:model. */
export const MODEL_ENGINES = ["copilot", "codex", "nim", "deepseek", "openrouter", "dsapi", "gemini", "azure", "opencode"];

async function copilotRun({ prompt, cwd, timeoutSec, model, effort, promptFile }) {
  model = model || process.env.COPILOT_MODEL || undefined;
  effort = effort || process.env.COPILOT_EFFORT || undefined;
  let res;
  try {
    const { cmd, pre } = resolveCopilot();
    const run = (m) => runCli({ cmd, args: [...pre, ...copilotArgs({ prompt, cwd, model: m, effort, promptFile })], cwd, timeoutSec });
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
}

async function codexRun({ prompt, cwd, timeoutSec, model, effort, promptFile }) {
  model = model || process.env.CODEX_MODEL || undefined;
  effort = effort || process.env.CODEX_EFFORT || undefined;
  const outFile = path.join(os.tmpdir(), `consult-codex-${process.pid}-${randomUUID()}.txt`);
  const args = codexArgs({ prompt, cwd, outFile, model, effort, promptFile });
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
}

export const ENGINES = {
  copilot({ prompt, cwd, timeoutSec, model, effort }) {
    return withPromptFile("copilot", prompt, (promptFile) => copilotRun({ prompt, cwd, timeoutSec, model, effort, promptFile }));
  },

  codex({ prompt, cwd, timeoutSec, model, effort }) {
    return withPromptFile("codex", prompt, (promptFile) => codexRun({ prompt, cwd, timeoutSec, model, effort, promptFile }));
  },

  // Opt-in (AI Plus quota): not in the default order.
  agy({ prompt, cwd, timeoutSec }) {
    return withPromptFile("agy", prompt, (promptFile) =>
      launch("agy", resolveAgy, agyArgs({ prompt, cwd, timeoutSec, promptFile }), cwd, timeoutSec));
  },

  async deepseek({ prompt, timeoutSec, model, fetchImpl, sleep, ...rest }) {
    const creds = deepseekCreds();
    // A per-call model labels the result so several deepseek models stay distinguishable.
    const engine = model ? `deepseek:${model}` : "deepseek";
    const viaProxy = creds.key
      ? await askChat({ engine, base: creds.base, key: creds.key, model: model || creds.model, prompt, timeoutSec, fetchImpl, sleep })
      : fail(engine, "no DEEPSEEKER_API_KEY (env or deeperseeker .env)");
    // Proxy missing, down or broken: keep a DeepSeek voice via the official API (flash). A proxy that answers is
    // never second-guessed, and a per-call proxy model (deepseek:<m>) means a different model was asked for.
    if (model || !proxyDown(viaProxy)) return viaProxy;
    const alt = await dsapiAsk({ prompt, timeoutSec, label: "deepseek->dsapi", fetchImpl, sleep, ...rest, model: undefined });
    return alt.ok ? alt : fail(engine, `${viaProxy.reason}; fallback dsapi: ${alt.reason}`);
  },

  // Official DeepSeek API, flash models only. Plain HTTP: prompt text only. Opt-in; also the fallback of deepseek.
  dsapi(args) {
    return dsapiAsk(args);
  },

  // NVIDIA NIM hosted API (free trial key). Plain HTTP like deepseek: prompt text only.
  // Bare nim walks a fallback chain (NIM_CHAIN); an explicit nim:<model> other than the default runs only that model.
  async nim({ prompt, timeoutSec, model, explicit = false, env = process.env, home, readFile, fetchImpl, sleep }) {
    // Clamp here too, so no caller (perEngine options, direct use) can lift the 10-minute cap.
    timeoutSec = Math.min(timeoutSec ?? nimTimeoutSec(env), NIM_TIMEOUT_MAX_SEC);
    const dflt = env.NIM_MODEL || DEFAULT_NIM_MODEL;
    model = model || dflt;
    const key = resolveNimKey({ env, home, readFile });
    if (!key) return fail(`nim:${model}`, "no NIM_API_KEY (env or ~/.nvidia-nim-key)");
    const ask = (m, t) => askChat({
      engine: `nim:${m}`,
      base: nimBase(env),
      key,
      model: m,
      prompt,
      timeoutSec: t,
      maxTokens: Number(env.NIM_MAX_TOKENS) > 0 ? Math.floor(Number(env.NIM_MAX_TOKENS)) : 8192,
      retry429: true,
      stream: true,
      gateway: true,
      fetchImpl,
      sleep,
    });
    // Single-model evaluations stay honest: no chain, the whole budget for that one model.
    const models = explicit && model !== dflt ? [model] : nimModels(model, env);
    if (models.length === 1) return ask(model, timeoutSec);
    // The label names the model that actually answered (askChat set it to nim:<m>).
    return walkChain({
      models, label: `nim:${model}`, timeoutSec, stepSec: NIM_ATTEMPT_TIMEOUT_SEC, minStepSec: NIM_MIN_ATTEMPT_SEC,
      attempt: async (m, sec) => {
        const r = await ask(m, sec);
        return r.ok ? r : { ...r, next: nimStepsOn(r.reason) };
      },
    });
  },

  // OpenRouter free models. Plain HTTP like nim: prompt text only. Bare openrouter walks a fallback chain
  // (OPENROUTER_CHAIN); an explicit openrouter:<model> other than the default runs only that model.
  async openrouter({ prompt, timeoutSec, model, explicit = false, env = process.env, home, readFile, fetchImpl, sleep, now, cacheFile }) {
    // Clamp here too, so no caller can lift the cap.
    timeoutSec = Math.min(timeoutSec ?? openRouterTimeoutSec(env), OPENROUTER_TIMEOUT_MAX_SEC);
    const dflt = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
    model = model || dflt;
    const key = resolveOpenRouterKey({ env, home, readFile });
    if (!key) return fail(`openrouter:${model}`, "no key (env OPENROUTER_API_KEY or ~/.openrouter-key)");
    // A negative balance cannot serve any model: skip the whole chain before its first request.
    // A caller that injects its own fetch must name the cache file too, so a scripted chat fetch
    // is never consumed by the credit probe; production and the credit tests always check.
    const credit = cacheFile || fetchImpl === undefined || fetchImpl === fetch
      ? await openRouterCredit({ key, fetchImpl, now, cacheFile })
      : null;
    if (typeof credit === "number" && credit <= 0) {
      return fail(`openrouter:${model}`, `openrouter skipped: credit USD ${credit} (negative balance)`);
    }
    const reserve = orFreeReserve(env, 0);
    const ask = async (m, sec) => {
      if (reserve > 0 && /:free$/.test(m)) {
        const left = await openRouterFreeRemaining({ key, fetchImpl });
        if (left !== null && left <= reserve) {
          return { ok: false, reason: `free pool at ${left} requests left today (reserve ${reserve}); :free models skipped`, next: true };
        }
      }
      const r = await openRouterAttempt({ model: m, key, prompt, timeoutSec: sec, fetchImpl, sleep });
      // The label names the model that actually answered.
      return r.ok ? { engine: `openrouter:${m}`, ok: true, body: redact(r.body, key) } : r;
    };
    const models = explicit && model !== dflt ? [model] : openRouterModels(model, env);
    if (models.length === 1) {
      const r = await ask(model, timeoutSec);
      return r.ok ? r : fail(`openrouter:${model}`, r.reason);
    }
    return walkChain({
      models, label: `openrouter:${model}`, timeoutSec, stepSec: OPENROUTER_ATTEMPT_TIMEOUT_SEC, minStepSec: NIM_MIN_ATTEMPT_SEC,
      attempt: ask,
    });
  },

  // OpenCode CLI, free models (see the block above). Bare opencode walks a fallback chain (OPENCODE_CHAIN); an explicit
  // opencode:<model> other than the default runs only that model. Always runs in an empty temp dir, never in `cwd`.
  async opencode({ prompt, timeoutSec, model, explicit = false, env = process.env, home, readFile, panel }) {
    // Clamp here too, so no caller can lift the cap.
    timeoutSec = Math.min(timeoutSec ?? opencodeTimeoutSec(env), OPENCODE_TIMEOUT_MAX_SEC);
    const dflt = opencodeChain(env)[0];
    model = model || dflt;
    const resolve = () => resolveOpenCode({ env });
    try {
      resolve();
    } catch (e) {
      return launchFailure(`opencode:${model}`, e);
    }
    const ask = async (m, sec) => {
      const r = await opencodeAttempt({ model: m, prompt, timeoutSec: sec, resolve });
      // The label names the model that actually answered.
      return r.ok ? { engine: `opencode:${m}`, ok: true, body: redact(r.body) } : r;
    };
    const models = explicit && model !== dflt ? [model]
      : opencodeModels(model, env).filter((m) => m === model || !reserveBlocked(m, panel, { env, home, readFile }));
    if (models.length === 1) {
      const r = await ask(model, timeoutSec);
      return r.ok ? r : fail(`opencode:${model}`, r.reason);
    }
    return walkChain({
      models, label: `opencode:${model}`, timeoutSec, stepSec: OPENCODE_ATTEMPT_TIMEOUT_SEC, minStepSec: NIM_MIN_ATTEMPT_SEC,
      attempt: ask,
    });
  },

  // Google Gemini API (OpenAI-compatible endpoint). Plain HTTP like nim: prompt text only. Bare gemini walks a
  // fallback chain (GEMINI_CHAIN); an explicit gemini:<model> other than the default runs only that model.
  async gemini({ prompt, timeoutSec, model, explicit = false, env = process.env, home, readFile, fetchImpl, sleep }) {
    // Clamp here too, so no caller can lift the cap.
    timeoutSec = Math.min(timeoutSec ?? geminiTimeoutSec(env), GEMINI_TIMEOUT_MAX_SEC);
    const dflt = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    model = model || dflt;
    const key = resolveGeminiKey({ env, home, readFile });
    if (!key) return fail(`gemini:${model}`, "no key (env GEMINI_API_KEY or ~/.gemini-api-key)");
    const base = geminiBase(env);
    const ask = async (m, sec) => {
      const r = await geminiAttempt({ base, model: m, key, prompt, timeoutSec: sec, fetchImpl, sleep });
      // The label names the model that actually answered.
      return r.ok ? { engine: `gemini:${m}`, ok: true, body: redact(r.body, key) } : r;
    };
    const models = explicit && model !== dflt ? [model] : geminiModels(model, env);
    if (models.length === 1) {
      const r = await ask(model, timeoutSec);
      return r.ok ? r : fail(`gemini:${model}`, r.reason);
    }
    return walkChain({
      models, label: `gemini:${model}`, timeoutSec, stepSec: GEMINI_ATTEMPT_TIMEOUT_SEC, minStepSec: NIM_MIN_ATTEMPT_SEC,
      attempt: ask,
    });
  },

  // Azure OpenAI chat completions. Plain HTTP: prompt text only. Opt-in; one model, no chain.
  async azure({ prompt, timeoutSec, model, env = process.env, home, readFile, fetchImpl }) {
    // Clamp here too, so no caller can lift the cap.
    timeoutSec = Math.min(timeoutSec ?? azureTimeoutSec(env), AZURE_TIMEOUT_MAX_SEC);
    model = azureModel(model, env);
    const label = `azure:${model}`;
    const key = resolveAzureKey({ env, home, readFile });
    if (!key) return fail(label, "no key (env AZURE_OPENAI_KEY or ~/.azure-openai-key)");
    const base = azureBase({ env, home, readFile });
    if (!base) return fail(label, "no endpoint (env AZURE_OPENAI_ENDPOINT or ~/.azure-openai-endpoint)");
    return azureAsk({ base, model, key, prompt, timeoutSec, maxTokens: azureMaxTokens(env), fetchImpl });
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
  // nim has its own (longer) budget; CONSULT_TIMEOUT does not apply to it.
  // openrouter likewise has its own whole-chain budget (OPENROUTER_TIMEOUT, 300 s; 60 s per step).
  const own = engine === "nim" ? { timeoutSec: nimTimeoutSec(base.env ?? process.env) }
    : engine === "openrouter" ? { timeoutSec: openRouterTimeoutSec(base.env ?? process.env) }
    : engine === "dsapi" ? { timeoutSec: DSAPI_TIMEOUT_SEC }
    : engine === "gemini" ? { timeoutSec: geminiTimeoutSec(base.env ?? process.env) }
    : engine === "opencode" ? { timeoutSec: opencodeTimeoutSec(base.env ?? process.env) }
    : engine === "azure" ? { timeoutSec: azureTimeoutSec(base.env ?? process.env) } : {};
  // A model written in the spec is "explicit": for nim it disables the fallback chain (unless it is the default; same for openrouter).
  return ENGINES[engine]({ ...base, ...own, ...perEngine[engine], ...(model ? { model, explicit: true } : {}) });
}

/**
 * agy fallback, like `deepseek -> dsapi`: when an agy run fails (any failure, including a quota-lock skip) and a
 * Gemini key resolves, run `gemini` instead and label the result `agy->gemini:<model>`; if both fail, one failure
 * lists both reasons. Without a Gemini key agy's result is returned unchanged. Wrap a `withLocks(runSpec)`: the
 * agy lock is written inside by withLocks before this sees the failure, so it stays as today.
 */
// skip=true when gemini is already its own member of the order: a fallback would give a second,
// identical gemini voice in --mode all (and --mode first reaches gemini anyway).
export function withGeminiFallback(run, { skip = false } = {}) {
  return async (spec, base = {}, perEngine = {}) => {
    const r = await run(spec, base, perEngine);
    if (skip || parseSpec(spec).engine !== "agy" || r.ok) return r;
    const key = resolveGeminiKey({ env: base.env ?? process.env, home: base.home, readFile: base.readFile });
    if (!key) return r;
    const g = await run("gemini", base, perEngine);
    const engine = `agy->${g.engine}`;
    return g.ok ? { ...g, engine } : { engine, ok: false, reason: `agy: ${r.reason}; gemini: ${g.reason}` };
  };
}
