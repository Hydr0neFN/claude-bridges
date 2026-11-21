import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseArgs } from "../lib/args.js";
import { scorePanel, formatScoreOutput } from "../lib/panel-score.js";

const FIVE_ANSWERS = [
  { engine: "copilot", text: "Use PostgreSQL because ACID transactions and relational joins fit the schema." },
  { engine: "codex", text: "PostgreSQL is the right fit here due to strong consistency and SQL support." },
  { engine: "deepseek", text: "Go with PostgreSQL; relational integrity and indexing make queries straightforward." },
  {
    engine: "nim",
    text: `Use MongoDB instead of PostgreSQL because schema flexibility matters more here. ${"x".repeat(400)}`,
  },
  { engine: "openrouter", text: "Probably PostgreSQL, though it depends on write throughput." },
];

const CANNED_RESPONSE = {
  "copilot.agrees_with_majority": { p: 0.94, confidence: 0.92, escalate: false },
  "copilot.quality": { score: 3, confidence: 0.9, escalate: false },
  "codex.agrees_with_majority": { p: 0.89, confidence: 0.85, escalate: false },
  "codex.quality": { score: 2, confidence: 0.8, escalate: false },
  "deepseek.agrees_with_majority": { p: 0.82, confidence: 0.8, escalate: false },
  "deepseek.quality": { score: 2, confidence: 0.78, escalate: false },
  "nim.agrees_with_majority": { p: 0.12, confidence: 0.88, escalate: false },
  "nim.quality": { score: 1, confidence: 0.75, escalate: false },
  "openrouter.agrees_with_majority": { p: 0.55, confidence: 0.4, escalate: true },
  "openrouter.quality": null,
  _meta: { kind: "panel_score" },
};

test("scorePanel: happy path builds table, rows, disagreeing list, and 300-char snippet", async () => {
  const res = await scorePanel(
    { prompt: "Which database should we pick?", answers: FIVE_ANSWERS },
    { run: async () => ({ ok: true, stdout: `${JSON.stringify(CANNED_RESPONSE)}\n` }) },
  );

  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 5);
  assert.deepEqual(res.disagreeing, ["nim"]);

  const copilot = res.rows.find((r) => r.engine === "copilot");
  assert.equal(copilot.agrees, "y");
  assert.equal(copilot.quality, 3);
  assert.equal(copilot.quality_label, "strong");

  const nim = res.rows.find((r) => r.engine === "nim");
  assert.equal(nim.agrees, "n");
  assert.equal(nim.agrees_p, 0.12);
  assert.equal(nim.quality, 1);
  assert.equal(nim.quality_label, "weak");

  const openrouter = res.rows.find((r) => r.engine === "openrouter");
  assert.equal(openrouter.agrees, "?");
  assert.equal(openrouter.quality, null);
  assert.equal(openrouter.quality_label, "?");
  assert.equal(openrouter.escalate, true);

  assert.match(res.table, /copilot\s+y\s+strong/);
  assert.match(res.table, /nim\s+n\s+weak/);
  assert.match(res.table, /openrouter\s+\?\s+\?/);

  const printed = formatScoreOutput(res, FIVE_ANSWERS);
  assert.match(printed, /Disagreeing points:/);
  assert.ok(printed.includes(FIVE_ANSWERS[3].text.slice(0, 300)));
  assert.ok(!printed.includes("x".repeat(350)));
});

test("scorePanel: low-confidence disagreement (confidence < 0.7) is not listed in disagreeing", async () => {
  const lowConf = {
    ...CANNED_RESPONSE,
    "nim.agrees_with_majority": { p: 0.2, confidence: 0.65, escalate: false },
  };
  const res = await scorePanel(
    { prompt: "Pick DB", answers: FIVE_ANSWERS },
    { run: async () => JSON.stringify(lowConf) },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.disagreeing, []);
  const printed = formatScoreOutput(res, FIVE_ANSWERS);
  assert.ok(!printed.includes("Disagreeing points:"));
});

