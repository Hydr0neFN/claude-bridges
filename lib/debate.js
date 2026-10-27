// Deterministic debate mode: round 1 stances run in parallel, an optional round 2
// rebuttal sees the other panelists' tails (anonymised as Debater N, no tally), an optional
// round 3 cross-examines only the claims of debaters whose pick differs, then a compact
// digest with a per-engine pick trajectory is written.

import fs from "node:fs";
import path from "node:path";
import { ENGINE_NAMES, parseSpec } from "./engines.js";
import { safeFileName, writeDone } from "./panel.js";

const MAX_STANCES = 8;
const DEFAULT_WORD_CAP = 250;
const DEFAULT_REBUTTAL_CAP = 150;
const DEFAULT_CROSS_CAP = 100;

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
  const crossCap = obj.cross_cap === undefined ? DEFAULT_CROSS_CAP : obj.cross_cap;
  if (!isPosInt(crossCap)) throw new Error("spec.cross_cap must be a positive integer");

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
  if (![1, 2, 3].includes(rounds)) throw new Error("spec.rounds must be 1, 2 or 3");

  return {
    question,
    context,
    context_files: contextFiles,
    word_cap: wordCap,
    rebuttal_cap: rebuttalCap,
    cross_cap: crossCap,
    stances,
    rounds,
  };
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

// Rounds 2 and 3 also ask why the pick moved and what would move it (anti-herding).
export const REASON_INSTRUCTION =
  "CHANGED BECAUSE: <which Debater's claim moved you, e.g. 'Debater 2 claim 1', or the word unchanged>\n" +
  "WOULD CHANGE MY MIND IF: <one line>";
const FINAL_PICK_INSTRUCTION = "Your very last line must be:\nFINAL PICK: <option> - <one line reason>";
const INTRO =
  "You are one panelist in a structured debate. You have no file access; answer from the text given here only.";

const stanceText = (stance) => (typeof stance === "string" ? stance : stance.stance);
const stanceLabel = (stance) => (typeof stance === "string" ? stance : stance.engine);

/** Round-1 prompt: context, question, stance, word cap, tail block, final pick. Self-contained. */
export function buildR1Prompt(spec, stance, ctx) {
  const parts = [INTRO];
  if (ctx) parts.push(`CONTEXT:\n${ctx.trim()}`);
  parts.push(`QUESTION:\n${spec.question}`);
  parts.push(`YOUR STANCE:\n${stanceText(stance)}`);
  parts.push(`LIMIT: at most ${spec.word_cap} words before the tail block.`);
  parts.push(TAIL_INSTRUCTION);
  parts.push(
    "Your very last line must be your opening pick, using the option names from the question:\nFINAL PICK: <option> - <one line reason>",
  );
  return `${parts.join("\n\n")}\n`;
}

/**
 * Round-2 prompt: the other answered panelists' round-1 tails as `Debater N` (no engine names,
 * no tally), a rebut-or-concede instruction, the reason lines and a final pick line.
 * Each other entry is {label, tail, n?}; n is the stable debater number.
 */
export function buildR2Prompt(spec, stance, ctx, others) {
  const self = stanceLabel(stance);
  const selfLabel = typeof stance === "object" && stance ? stance.label : null;
  const list = (others || []).filter((o) => o.label !== self && o.label !== selfLabel);
  const parts = [INTRO];
  if (ctx) parts.push(`CONTEXT:\n${ctx.trim()}`);
  parts.push(`QUESTION:\n${spec.question}`);
  parts.push(`YOUR STANCE:\n${stanceText(stance)}`);
  parts.push(
    `OTHER PANELISTS' ROUND-1 POSITIONS:\n${
      list.length ? list.map((o, i) => `[Debater ${o.n ?? i + 1}]\n${o.tail}`).join("\n\n") : "(none)"
    }`,
  );
  parts.push(
    "Rebut or concede honestly. Change your mind only if a specific claim above convinces you; " +
      "that others agree or disagree with you is not evidence.",
  );
  parts.push(`LIMIT: at most ${spec.rebuttal_cap} words.`);
  parts.push(`${TAIL_INSTRUCTION}\n${REASON_INSTRUCTION}`);
  parts.push(FINAL_PICK_INSTRUCTION);
  return `${parts.join("\n\n")}\n`;
}

