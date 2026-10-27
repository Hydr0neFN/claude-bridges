// Deterministic debate mode: round 1 stances run in parallel, an optional round 2
// rebuttal sees the other panelists' tails, then a compact digest is written.

import fs from "node:fs";
import path from "node:path";
import { ENGINE_NAMES, parseSpec } from "./engines.js";
import { safeFileName, writeDone } from "./panel.js";

const MAX_STANCES = 8;
const DEFAULT_WORD_CAP = 250;
const DEFAULT_REBUTTAL_CAP = 150;

const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** Engine spec ("copilot", "nim:model") is valid when its engine name is known. */
const validEngineSpec = (s) => typeof s === "string" && ENGINE_NAMES.includes(parseSpec(s).engine);

/** Normalise and validate a debate spec; throws a user-facing Error on misuse. */
export function validateSpec(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("spec must be a JSON object");

  const question = typeof obj.question === "string" ? obj.question.trim() : "";
  if (!question) throw new Error("spec.question must be a non-empty string");

  if (obj.context !== undefined && typeof obj.context !== "string") throw new Error("spec.context must be a string");
  const context = typeof obj.context === "string" ? obj.context.trim() : "";

  let contextFiles = [];
  if (obj.context_files !== undefined) {
    if (!Array.isArray(obj.context_files) || obj.context_files.some((f) => typeof f !== "string")) {
      throw new Error("spec.context_files must be an array of strings");
    }
    contextFiles = obj.context_files.map((f) => f.trim());
  }

  const wordCap = obj.word_cap === undefined ? DEFAULT_WORD_CAP : obj.word_cap;
  if (!isPosInt(wordCap)) throw new Error("spec.word_cap must be a positive integer");
  const rebuttalCap = obj.rebuttal_cap === undefined ? DEFAULT_REBUTTAL_CAP : obj.rebuttal_cap;
  if (!isPosInt(rebuttalCap)) throw new Error("spec.rebuttal_cap must be a positive integer");

  if (!Array.isArray(obj.stances) || obj.stances.length === 0) throw new Error("spec.stances must have at least 1 stance");
  if (obj.stances.length > MAX_STANCES) throw new Error(`spec.stances allows at most ${MAX_STANCES} stances`);

  const seen = new Set();
  const stances = obj.stances.map((st, i) => {
    const n = i + 1;
    if (!st || typeof st !== "object" || Array.isArray(st)) throw new Error(`stance ${n} must be an object`);
    const engine = typeof st.engine === "string" ? st.engine.trim() : "";
    if (!engine) throw new Error(`stance ${n}: engine is required`);
    if (!validEngineSpec(engine)) throw new Error(`stance ${n}: unknown engine "${engine}"`);
    if (seen.has(engine)) throw new Error(`duplicate engine label "${engine}"`);
    seen.add(engine);
    const stance = typeof st.stance === "string" ? st.stance.trim() : "";
    if (!stance) throw new Error(`stance ${n}: stance text is required`);
    let fallback = [];
    if (st.fallback !== undefined) {
      if (!Array.isArray(st.fallback) || st.fallback.some((f) => !validEngineSpec(f))) {
        throw new Error(`stance ${n}: fallback must be an array of valid engine specs`);
      }
      fallback = st.fallback.map((f) => f.trim());
    }
    return { engine, stance, fallback };
  });

  const rounds = obj.rounds === undefined ? 2 : obj.rounds;
  if (rounds !== 1 && rounds !== 2) throw new Error("spec.rounds must be 1 or 2");

  return { question, context, context_files: contextFiles, word_cap: wordCap, rebuttal_cap: rebuttalCap, stances, rounds };
}

/** Spec context plus file sections, each file and the whole capped; unreadable files become markers. */
export function loadContext(
  spec,
  { readFile = (p) => fs.readFileSync(p, "utf8"), perFileCap = 20000, totalCap = 60000 } = {},
) {
  const context = typeof spec.context === "string" ? spec.context.trim() : "";
  let out = context ? `${context}\n` : "";
  const files = Array.isArray(spec.context_files) ? spec.context_files : [];
  let omitted = 0;
  for (let i = 0; i < files.length; i++) {
    const file = String(files[i]);
    let content;
    try {
      content = String(readFile(file));
    } catch (e) {
      content = `[UNREADABLE: ${file}: ${e?.message || e}]`;
    }
    if (content.length > perFileCap) {
      content = `${content.slice(0, perFileCap)}\n[TRUNCATED: ${file} cut at ${perFileCap} chars]`;
    }
    const section = `### FILE: ${file}\n${content}${content.endsWith("\n") ? "" : "\n"}`;
    if (out.length + section.length > totalCap) {
      omitted = files.length - i;
      break;
    }
    out += section;
  }
  if (omitted) out += `[TRUNCATED: context cap reached, ${omitted} file(s) omitted]\n`;
  return out;
}