test("scorePanel: questions JSON shape (10 keys, types, criteria) and CLI args", async () => {
  let seenCmd = null;
  let seenArgs = null;
  let seenQuestions = null;
  let seenInput = null;

  const longAnswers = FIVE_ANSWERS.map((a, i) =>
    i === 0 ? { ...a, text: "A".repeat(6500) } : a,
  );

  const res = await scorePanel(
    { prompt: "Original prompt here", answers: longAnswers },
    {
      python: "python-custom",
      decidePy: "/opt/decide.py",
      run: async (cmd, argv) => {
        seenCmd = cmd;
        seenArgs = argv;
        const qIdx = argv.indexOf("--questions-json");
        const iIdx = argv.indexOf("--input-file");
        seenQuestions = JSON.parse(fs.readFileSync(argv[qIdx + 1], "utf8"));
        seenInput = fs.readFileSync(argv[iIdx + 1], "utf8");
        return { ok: true, stdout: JSON.stringify(CANNED_RESPONSE) };
      },
    },
  );

  assert.equal(res.ok, true);
  assert.equal(seenCmd, "python-custom");
  assert.deepEqual(seenArgs.slice(0, 4), ["/opt/decide.py", "many", "--kind", "panel_score"]);
  assert.ok(seenArgs.includes("--public"));

  const keys = Object.keys(seenQuestions);
  assert.equal(keys.length, 10);
  for (const { engine } of FIVE_ANSWERS) {
    const ag = seenQuestions[`${engine}.agrees_with_majority`];
    assert.equal(ag.type, "noul");
    assert.equal(
      ag.instructions,
      `Does the answer of member ${engine} reach the same main conclusion as the majority of the other members?`,
    );

    const ql = seenQuestions[`${engine}.quality`];
    assert.equal(ql.type, "score");
    assert.deepEqual(ql.criteria, ["wrong", "weak", "ok", "strong"]);
    assert.equal(typeof ql.instructions, "string");
    assert.ok(ql.instructions.length > 0);
  }

  assert.ok(seenInput.startsWith("Original prompt here\n\n=== copilot ===\n"));
  assert.ok(!seenInput.includes("A".repeat(6001)));
  assert.ok(seenInput.includes("A".repeat(6000)));
});

test("scorePanel: fewer than 3 answers returns ok:false without spawning", async () => {
  let called = false;
  const res = await scorePanel(
    { prompt: "p", answers: FIVE_ANSWERS.slice(0, 2) },
    { run: async () => { called = true; return "{}"; } },
  );
  assert.deepEqual(res, { ok: false, reason: "fewer than 3 answers" });
  assert.equal(called, false);
});

test("scorePanel: decide failure (throw, non-zero exit, bad JSON, _meta.error) returns ok:false", async () => {
  const rThrow = await scorePanel(
    { prompt: "p", answers: FIVE_ANSWERS },
    { run: async () => { throw new Error("spawn ENOENT"); } },
  );
  assert.equal(rThrow.ok, false);
  assert.match(rThrow.reason, /ENOENT/);

  const rFail = await scorePanel(
    { prompt: "p", answers: FIVE_ANSWERS },
    { run: async () => ({ ok: false, reason: "timed out after 60000ms" }) },
  );
  assert.equal(rFail.ok, false);
  assert.match(rFail.reason, /timed out/);

  const rBadJson = await scorePanel(
    { prompt: "p", answers: FIVE_ANSWERS },
    { run: async () => ({ ok: true, stdout: "not json" }) },
  );
  assert.equal(rBadJson.ok, false);

  const rMetaErr = await scorePanel(
    { prompt: "p", answers: FIVE_ANSWERS },
    { run: async () => ({ ok: true, stdout: JSON.stringify({ _meta: { error: "missing key" } }) }) },
  );
  assert.deepEqual(rMetaErr, { ok: false, reason: "missing key" });
});

test("parseArgs: --score sets score flag and defaults to false", () => {
  assert.equal(parseArgs(["review", "this"]).score, false);
  const a = parseArgs(["--score", "review", "this"]);
  assert.equal(a.score, true);
  assert.deepEqual(a.unknown, []);
  assert.deepEqual(a.prompt, ["review", "this"]);
});