/**
 * Round-3 cross-examination prompt: only the claims of debaters whose final pick differs.
 * opponents: [{n, pick, claims}] (anonymised); ownPick is this debater's current pick.
 */
export function buildR3Prompt(spec, stance, ctx, opponents, ownPick) {
  const parts = [INTRO];
  if (ctx) parts.push(`CONTEXT:\n${ctx.trim()}`);
  parts.push(`QUESTION:\n${spec.question}`);
  parts.push(`YOUR STANCE:\n${stanceText(stance)}`);
  parts.push(`YOUR CURRENT PICK:\n${ownPick || "(none)"}`);
  parts.push(
    `OPPONENTS (their picks differ from yours):\n${opponents
      .map((o) => `[Debater ${o.n}] PICK: ${o.pick}\n${o.claims}`)
      .join("\n\n")}`,
  );
  parts.push(
    "CROSS-EXAMINATION: answer only these claims. Name the weakest opponent claim and say why it fails, " +
      "or concede it. Change your pick only if a specific claim convinces you; do not change it because " +
      "others disagree.",
  );
  parts.push(`LIMIT: at most ${spec.cross_cap ?? DEFAULT_CROSS_CAP} words before the closing lines.`);
  parts.push(`Then add exactly these lines:\n${REASON_INSTRUCTION}`);
  parts.push(FINAL_PICK_INSTRUCTION);
  return `${parts.join("\n\n")}\n`;
}

