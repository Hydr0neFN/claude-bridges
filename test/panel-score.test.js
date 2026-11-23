import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../lib/args.js";
import { scorePanel, formatScoreOutput } from "../lib/panel-score.js";
import { parseCliArgs, shouldScorePanel, executeModeAll, formatCompactScoredOutput } from "../consult-cli.js";

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

test("parseCliArgs & shouldScorePanel: --no-score parses, default score on for mode all, mode first not scored", () => {
  const def = parseCliArgs(["review", "this"]);
  assert.equal(def.noScore, false);
  assert.deepEqual(def.unknown, []);
  assert.equal(shouldScorePanel({ mode: "all", noScore: def.noScore }), true);
  assert.equal(shouldScorePanel({ mode: "first", noScore: def.noScore }), false);

  const no = parseCliArgs(["--no-score", "review", "this"]);
  assert.equal(no.noScore, true);
  assert.deepEqual(no.unknown, []);
  assert.deepEqual(no.prompt, ["review", "this"]);
  assert.equal(shouldScorePanel({ mode: "all", noScore: no.noScore }), false);

  const alias = parseCliArgs(["--score", "review", "this"]);
  assert.equal(alias.noScore, false);
  assert.equal(alias.score, true);
  assert.deepEqual(alias.unknown, []);
  assert.equal(shouldScorePanel({ mode: "all", noScore: alias.noScore }), true);
  assert.equal(shouldScorePanel({ mode: "first", noScore: alias.noScore }), false);

  assert.equal(parseCliArgs(["--score", "--no-score", "x"]).noScore, true);
  assert.equal(parseCliArgs(["--no-score", "--score", "x"]).noScore, false);
});

const fakeRunner = (answers) => async (engine) => {
  const found = answers.find((a) => a.engine === engine);
  return found ? { engine, ok: true, body: found.text } : { engine, ok: false, reason: "missing" };
};

test("executeModeAll: compact stdout when scoring on + --out-dir + text mode; files still written", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-score-compact-"));
  const logs = [];
  const errs = [];
  const scoreRes = await scorePanel(
    { prompt: "Pick DB", answers: FIVE_ANSWERS },
    { run: async () => JSON.stringify(CANNED_RESPONSE) },
  );

  const code = await executeModeAll(
    {
      prompt: "Pick DB",
      order: FIVE_ANSWERS.map((a) => a.engine),
      run: fakeRunner(FIVE_ANSWERS),
      outDir,
      json: false,
      scoreWanted: true,
    },
    {
      scorePanel: async () => scoreRes,
      log: (s) => logs.push(s),
      error: (s) => errs.push(s),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(errs, []);
  const stdout = logs.join("\n");
  assert.ok(!stdout.includes("## copilot\n"), "compact stdout omits full per-engine sections");
  assert.match(stdout, /\[consult\] mode: all \| answered:/);
  assert.match(stdout, /copilot\s+y\s+strong/);
  assert.match(stdout, /Disagreeing points:/);
  assert.ok(stdout.includes(`Full answers: ${path.resolve(outDir)}`));

  for (const a of FIVE_ANSWERS) {
    assert.ok(fs.existsSync(path.join(outDir, `${a.engine}.md`)));
  }
  assert.ok(fs.existsSync(path.join(outDir, "_done")));
});

test("formatCompactScoredOutput: adds Disagreements block when formatScoreOutput has none and rows have agrees === n", () => {
  const out = formatCompactScoredOutput({
    summary: "[consult] mode: all | answered: a, b, c",
    score: {
      ok: true,
      table: "engine  agrees  quality\n------  ------  -------\na       y       ok\nb       n       weak\nc       n       ok",
      disagreeing: [],
      rows: [
        { engine: "a", agrees: "y" },
        { engine: "b", agrees: "n", reason: "picks NoSQL instead" },
        { engine: "c", agrees: "n" },
      ],
    },
    answers: [
      { engine: "a", text: "SQL" },
      { engine: "b", text: "NoSQL" },
      { engine: "c", text: "File" },
    ],
    outDir: "relative-out-dir",
  });
  assert.match(out, /Disagreements:\n- b: picks NoSQL instead\n- c/);
  assert.ok(out.endsWith(`Full answers: ${path.resolve("relative-out-dir")}`));
});

test("executeModeAll: failed or throwing score does not lose buffered output in --out-dir mode", async () => {
  for (const scorer of [
    async () => ({ ok: false, reason: "timed out after 60000ms" }),
    async () => { throw new Error("decide crashed"); },
  ]) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-score-fail-"));
    const logs = [];
    const errs = [];
    const code = await executeModeAll(
      {
        prompt: "Pick DB",
        order: FIVE_ANSWERS.map((a) => a.engine),
        run: fakeRunner(FIVE_ANSWERS),
        outDir,
        json: false,
        scoreWanted: true,
      },
      {
        scorePanel: scorer,
        log: (s) => logs.push(s),
        error: (s) => errs.push(s),
      },
    );

    assert.equal(code, 0);
    const stdout = logs.join("\n");
    assert.ok(stdout.includes("## copilot\n"), "buffered section printed on score failure");
    assert.ok(stdout.includes("## nim\n"));
    assert.match(stdout, /---\n\[consult\] mode: all \| answered:/);
    assert.ok(!stdout.includes("Full answers:"));
    assert.match(errs.join("\n"), /\[consult\] score skipped: (timed out|decide crashed)/);
  }
});

test("executeModeAll: without --out-dir or with --no-score prints sections as they settle; --json skips compact", async () => {
  const logsNoDir = [];
  let scored = false;
  await executeModeAll(
    {
      prompt: "Pick DB",
      order: FIVE_ANSWERS.map((a) => a.engine),
      run: fakeRunner(FIVE_ANSWERS),
      outDir: null,
      json: false,
      scoreWanted: true,
    },
    {
      scorePanel: async () => {
        scored = true;
        return { ok: true, table: "T", rows: [], disagreeing: [] };
      },
      log: (s) => logsNoDir.push(s),
      error: () => {},
    },
  );
  assert.equal(scored, true);
  assert.ok(logsNoDir.join("\n").includes("## copilot\n"));
  assert.ok(!logsNoDir.join("\n").includes("Full answers:"));

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-noscore-"));
  const logsNoScore = [];
  let scoredWhenOptOut = false;
  await executeModeAll(
    {
      prompt: "Pick DB",
      order: FIVE_ANSWERS.map((a) => a.engine),
      run: fakeRunner(FIVE_ANSWERS),
      outDir,
      json: false,
      scoreWanted: false,
    },
    {
      scorePanel: async () => {
        scoredWhenOptOut = true;
        return { ok: true, table: "T", rows: [], disagreeing: [] };
      },
      log: (s) => logsNoScore.push(s),
      error: () => {},
    },
  );
  assert.equal(scoredWhenOptOut, false);
  assert.ok(logsNoScore.join("\n").includes("## copilot\n"));

  const logsJson = [];
  await executeModeAll(
    {
      prompt: "Pick DB",
      order: FIVE_ANSWERS.map((a) => a.engine),
      run: fakeRunner(FIVE_ANSWERS),
      outDir,
      json: true,
      scoreWanted: true,
    },
    {
      scorePanel: async () => ({ ok: true, table: "T", rows: [{ engine: "copilot", agrees: "y" }], disagreeing: [] }),
      log: (s) => logsJson.push(s),
      error: () => {},
    },
  );
  assert.equal(logsJson.length, 1);
  const env = JSON.parse(logsJson[0]);
  assert.equal(env.ok, true);
  assert.equal(env.data.score.ok, true);
  assert.equal(env.data.score.table, undefined);
});
