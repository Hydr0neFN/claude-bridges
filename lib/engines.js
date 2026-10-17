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

/** Longest prompt passed to agy as an argument; longer ones are spilled to a file. */
export const AGY_ARGV_MAX = 24000;

/** Same invocation shape agy-bridge uses (skip-permissions + print-timeout). */
export function agyArgs({ prompt, cwd, timeoutSec, promptFile }) {
  const text = promptFile
    ? `Your full task is in the file ${promptFile}. Read the whole file first, then respond to it exactly as if its contents were this message. Do not create, modify or delete any files.`
    : prompt;
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
  fetchImpl = fetch, sleep = defaultSleep,
}) {
  const bad = (reason) => fail(engine, redact(reason, key));
  const deadline = Date.now() + timeoutSec * 1000;
  const post = () =>
    fetchImpl(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...(stream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify({
        model,
        stream,
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
  async agy({ prompt, cwd, timeoutSec }) {
    // agy -p takes the prompt only as an argument (no stdin text mode), and a Windows command line
    // caps near 32K chars (spawn ENAMETOOLONG), so a long prompt goes through a file agy reads.
    let promptFile = null;
    if (prompt.length > AGY_ARGV_MAX) {
      promptFile = path.join(os.tmpdir(), `consult-agy-${process.pid}-${randomUUID()}.md`);
      try {
        fs.writeFileSync(promptFile, prompt, "utf8");
      } catch (e) {
        return fail("agy", `cannot write prompt file: ${e.message}`);
      }
    }
    try {
      return await launch("agy", resolveAgy, agyArgs({ prompt, cwd, timeoutSec, promptFile }), cwd, timeoutSec);
    } finally {
      if (promptFile) {
        try {
          fs.rmSync(promptFile, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
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
    // Clamp here too, so no caller (perEngine options, direct use) can lift the 10-minute cap.
    timeoutSec = Math.min(timeoutSec ?? nimTimeoutSec(env), NIM_TIMEOUT_MAX_SEC);
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
      stream: true,
      gateway: true,
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
  // nim has its own (longer) budget; CONSULT_TIMEOUT does not apply to it.
  const own = engine === "nim" ? { timeoutSec: nimTimeoutSec(base.env ?? process.env) } : {};
  return ENGINES[engine]({ ...base, ...own, ...perEngine[engine], ...(model ? { model } : {}) });
}