const LABEL_RE =
  /^\s*(?:[#>*+\-]\s*)*(?:\*\*)?\s*(CLAIMS|CONCEDES|BOTTOM[\s-]*LINE|CHANGED\s+BECAUSE|WOULD\s+CHANGE\s+MY\s+MIND\s+IF)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$/i;
const FINAL_RE = /^\s*(?:[#>*+\-]\s*)*(?:\*\*)?\s*FINAL\s+PICK\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$/i;

const labelKind = (s) => {
  const u = s.toUpperCase();
  if (u.startsWith("CLAIMS")) return "claims";
  if (u.startsWith("CONCEDES")) return "concedes";
  if (u.startsWith("CHANGED")) return "changedBecause";
  if (u.startsWith("WOULD")) return "wouldChange";
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
  const changedHit = lastOf("changedBecause");
  const wouldHit = lastOf("wouldChange");
  const claims = claimsHit ? parseClaims(blockFor(claimsHit)) : [];
  const concedes = concedesHit ? oneLine(blockFor(concedesHit)) : "";
  const bottomLine = bottomHit ? oneLine(blockFor(bottomHit)) : "";
  const changedBecause = changedHit ? oneLine(blockFor(changedHit)) : "";
  const wouldChange = wouldHit ? oneLine(blockFor(wouldHit)) : "";
  const text = [
    "CLAIMS:",
    claims.length ? claims.map((c) => `- ${c}`).join("\n") : "(none)",
    `CONCEDES: ${concedes || "(none)"}`,
    `BOTTOM LINE: ${bottomLine || "(none)"}`,
    ...(changedHit ? [`CHANGED BECAUSE: ${changedBecause || "(none)"}`] : []),
    ...(wouldHit ? [`WOULD CHANGE MY MIND IF: ${wouldChange || "(none)"}`] : []),
  ].join("\n");
  return { claims, concedes, bottomLine, changedBecause, wouldChange, text };
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

const PICK_SPLIT = /\s[-–—]\s/;
const cleanPick = (pick) => String(pick ?? "").replace(/\*\*/g, "").trim();
const pickOption = (pick) => cleanPick(pick).split(PICK_SPLIT)[0].trim();
const optionKey = (pick) =>
  pickOption(pick)
    .toLowerCase()
    .replace(/^option\s+/, "")
    .replace(/[.:]+$/, "");
const latestPick = (r) => (r.r3 && r.r3.finalPick) || (r.r2 && r.r2.finalPick) || null;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

/** TALLY line: latest final-pick option counts plus the labels that produced no pick. */
export function tallyLine(records) {
  const counts = new Map();
  const noPick = [];
  for (const r of records) {
    const pick = latestPick(r);
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

/**
 * Pick trajectory for one record, e.g. `nim: D -> A -> A (R2 changed: Debater 2 claim 1)`.
 * A pick that moved without a stated reason is flagged NO REASON GIVEN. null when R1 failed or no pick exists.
 */
export function trajectoryLine(r) {
  if (!r.r1 || r.r1.status !== "ok") return null;
  const steps = [{ round: "R1", rec: r.r1 }];
  if (r.r2) steps.push({ round: "R2", rec: r.r2 });
  if (r.r3) steps.push({ round: "R3", rec: r.r3 });
  if (!steps.some((s) => s.rec.finalPick)) return null;

  const notes = [];
  let prevKey = "";
  steps.forEach((s, i) => {
    const key = s.rec.finalPick ? optionKey(s.rec.finalPick) : "";
    if (i > 0 && prevKey && key && key !== prevKey) {
      const why = s.rec.changedBecause;
      const flagged = !why || /^["'`]?unchanged\b/i.test(why);
      notes.push(`${s.round} changed: ${flagged ? "NO REASON GIVEN" : clip(why, 80)}`);
    }
    if (key) prevKey = key;
  });
  const path = steps.map((s) => (s.rec.finalPick ? pickOption(s.rec.finalPick) || "?" : "?")).join(" -> ");
  return `${r.label}: ${path}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/** Compact digest: question, stances, per-engine tails, files, trajectories, tally. Never full bodies. */
export function buildDigest(spec, records, { skippedR2 = false, skippedR3 = null } = {}) {
  const out = ["# Debate digest", ""];
  out.push(`QUESTION: ${String(spec.question ?? "").slice(0, 300)}`, "");
  out.push("STANCES:");
  for (const st of spec.stances || []) out.push(`- ${st.engine}: ${String(st.stance ?? "").slice(0, 80)}`);
  out.push("");

  const ok = records.filter((r) => r.r1.status === "ok").map((r) => r.label);
  const bad = records.filter((r) => r.r1.status !== "ok").map((r) => `${r.label} (${r.r1.reason || "failed"})`);
  out.push(`Answered R1: ${ok.join(", ") || "(none)"}${bad.length ? ` | Failed: ${bad.join(", ")}` : ""}`);
  if ((spec.rounds ?? 1) >= 2) {
    out.push(`Debaters (as seen by the panel): ${records.map((r, i) => `${i + 1}=${r.label}`).join(" ")}`);
  }
  if (skippedR2) out.push("R2 skipped: fewer than 2 engines answered R1.");
  if (skippedR3) out.push(`R3 skipped: ${skippedR3}.`);
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
    if (r.r3) {
      if (r.r3.status !== "ok") out.push(`R3: ENGINE_FAILED: ${r.r3.reason || "failed"}`);
      else if (!r.r3.changedBecause && !r.r3.wouldChange) out.push("R3: TAIL_MISSING");
      else {
        out.push(`R3: CHANGED BECAUSE: ${r.r3.changedBecause || "(none)"}`);
        out.push(`R3: WOULD CHANGE MY MIND IF: ${r.r3.wouldChange || "(none)"}`);
      }
      if (r.r3.finalPick) out.push(`R3 FINAL PICK: ${r.r3.finalPick}`);
    }
    out.push(`Files: ${r.files?.length ? r.files.join(" ") : "(none)"}`);
    out.push("");
  }

  const traj = records.map(trajectoryLine).filter(Boolean);
  if (traj.length) out.push("TRAJECTORY (R1 -> R2 -> R3):", ...traj, "");
  out.push(tallyLine(records));
  return `${out.join("\n")}\n`;
}

/** What an opponent says, for the round-3 prompt: claims, else bottom line, else the last words. */
const opponentClaims = (rec, body) => {
  const t = rec.r2 && rec.r2.tail;
  if (t && t.claims.length) return t.claims.map((c) => `- ${c}`).join("\n");
  if (t && t.bottomLine) return `- ${t.bottomLine}`;
  return `(no structured claims; last words) ${lastWords(body)}`;
};

/**
 * Run up to three rounds and write r1/, r2/, r3/, digest.md and (last) _done.
 * `run(engineSpec, prompt)` is injected so tests never touch the network.
 */
export async function runDebate({ spec, outDir, run, ctx = "", writeDoneFile = true }) {
  const s = validateSpec(spec);
  const r1Dir = path.join(outDir, "r1");
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
    entries.push({ stance: st, label, fileBase, engineSpec, result, ok, body, n: i + 1 });
  }

  const records = entries.map((e) => {
    const tail = e.ok ? extractTail(e.body) : null;
    const r1 = { status: e.ok ? "ok" : "failed", tail, tailMissing: e.ok ? !tail : false };
    if (e.ok) r1.finalPick = extractFinalPick(e.body);
    else r1.reason = failureReason(e.result);
    return {
      label: e.label,
      served: (e.result && e.result.engine) || e.engineSpec,
      r1,
      r2: null,
      r3: null,
      files: [`r1/${e.fileBase}.md`],
    };
  });

  /** Run one follow-up round for `active` entries in parallel; returns [{ e, rec, body }]. */
  const runRound = async (dirName, active, promptFor) => {
    const dir = path.join(outDir, dirName);
    const raw = await Promise.all(
      active.map(async (e) => {
        const prompt = promptFor(e);
        writeTextFile(path.join(dir, `${e.fileBase}.prompt.md`), prompt);
        return { e, result: await callRun(run, e.engineSpec, prompt) };
      }),
    );
    return raw.map(({ e, result }) => {
      const ok = answered(result);
      const body = ok ? String(result.body ?? "") : `ENGINE_FAILED: ${failureReason(result)}`;
      writeTextFile(path.join(dir, `${e.fileBase}.md`), body);
      const tail = ok ? extractTail(body) : null;
      const rec = {
        status: ok ? "ok" : "failed",
        tail,
        tailMissing: ok ? !tail : false,
        finalPick: ok ? extractFinalPick(body) : null,
        changedBecause: tail ? tail.changedBecause : "",
        wouldChange: tail ? tail.wouldChange : "",
      };
      if (!ok) rec.reason = failureReason(result);
      return { e, rec, body };
    });
  };

  const answeredEntries = entries.filter((e) => e.ok);
  const skippedR2 = s.rounds >= 2 && answeredEntries.length < 2;
  const r2Bodies = new Map();
  if (s.rounds >= 2 && !skippedR2) {
    const tailOf = (e) => extractTail(e.body)?.text ?? `(tail missing; last words) ${lastWords(e.body)}`;
    const done = await runRound("r2", answeredEntries, (e) => {
      const others = answeredEntries.filter((o) => o !== e).map((o) => ({ label: o.label, tail: tailOf(o), n: o.n }));
      return buildR2Prompt(s, e.stance, ctx, others);
    });
    for (const { e, rec, body } of done) {
      records[e.n - 1].r2 = rec;
      records[e.n - 1].files.push(`r2/${e.fileBase}.md`);
      r2Bodies.set(e.n, body);
    }
  }

  let skippedR3 = null;
  if (s.rounds >= 3) {
    const picks = entries
      .filter((e) => records[e.n - 1].r2 && records[e.n - 1].r2.finalPick)
      .map((e) => ({ e, pick: records[e.n - 1].r2.finalPick, key: optionKey(records[e.n - 1].r2.finalPick) }))
      .filter((p) => p.key);
    if (skippedR2) skippedR3 = "R2 did not run";
    else if (picks.length < 2) skippedR3 = "fewer than 2 debaters gave an R2 FINAL PICK";
    else if (new Set(picks.map((p) => p.key)).size < 2) skippedR3 = "R2 FINAL PICKs agree, no cross-examination needed";
    else {
      const done = await runRound("r3", picks.map((p) => p.e), (e) => {
        const me = picks.find((p) => p.e === e);
        const opponents = picks
          .filter((p) => p.key !== me.key)
          .map((p) => ({ n: p.e.n, pick: p.pick, claims: opponentClaims(records[p.e.n - 1], r2Bodies.get(p.e.n)) }));
        return buildR3Prompt(s, e.stance, ctx, opponents, me.pick);
      });
      for (const { e, rec } of done) {
        records[e.n - 1].r3 = rec;
        records[e.n - 1].files.push(`r3/${e.fileBase}.md`);
      }
    }
  }

  const digestPath = path.join(outDir, "digest.md");
  writeAtomic(digestPath, buildDigest(s, records, { skippedR2, skippedR3 }));
  const tally = tallyLine(records);
  if (writeDoneFile) writeDone(outDir, tally);
  return { digestPath, tally, records, skippedR3 };
}
