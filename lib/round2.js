// Panel round 2 (`consult-cli --round2 <out-dir>`): after a round-1 `--mode all --out-dir D` run, each engine that
// answered sees the other engines' round-1 answers (anonymised), critiques them and may revise. Meant only for
// questions where the round-1 answers conflict on a decision; the dissent lines are printed, never merged away.

import fs from "node:fs";
import path from "node:path";
import { ENGINE_NAMES, parseSpec } from "./engines.js";

const DEFAULT_WORD_CAP = 200;
const DEFAULT_CHARS = 6000;

/** Round-1 files in `dir` -> { prompt, answers: [{ label, body }] } (failed and non-engine files skipped). */
export function readRound1(dir) {
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  let prompt = "";
  try {
    prompt = read("_prompt.md").trim();
  } catch {
    /* caller may supply the prompt */
  }
  const answers = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md") && !n.startsWith("_")).sort()) {
    const m = /^## ([^\n]+)\n\n([\s\S]*)$/.exec(read(f).trim());
    if (!m || m[2].startsWith("[failed]")) continue;
    if (!ENGINE_NAMES.includes(parseSpec(m[1]).engine)) continue;
    answers.push({ label: m[1], body: m[2].trim() });
  }
  return { prompt, answers };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n[...cut]` : s);

/** Round-2 prompt for answer index `i`: the question, its own answer, the others as `Panelist N`. */
export function buildRound2Prompt(prompt, answers, i, { words = DEFAULT_WORD_CAP, chars = DEFAULT_CHARS } = {}) {
  const others = answers.filter((_, j) => j !== i).map((a, k) => `### Panelist ${k + 1}\n${clip(a.body, chars)}`);
  return [
    "You are in round 2 of a multi-model panel. Question:",
    clip(prompt, chars * 2),
    "",
    "## Your round-1 answer",
    clip(answers[i].body, chars),
    "",
    "## Other panelists' round-1 answers (anonymous)",
    others.join("\n\n"),
    "",
    `Reply in at most ${words} words. Critique the others' claims on substance (where they are wrong or you are), then say whether you revise your answer and what changed your mind. End with exactly these three lines:`,
    "REVISED: yes|no",
    "POSITION: <your final position in one sentence>",
    "DISSENT: <the points on which you still disagree with the others, or none>",
  ].join("\n");
}

/** Text of a `KEY:` line (rest of the line), or null. */
export function extractLine(body, key) {
  const m = new RegExp(`^\\s*\\**${key}\\**\\s*:\\**\\s*(.+)$`, "im").exec(body ?? "");
  return m ? m[1].trim() : null;
}

/** Compact dissent block for the caller: one line per answered engine (position, revised?, dissent). */
export function dissentBlock(results) {
  const rows = results.map((r) => {
    if (!r.ok) return `- ${r.engine}: (${r.skipped ? r.reason : "no round-2 answer"})`;
    return `- ${r.engine}: revised ${extractLine(r.body, "REVISED") ?? "?"} | position: ${extractLine(r.body, "POSITION") ?? "(missing)"} | dissent: ${extractLine(r.body, "DISSENT") ?? "(missing)"}`;
  });
  return `[consult] round 2 dissent (report it; never only the arbitrated verdict)\n${rows.join("\n")}`;
}
