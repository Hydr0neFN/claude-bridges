import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { readRound1, buildRound2Prompt, extractLine, dissentBlock } from "../lib/round2.js";
import { formatSection, writeEngineResult } from "../lib/panel.js";
import { parseArgs } from "../lib/args.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-r2-"));

test("readRound1: prompt, answered engines in file order; failed, _files and unknown labels skipped", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "_prompt.md"), "Should we use A or B?\n");
  writeEngineResult(d, "codex", { engine: "codex", ok: true, body: "Use A." });
  writeEngineResult(d, "copilot", { engine: "copilot", ok: true, body: "Use B." });
  writeEngineResult(d, "nim:z-ai/glm-5.3", { engine: "nim:z-ai/glm-5.3", ok: true, body: "Use A too." });
  writeEngineResult(d, "agy", { engine: "agy", ok: false, reason: "exit 1" });
  fs.writeFileSync(path.join(d, "_done"), "x");
  fs.writeFileSync(path.join(d, "notes.md"), "## bogus\n\ntext");
  const r = readRound1(d);
  assert.equal(r.prompt, "Should we use A or B?");
  assert.deepEqual(r.answers.map((a) => a.label), ["codex", "copilot", "nim:z-ai/glm-5.3"]);
  assert.equal(r.answers[0].body, "Use A.");
});

test("readRound1: missing prompt gives an empty string", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "codex.md"), formatSection({ engine: "codex", ok: true, body: "x" }));
  assert.equal(readRound1(d).prompt, "");
});

test("buildRound2Prompt: own answer, others anonymised, no engine names, caps", () => {
  const answers = [{ label: "codex", body: "Use A." }, { label: "copilot", body: "Use B." }, { label: "agy", body: "x".repeat(50) }];
  const p = buildRound2Prompt("Q?", answers, 1, { words: 120, chars: 10 });
  assert.match(p, /Q\?/);
  assert.match(p, /Your round-1 answer\nUse B\./);
  assert.match(p, /### Panelist 1\nUse A\./);
  assert.match(p, /### Panelist 2\nx{10}\n\[\.\.\.cut\]/);
  assert.match(p, /at most 120 words/);
  assert.match(p, /DISSENT:/);
  assert.ok(!/codex|copilot|agy/.test(p.replace(/panel/g, "")), "engine names must not leak");
  assert.ok(!p.split("## Other")[1].includes("Use B."), "own answer not repeated among the others");
});

test("extractLine / dissentBlock keep dissent visible", () => {
  assert.equal(extractLine("blah\n**DISSENT:** still prefer B\n", "DISSENT"), "still prefer B");
  assert.equal(extractLine("no such line", "DISSENT"), null);
  const out = dissentBlock([
    { engine: "codex", ok: true, body: "REVISED: no\nPOSITION: A\nDISSENT: copilot ignores cost" },
    { engine: "copilot", ok: true, body: "text only" },
    { engine: "agy", ok: false, reason: "boom" },
    { engine: "nim", ok: false, skipped: true, reason: "skipped: locked until x (y)" },
  ]);
  assert.match(out, /- codex: revised no \| position: A \| dissent: copilot ignores cost/);
  assert.match(out, /- copilot: revised \? \| position: \(missing\) \| dissent: \(missing\)/);
  assert.match(out, /- agy: \(no round-2 answer\)/);
  assert.match(out, /- nim: \(skipped: locked until x \(y\)\)/);
});

test("parseArgs: --round2 takes a dir", () => {
  assert.equal(parseArgs(["--round2", "/tmp/d"]).round2, "/tmp/d");
  assert.equal(parseArgs([]).round2, null);
});