export const TAIL_INSTRUCTION =
  'End your reply with exactly this tail block (labels in capitals, at most 3 claims, each bullet starting "- "):\n' +
  "CLAIMS:\n- <claim>\nCONCEDES: <one line>\nBOTTOM LINE: <one line>";

const stanceText = (stance) => (typeof stance === "string" ? stance : stance.stance);
const stanceLabel = (stance) => (typeof stance === "string" ? stance : stance.engine);

/** Round-1 prompt: context, question, stance, word cap, tail block. Self-contained. */
export function buildR1Prompt(spec, stance, ctx) {
  const parts = [
    "You are one panelist in a structured debate. You have no file access; answer from the text given here only.",
  ];
  if (ctx) parts.push(`CONTEXT:\n${ctx.trim()}`);
  parts.push(`QUESTION:\n${spec.question}`);
  parts.push(`YOUR STANCE:\n${stanceText(stance)}`);
  parts.push(`LIMIT: at most ${spec.word_cap} words before the tail block.`);
  parts.push(TAIL_INSTRUCTION);
  return `${parts.join("\n\n")}\n`;
}

/** Round-2 prompt: same frame plus the other answered panelists' round-1 tails and a final pick line. */
export function buildR2Prompt(spec, stance, ctx, others) {
  const self = stanceLabel(stance);
  const selfLabel = typeof stance === "object" && stance ? stance.label : null;
  const list = (others || []).filter((o) => o.label !== self && o.label !== selfLabel);
  const parts = [
    "You are one panelist in a structured debate. You have no file access; answer from the text given here only.",
  ];
  if (ctx) parts.push(`CONTEXT:\n${ctx.trim()}`);
  parts.push(`QUESTION:\n${spec.question}`);
  parts.push(`YOUR STANCE:\n${stanceText(stance)}`);
  parts.push(
    `OTHER PANELISTS' ROUND-1 POSITIONS:\n${list.length ? list.map((o) => `[${o.label}]\n${o.tail}`).join("\n\n") : "(none)"}`,
  );
  parts.push("Rebut or concede honestly. If another panelist is right, change your mind.");
  parts.push(`LIMIT: at most ${spec.rebuttal_cap} words.`);
  parts.push(TAIL_INSTRUCTION);
  parts.push("Your very last line must be:\nFINAL PICK: <option> - <one line reason>");
  return `${parts.join("\n\n")}\n`;
}

const LABEL_RE =
  /^\s*(?:[#>*+\-]\s*)*(?:\*\*)?\s*(CLAIMS|CONCEDES|BOTTOM[\s-]*LINE)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$/i;
const FINAL_RE = /^\s*(?:[#>*+\-]\s*)*(?:\*\*)?\s*FINAL\s+PICK\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$/i;

const labelKind = (s) => {
  const u = s.toUpperCase();
  if (u.startsWith("CLAIMS")) return "claims";
  if (u.startsWith("CONCEDES")) return "concedes";
  return "bottomLine";
};

const stripBold = (s) => String(s).replace(/^\*\*/, "").replace(/\*\*$/, "").trim();

function parseClaims(raw) {
  const claims = [];
  for (const line of raw) {
    const m = line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/);
    if (m) {
      const claim = stripBold(m[1]);
      if (claim) claims.push(claim);
    } else if (claims.length) {
      claims[claims.length - 1] += ` ${stripBold(line)}`;
    } else {
      const claim = stripBold(line);
      if (claim) claims.push(claim);
    }
  }
  return claims;
}

const oneLine = (raw) => {
  const line = raw.map((l) => stripBold(l.replace(/^(?:[-*+]\s+)/, ""))).find(Boolean);
  return line || "";
};

/** Tolerant tail parser; the last CLAIMS block wins, prose mentions only match when label-led. */
export function extractTail(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(LABEL_RE);
    if (m) hits.push({ kind: labelKind(m[1]), inline: stripBold(m[2]), i });
  });
  if (!hits.length) return null;

  const blockFor = (hit) => {
    const next = hits.find((h) => h.i > hit.i);
    const end = next ? next.i : lines.length;
    const raw = hit.inline ? [hit.inline] : [];
    for (let j = hit.i + 1; j < end; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (FINAL_RE.test(line)) break;
      raw.push(line);
    }
    return raw;
  };
  const lastOf = (kind) => hits.filter((h) => h.kind === kind).at(-1);

  const claimsHit = lastOf("claims");
  const concedesHit = lastOf("concedes");
  const bottomHit = lastOf("bottomLine");
  const claims = claimsHit ? parseClaims(blockFor(claimsHit)) : [];
  const concedes = concedesHit ? oneLine(blockFor(concedesHit)) : "";
  const bottomLine = bottomHit ? oneLine(blockFor(bottomHit)) : "";
  const text = [
    "CLAIMS:",
    claims.length ? claims.map((c) => `- ${c}`).join("\n") : "(none)",
    `CONCEDES: ${concedes || "(none)"}`,
    `BOTTOM LINE: ${bottomLine || "(none)"}`,
  ].join("\n");
  return { claims, concedes, bottomLine, text };
}

/** Last FINAL PICK line, tolerant of bold/case/leading markers; text after the colon. */
export function extractFinalPick(body) {
  let pick = null;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = line.match(FINAL_RE);
    if (m) pick = m[1].replace(/\*\*/g, "").trim();
  }
  return pick;
}

