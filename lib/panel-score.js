// Post-panel scoring via decide.py (`decide_many` CLI): scores each answering
// member on `agrees_with_majority` (noul) and `quality` (score 0..3).

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const QUALITY_LABELS = ["wrong", "weak", "ok", "strong"];
export const MAX_ANSWER_CHARS = 6000;
export const DISAGREE_CLIP_CHARS = 300;
const DEFAULT_TIMEOUT_MS = 60_000;

function expandHome(p) {
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

/** Resolve the decide.py script path from CONSULT_SCORE_DECIDE_PY or ~/.claude/bin/decide.py. */
export function resolveDecidePy(env = process.env) {
  const raw = env?.CONSULT_SCORE_DECIDE_PY?.trim();
  return raw ? expandHome(raw) : path.join(os.homedir(), ".claude", "bin", "decide.py");
}

/** Build the decide_many questions object (2 keys per answering engine). */
export function buildQuestions(engines) {
  const questions = {};
  for (const engine of engines) {
    questions[`${engine}.agrees_with_majority`] = {
      type: "noul",
      instructions: `Does the answer of member ${engine} reach the same main conclusion as the majority of the other members?`,
    };
    questions[`${engine}.quality`] = {
      type: "score",
      criteria: [...QUALITY_LABELS],
      instructions: `Rate the factual correctness and usefulness of member ${engine}'s answer.`,
    };
  }
  return questions;
}

/** Build the input text with the original prompt followed by capped member answers. */
export function buildInputText(prompt, answers) {
  const parts = [];
  const p = String(prompt ?? "").trim();
  if (p) parts.push(p);
  for (const a of answers) {
    parts.push(`=== ${a.engine} ===\n${String(a.text ?? "").slice(0, MAX_ANSWER_CHARS)}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** Format a short plain-text table (engine, agrees y/n/?, quality label). */
export function formatTable(rows) {
  const engW = Math.max("engine".length, ...rows.map((r) => r.engine.length));
  const agrW = Math.max("agrees".length, ...rows.map((r) => r.agrees.length));
  const qlW = Math.max("quality".length, ...rows.map((r) => r.quality_label.length));
  const pad = (s, w) => String(s).padEnd(w, " ");
  return [
    `${pad("engine", engW)}  ${pad("agrees", agrW)}  ${pad("quality", qlW)}`,
    `${"-".repeat(engW)}  ${"-".repeat(agrW)}  ${"-".repeat(qlW)}`,
    ...rows.map((r) => `${pad(r.engine, engW)}  ${pad(r.agrees, agrW)}  ${pad(r.quality_label, qlW)}`),
  ].join("\n");
}

/** Format the table and the "Disagreeing points" block for text stdout. */
export function formatScoreOutput(score, answers) {
  if (!score?.ok) return "";
  const byEngine = new Map((answers || []).map((a) => [a.engine, String(a.text ?? "")]));
  const parts = [score.table];
  if (score.disagreeing?.length) {
    const items = score.disagreeing.map((engine) => {
      const raw = (byEngine.get(engine) ?? "").trim();
      const clipped = raw.length > DISAGREE_CLIP_CHARS ? `${raw.slice(0, DISAGREE_CLIP_CHARS)}...` : raw;
      return `- ${engine}: ${clipped}`;
    });
    parts.push(`Disagreeing points:\n${items.join("\n")}`);
  }
  return parts.join("\n\n");
}

function defaultRun(cmd, args, { timeout }) {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = err.killed ? `timed out after ${timeout}ms` : err.message;
            resolve({ ok: false, reason: detail, stdout, stderr });
            return;
          }
          resolve({ ok: true, stdout, stderr });
        },
      );
    } catch (e) {
      resolve({ ok: false, reason: e?.message || String(e) });
    }
  });
}

function parseJsonLine(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* try earlier line */
      }
    }
    return null;
  }
}

function normalizeRunResult(res) {
  if (typeof res === "string") return { ok: true, stdout: res };
  if (!res || typeof res !== "object") return { ok: false, reason: "empty runner result" };
  if (res.ok === false) return { ok: false, reason: String(res.reason || res.stderr || "decide failed") };
  const exitCode = res.status ?? res.code;
  if (typeof exitCode === "number" && exitCode !== 0) {
    return { ok: false, reason: String(res.stderr || `exit ${exitCode}`).trim() };
  }
  return { ok: true, stdout: String(res.stdout ?? "") };
}

/**
 * Score panel answers with one `decide.py many` call. Never throws.
 * @returns {Promise<{ok:true, rows:Array, disagreeing:string[], table:string} | {ok:false, reason:string}>}
 */
export async function scorePanel({ prompt, answers }, opts = {}) {
  try {
    const validAnswers = Array.isArray(answers)
      ? answers.filter((a) => a && typeof a.engine === "string" && a.engine.trim() && String(a.text ?? "").trim())
      : [];
    if (validAnswers.length < 3) {
      return { ok: false, reason: "fewer than 3 answers" };
    }

    const env = opts?.env || process.env;
    const python = opts?.python || env.CONSULT_SCORE_PYTHON || "python";
    const decidePy = opts?.decidePy || resolveDecidePy(env);
    const timeoutMs = Number(opts?.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const run = opts?.run || defaultRun;

    const questions = buildQuestions(validAnswers.map((a) => a.engine));
    const inputText = buildInputText(prompt, validAnswers);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-score-"));
    let runResult;
    try {
      const qFile = path.join(tmpDir, "questions.json");
      const inFile = path.join(tmpDir, "input.txt");
      fs.writeFileSync(qFile, JSON.stringify(questions), "utf8");
      fs.writeFileSync(inFile, inputText, "utf8");

      const argv = [
        decidePy,
        "many",
        "--kind",
        "panel_score",
        "--questions-json",
        qFile,
        "--input-file",
        inFile,
        "--public",
      ];
      runResult = normalizeRunResult(await run(python, argv, { timeout: timeoutMs, windowsHide: true }));
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }

    if (!runResult.ok) return { ok: false, reason: runResult.reason };

    const parsed = parseJsonLine(runResult.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "invalid JSON from decide" };
    }
    if (parsed._meta?.error) return { ok: false, reason: String(parsed._meta.error) };
    if (parsed.ok === false && parsed.reason) return { ok: false, reason: String(parsed.reason) };

    const hasAnyKey = validAnswers.some(
      (a) => Object.hasOwn(parsed, `${a.engine}.agrees_with_majority`) || Object.hasOwn(parsed, `${a.engine}.quality`),
    );
    if (!hasAnyKey) {
      return { ok: false, reason: "missing score keys in decide response" };
    }

    const rows = [];
    const disagreeing = [];
    for (const a of validAnswers) {
      const ag = parsed[`${a.engine}.agrees_with_majority`];
      const ql = parsed[`${a.engine}.quality`];

      const agEsc = Boolean(ag?.escalate);
      const agP = ag && typeof ag.p === "number" && !Number.isNaN(ag.p) ? ag.p : null;
      const agConf = ag && typeof ag.confidence === "number" && !Number.isNaN(ag.confidence) ? ag.confidence : null;
      const agreesUnknown = !ag || agEsc || agP === null;
      const agrees = agreesUnknown ? "?" : agP >= 0.5 ? "y" : "n";

      const qlEsc = Boolean(ql?.escalate);
      const qlScore =
        ql && typeof ql.score === "number" && Number.isInteger(ql.score) && ql.score >= 0 && ql.score <= 3
          ? ql.score
          : null;
      const qlConf = ql && typeof ql.confidence === "number" && !Number.isNaN(ql.confidence) ? ql.confidence : null;
      const qualityUnknown = !ql || qlEsc || qlScore === null;
      const quality = qualityUnknown ? null : qlScore;
      const quality_label = qualityUnknown ? "?" : QUALITY_LABELS[qlScore];

      rows.push({
        engine: a.engine,
        agrees_p: agP,
        agrees,
        quality,
        quality_label,
        confidence: agConf ?? qlConf ?? null,
        escalate: agEsc || qlEsc,
      });

      if (!agreesUnknown && agP < 0.5 && (agConf ?? 0) >= 0.7) {
        disagreeing.push(a.engine);
      }
    }

    return {
      ok: true,
      rows,
      disagreeing,
      table: formatTable(rows),
    };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}
