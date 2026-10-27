// Engine runners used by consult-bridge and consult-cli. Binary resolution is
// shared with the legacy solo bridges through lib/common.js. Every engine
// resolves to { engine, ok, body } or { engine, ok: false, reason }.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
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
const OPENROUTER_KEY_RE = /sk-or-[A-Za-z0-9_-]+/g;

// DeepSeek keys are sk- plus 32 alphanumerics; sk-or- (OpenRouter) is masked first and never matches this.
const DEEPSEEK_KEY_RE = /sk-[A-Za-z0-9]{24,}/g;

/** Mask NIM-, OpenRouter- and DeepSeek-style keys (and `secret`, if given) in text bound for user-visible output. */
export function redact(text, secret) {
  let out = String(text).replace(NIM_KEY_RE, "nvapi-***").replace(OPENROUTER_KEY_RE, "sk-or-***").replace(DEEPSEEK_KEY_RE, "sk-***");
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
// Free-tier fallback chain, first = default. No family may also appear in NIM_CHAIN (so no nvidia/nemotron, minimax,
// z-ai, openai here). Left out on purpose: thinkingmachines/inkling[-small]:free (403, agentic harnesses only),
// google/gemma-4-*:free and xingchen-agi/xing4.0:free (rate-limited upstream on every call of the 2026-10-27 probe).
export const OPENROUTER_CHAIN = [
  DEFAULT_OPENROUTER_MODEL,
  "cohere/north-mini-code:free",
  "recursive/flint-v1.0:free",
  "dots-studio/dots-3-note-preview:free",
  "liquid/lfm-2.5-2.6b:free",
];
const OPENROUTER_BASE = "https://openrouter.ai/api";
const OPENROUTER_DEFAULT_KEY_FILE = ".openrouter-key";
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
  if (!key) return fail(engine, "no key (env DEEPSEEK_API_KEY or ~/.deepseek-api-key)");

  const deadline = Date.now() + timeoutSec * 1000;
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

// Local Qwen (whatever lab model the gate serves) on hgn-fw13 behind llm-gate, over the tailnet. Free and private:
// the prompt never leaves the owner's machines. Plain HTTP like deepseek: prompt text only. DOWTrade owns the box
// during the US cash session, so the engine refuses to run inside the window (same guard as the nightly-lab runner):
// weekdays 07:30-16:45 America/New_York (end exclusive). The lab key is best-effort class: the gate answers 503
// while DOWTrade or another lab job holds it. The interactive key (~/.config/fw13/interactive.key) is preferred when present:
// the gate then treats the call as interactive work (DOWTrade is refused while it runs, a running lab job is preempted) and
// the call carries a random X-Gate-Session token whose lease is released again when the call ends.
export const QWEN_DEFAULT_BASE = "http://100.119.161.52:8097";
const QWEN_DEFAULT_KEY_FILE = path.join(".config", "fw13", "lab.key");
const QWEN_DEFAULT_INTERACTIVE_KEY_FILE = path.join(".config", "fw13", "interactive.key");
const QWEN_RELEASE_TIMEOUT_MS = 5000;
export const QWEN_TIMEOUT_SEC = 300;
const QWEN_WINDOW = { start: 7 * 60 + 30, end: 16 * 60 + 45 }; // minutes after midnight, New York time

/** True inside the DOWTrade window: a weekday, 07:30 <= New York time < 16:45. */
export function inTradingHours(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= QWEN_WINDOW.start && minutes < QWEN_WINDOW.end;
}

const expandHome = (p, home) => (p.startsWith("~") ? path.join(home, p.slice(1)) : p);

/**
 * Gate key: QWEN_API_KEY env; else the interactive key file (QWEN_KEY_PATH, FW13_LLM_INTERACTIVE_KEY_FILE, or
 * ~/.config/fw13/interactive.key) when readable and non-empty; else the lab key file (QWEN_KEY_PATH, FW13_LLM_KEY_FILE,
 * or ~/.config/fw13/lab.key); "" when none.
 */
export function resolveQwenKey({ env = process.env, home = os.homedir(), readFile = defaultReadFile } = {}) {
  if (env.QWEN_API_KEY?.trim()) return env.QWEN_API_KEY.trim();
  const readKey = (file) => {
    try {
      return readFile(expandHome(file, home)).trim();
    } catch {
      return "";
    }
  };
  const interactive = readKey(env.QWEN_KEY_PATH || env.FW13_LLM_INTERACTIVE_KEY_FILE || path.join(home, QWEN_DEFAULT_INTERACTIVE_KEY_FILE));
  if (interactive) return interactive;
  return readKey(env.QWEN_KEY_PATH || env.FW13_LLM_KEY_FILE || path.join(home, QWEN_DEFAULT_KEY_FILE));
}

/** Gate base URL without a trailing slash (QWEN_BASE, else FW13_LLM_URL, else the tailnet address). */
export const qwenBase = (env = process.env) => (env.QWEN_BASE || env.FW13_LLM_URL || QWEN_DEFAULT_BASE).replace(/\/+$/, "");

/** True when the default panel may add qwen: outside the trading window and a key is present. */
export function qwenAvailable(opts = {}) {
  return !inTradingHours(opts.now ?? Date.now()) && Boolean(resolveQwenKey(opts));
}

/** Id of the model the gate serves right now (GET /v1/models), or null when it cannot be told. */
async function qwenServedModel({ base, key, session, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}`, "X-Gate-Session": session }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const id = (await res.json())?.data?.[0]?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** Best-effort lease release (GET /gate/lease, X-Gate-Lease: release); never throws, the answer is ignored. */
async function qwenRelease({ base, key, session, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`${base}/gate/lease`, {
      headers: { Authorization: `Bearer ${key}`, "X-Gate-Session": session, "X-Gate-Lease": "release" },
      signal: AbortSignal.timeout(QWEN_RELEASE_TIMEOUT_MS),
    });
    await res?.body?.cancel?.();
  } catch {
    /* the lease then simply expires on the gate */
  }
}

async function qwenAsk({ prompt, timeoutSec, env = process.env, home, readFile, fetchImpl, sleep, now }) {
  if (inTradingHours(now ?? Date.now())) return fail("qwen", "skipped: trading hours");
  const key = resolveQwenKey({ env, home, readFile });
  if (!key) return fail("qwen", "no key (env QWEN_API_KEY or ~/.config/fw13/interactive.key or lab.key)");
  const base = qwenBase(env);
  const session = randomBytes(16).toString("hex"); // fresh 128-bit interactive-lease token per call
  try {
    const model = env.QWEN_MODEL?.trim() || (await qwenServedModel({ base, key, session, fetchImpl })) || "default";
    const engine = `qwen:${model}`; // the label names the lab model that actually answers
    const r = await askChat({
      engine, base, key, model, prompt, timeoutSec: Math.min(timeoutSec ?? QWEN_TIMEOUT_SEC, QWEN_TIMEOUT_SEC),
      maxTokens: Number(env.QWEN_MAX_TOKENS) > 0 ? Math.floor(Number(env.QWEN_MAX_TOKENS)) : 4096, stream: true, fetchImpl, sleep,
      headers: { "X-Gate-Session": session },
    });
    if (!r.ok && httpStatus(r.reason) === 503) return fail(engine, `skipped: gate busy (${r.reason})`);
    return r;
  } finally {
    await qwenRelease({ base, key, session, fetchImpl });
  }
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
export const MODEL_ENGINES = ["copilot", "codex", "nim", "deepseek", "openrouter", "dsapi"];

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
  async openrouter({ prompt, timeoutSec, model, explicit = false, env = process.env, home, readFile, fetchImpl, sleep }) {
    // Clamp here too, so no caller can lift the cap.
    timeoutSec = Math.min(timeoutSec ?? openRouterTimeoutSec(env), OPENROUTER_TIMEOUT_MAX_SEC);
    const dflt = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
    model = model || dflt;
    const key = resolveOpenRouterKey({ env, home, readFile });
    if (!key) return fail(`openrouter:${model}`, "no key (env OPENROUTER_API_KEY or ~/.openrouter-key)");
    const ask = async (m, sec) => {
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

  // Local Qwen on hgn-fw13 via llm-gate: free and private; skipped inside the DOWTrade window.
  qwen(args) {
    return qwenAsk(args);
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
    : engine === "qwen" ? { timeoutSec: QWEN_TIMEOUT_SEC } : {};
  // A model written in the spec is "explicit": for nim it disables the fallback chain (unless it is the default; same for openrouter).
  return ENGINES[engine]({ ...base, ...own, ...perEngine[engine], ...(model ? { model, explicit: true } : {}) });
}