/** Last `n` words joined by single spaces. */
export function lastWords(body, n = 120) {
  if (!(n > 0)) return "";
  const words = String(body ?? "").trim().split(/\s+/).filter(Boolean);
  return words.slice(-n).join(" ");
}

const answered = (r) => Boolean(r && r.ok && !r.degraded);
const failureReason = (r) => (r && r.reason) || (r && r.degraded ? "reasoning only, no final answer" : "unknown failure");

async function callRun(run, engineSpec, prompt) {
  try {
    const r = await run(engineSpec, prompt);
    return r && typeof r === "object" ? r : { ok: false, reason: "no result" };
  } catch (e) {
    return { ok: false, reason: `crashed: ${e?.message || e}` };
  }
}

function writeTextFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`);
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

const optionKey = (pick) => String(pick).replace(/\*\*/g, "").split(" - ")[0].trim().toLowerCase();

/** TALLY line: final-pick option counts plus the labels that produced no pick. */
export function tallyLine(records) {
  const counts = new Map();
  const noPick = [];
  for (const r of records) {
    const pick = r.r2 && r.r2.finalPick;
    const key = pick ? optionKey(pick) : "";
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
    else noPick.push(r.label);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`);
  const body = ranked.join(" ") || (noPick.length ? "" : "(no picks)");
  return `TALLY:${body ? ` ${body}` : ""}${noPick.length ? ` (no pick: ${noPick.join(", ")})` : ""}`;
}

/** Compact digest: question, stances, per-engine tails, files, tally. Never full bodies. */
export function buildDigest(spec, records, { skippedR2 = false } = {}) {
  const out = ["# Debate digest", ""];
  out.push(`QUESTION: ${String(spec.question ?? "").slice(0, 300)}`, "");
  out.push("STANCES:");
  for (const st of spec.stances || []) out.push(`- ${st.engine}: ${String(st.stance ?? "").slice(0, 80)}`);
  out.push("");

  const ok = records.filter((r) => r.r1.status === "ok").map((r) => r.label);
  const bad = records.filter((r) => r.r1.status !== "ok").map((r) => `${r.label} (${r.r1.reason || "failed"})`);
  out.push(`Answered R1: ${ok.join(", ") || "(none)"}${bad.length ? ` | Failed: ${bad.join(", ")}` : ""}`);
  if (skippedR2) out.push("R2 skipped: fewer than 2 engines answered R1.");
  out.push("");

  for (const r of records) {
    out.push(`## ${r.label}`);
    if (r.r1.status !== "ok") out.push(`R1: ENGINE_FAILED: ${r.r1.reason || "failed"}`);
    else out.push(r.r1.tail ? `R1:\n${r.r1.tail.text}` : "R1: TAIL_MISSING");
    if (r.r2) {
      if (r.r2.status !== "ok") out.push(`R2: ENGINE_FAILED: ${r.r2.reason || "failed"}`);
      else out.push(r.r2.tail ? `R2:\n${r.r2.tail.text}` : "R2: TAIL_MISSING");
      if (r.r2.finalPick) out.push(`FINAL PICK: ${r.r2.finalPick}`);
    } else if (r.r1.status !== "ok") {
      out.push("R2: (not run: R1 failed)");
    } else if (skippedR2) {
      out.push("R2: (skipped: fewer than 2 answered R1)");
    } else {
      out.push("R2: (not run: rounds=1)");
    }
    out.push(`Files: ${r.files?.length ? r.files.join(" ") : "(none)"}`);
    out.push("");
  }

  out.push(tallyLine(records));
  return `${out.join("\n")}\n`;
}

/**
 * Run both rounds and write r1/, r2/, digest.md and (last) _done.
 * `run(engineSpec, prompt)` is injected so tests never touch the network.
 */
export async function runDebate({ spec, outDir, run, ctx = "", writeDoneFile = true }) {
  const s = validateSpec(spec);
  const r1Dir = path.join(outDir, "r1");
  const r2Dir = path.join(outDir, "r2");
  const usedEngines = new Set(s.stances.map((st) => parseSpec(st.engine).engine));

  const prompts = s.stances.map((st) => buildR1Prompt(s, st, ctx));
  prompts.forEach((p, i) => writeTextFile(path.join(r1Dir, `${safeFileName(s.stances[i].engine)}.prompt.md`), p));
  const primary = await Promise.all(s.stances.map((st, i) => callRun(run, st.engine, prompts[i])));

  const entries = [];
  for (let i = 0; i < s.stances.length; i++) {
    const st = s.stances[i];
    let result = primary[i];
    let label = st.engine;
    let fileBase = safeFileName(st.engine);
    let engineSpec = st.engine;
    if (!answered(result) && st.fallback.length) {
      const fb = st.fallback.find((f) => !usedEngines.has(parseSpec(f).engine));
      if (fb) {
        usedEngines.add(parseSpec(fb).engine);
        const fbBase = `${safeFileName(fb)}-for-${safeFileName(st.engine)}`;
        writeTextFile(path.join(r1Dir, `${fbBase}.prompt.md`), prompts[i]);
        result = await callRun(run, fb, prompts[i]);
        label = `${fb} (for ${st.engine})`;
        fileBase = fbBase;
        engineSpec = fb;
      }
    }
    const ok = answered(result);
    const body = ok ? String(result.body ?? "") : `ENGINE_FAILED: ${failureReason(result)}`;
    writeTextFile(path.join(r1Dir, `${fileBase}.md`), body);
    entries.push({ stance: st, label, fileBase, engineSpec, result, ok, body });
  }

  const records = entries.map((e) => {
    const tail = e.ok ? extractTail(e.body) : null;
    const r1 = { status: e.ok ? "ok" : "failed", tail, tailMissing: e.ok ? !tail : false };
    if (!e.ok) r1.reason = failureReason(e.result);
    return {
      label: e.label,
      served: (e.result && e.result.engine) || e.engineSpec,
      r1,
      r2: null,
      files: [`r1/${e.fileBase}.md`],
    };
  });

  const answeredEntries = entries.filter((e) => e.ok);
  const skippedR2 = s.rounds >= 2 && answeredEntries.length < 2;
  if (s.rounds >= 2 && answeredEntries.length >= 2) {
    const tailOf = (e) => extractTail(e.body)?.text ?? `(tail missing; last words) ${lastWords(e.body)}`;
    const r2Raw = await Promise.all(
      entries.map(async (e) => {
        if (!e.ok) return null;
        const others = answeredEntries.filter((o) => o !== e).map((o) => ({ label: o.label, tail: tailOf(o) }));
        const prompt = buildR2Prompt(s, e.stance, ctx, others);
        writeTextFile(path.join(r2Dir, `${e.fileBase}.prompt.md`), prompt);
        const result = await callRun(run, e.engineSpec, prompt);
        return { result, prompt };
      }),
    );
    entries.forEach((e, idx) => {
      const got = r2Raw[idx];
      if (!got) return;
      const ok = answered(got.result);
      const body = ok ? String(got.result.body ?? "") : `ENGINE_FAILED: ${failureReason(got.result)}`;
      writeTextFile(path.join(r2Dir, `${e.fileBase}.md`), body);
      const tail = ok ? extractTail(body) : null;
      const r2 = { status: ok ? "ok" : "failed", tail, tailMissing: ok ? !tail : false, finalPick: ok ? extractFinalPick(body) : null };
      if (!ok) r2.reason = failureReason(got.result);
      records[idx].r2 = r2;
      records[idx].files.push(`r2/${e.fileBase}.md`);
    });
  }

  const digestPath = path.join(outDir, "digest.md");
  writeAtomic(digestPath, buildDigest(s, records, { skippedR2 }));
  const tally = tallyLine(records);
  if (writeDoneFile) writeDone(outDir, tally);
  return { digestPath, tally, records };
}
