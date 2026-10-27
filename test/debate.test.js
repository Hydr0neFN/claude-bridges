import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateSpec, loadContext, TAIL_INSTRUCTION, buildR1Prompt, buildR2Prompt,
  extractTail, extractFinalPick, lastWords, runDebate, buildDigest, tallyLine,
} from "../lib/debate.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "debate-test-"));
const tailBody = (tag, pick) =>
  `${tag} body text.\nCLAIMS:\n- claim one ${tag}\n- claim two\nCONCEDES: minor point\nBOTTOM LINE: ${tag} bottom` +
  (pick ? `\nFINAL PICK: ${pick}` : "");

test("validateSpec: trims strings and fills defaults", () => {
  const s = validateSpec({
    question: "  Which?  ",
    context: "  ctx  ",
    context_files: [" a.txt "],
    stances: [{ engine: " copilot ", stance: "  Pick A  " }],
  });
  assert.equal(s.question, "Which?");
  assert.equal(s.context, "ctx");
  assert.deepEqual(s.context_files, ["a.txt"]);
  assert.equal(s.word_cap, 250);
  assert.equal(s.rebuttal_cap, 150);
  assert.equal(s.rounds, 2);
  assert.deepEqual(s.stances, [{ engine: "copilot", stance: "Pick A", fallback: [] }]);

  const s2 = validateSpec({
    question: "q", word_cap: 10, rebuttal_cap: 5, rounds: 1,
    stances: [{ engine: "nim:some/model", stance: "x", fallback: [" openrouter ", "nim"] }],
  });
  assert.equal(s2.word_cap, 10);
  assert.equal(s2.rebuttal_cap, 5);
  assert.equal(s2.rounds, 1);
  assert.deepEqual(s2.stances[0].fallback, ["openrouter", "nim"]);
});

test("validateSpec: rejects each misuse", () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ engine: i ? `nim:m${i}` : "copilot", stance: "x" }));
  const cases = [
    [null, /JSON object/],
    [[], /JSON object/],
    ["x", /JSON object/],
    [{}, /question/],
    [{ question: "   ", stances: [{ engine: "copilot", stance: "x" }] }, /question/],
    [{ question: "q" }, /stances/],
    [{ question: "q", stances: [] }, /stances/],
    [{ question: "q", stances: nine }, /at most 8/],
    [{ question: "q", stances: [{}] }, /engine/],
    [{ question: "q", stances: [{ engine: "copilot" }] }, /stance text/],
    [{ question: "q", stances: [{ engine: "nope", stance: "x" }] }, /unknown engine/],
    [{ question: "q", stances: [{ engine: "copilot", stance: "a" }, { engine: "copilot", stance: "b" }] }, /duplicate/],
    [{ question: "q", stances: [{ engine: "copilot", stance: "x" }], rounds: 3 }, /rounds/],
    [{ question: "q", stances: [{ engine: "copilot", stance: "x" }], word_cap: 0 }, /word_cap/],
    [{ question: "q", stances: [{ engine: "copilot", stance: "x" }], rebuttal_cap: 1.5 }, /rebuttal_cap/],
    [{ question: "q", stances: [{ engine: "copilot", stance: "x" }], context_files: "a" }, /context_files/],
    [{ question: "q", stances: [{ engine: "copilot", stance: "x" }], context_files: [1] }, /context_files/],
    [{ question: "q", stances: [{ engine: "copilot", stance: "x", fallback: "nim" }] }, /fallback/],
    [{ question: "q", stances: [{ engine: "copilot", stance: "x", fallback: ["nope"] }] }, /fallback/],
  ];
  for (const [spec, re] of cases) assert.throws(() => validateSpec(spec), re);
});

test("loadContext: context, file sections, per-file cap", () => {
  assert.equal(
    loadContext({ context: "ctx", context_files: ["a.txt"] }, { readFile: () => "body" }),
    "ctx\n### FILE: a.txt\nbody\n",
  );
  const cut = loadContext({ context_files: ["a"] }, { readFile: () => "0123456789", perFileCap: 4 });
  assert.match(cut, /### FILE: a\n0123\n\[TRUNCATED: a cut at 4 chars\]/);
});

test("loadContext: total cap omits remaining files, unreadable files are marked", () => {
  const capped = loadContext(
    { context_files: ["a", "b", "c"] },
    { readFile: () => "x".repeat(10), perFileCap: 1000, totalCap: 30 },
  );
  assert.match(capped, /### FILE: a/);
  assert.ok(!capped.includes("### FILE: b"));
  assert.match(capped, /\[TRUNCATED: context cap reached, 2 file\(s\) omitted\]/);

  const bad = loadContext({ context_files: ["x"] }, { readFile: () => { throw new Error("boom"); } });
  assert.match(bad, /\[UNREADABLE: x: boom\]/);
});

test("buildR1Prompt: context, question, stance, cap and tail block", () => {
  const s = validateSpec({ question: "Which?", word_cap: 77, stances: [{ engine: "copilot", stance: "Pick A" }] });
  const p = buildR1Prompt(s, s.stances[0], "CTX-MARK");
  assert.match(p, /structured debate/);
  assert.match(p, /no file access/);
  assert.match(p, /CTX-MARK/);
  assert.match(p, /QUESTION:\nWhich\?/);
  assert.match(p, /YOUR STANCE:\nPick A/);
  assert.match(p, /LIMIT: at most 77 words before the tail block/);
  assert.ok(p.includes(TAIL_INSTRUCTION));
  assert.ok(!buildR1Prompt(s, s.stances[0], "").includes("CONTEXT:"));
});

test("buildR2Prompt: excludes own tail, includes others, ends with FINAL PICK format", () => {
  const s = validateSpec({ question: "Q", rebuttal_cap: 55, stances: [{ engine: "copilot", stance: "Pick A" }] });
  const p = buildR2Prompt(s, s.stances[0], "", [
    { label: "copilot", tail: "SELF-TAIL" },
    { label: "nim:x", tail: "OTHER-TAIL" },
  ]);
  assert.ok(!p.includes("SELF-TAIL"));
  assert.match(p, /\[nim:x\]\nOTHER-TAIL/);
  assert.match(p, /OTHER PANELISTS' ROUND-1 POSITIONS:/);
  assert.match(p, /rebut or concede honestly/i);
  assert.match(p, /change your mind/);
  assert.match(p, /LIMIT: at most 55 words/);
  assert.ok(p.includes(TAIL_INSTRUCTION));
  assert.equal(p.trimEnd().split("\n").at(-1), "FINAL PICK: <option> - <one line reason>");
});

test("extractTail: plain, bold, lowercase, reordered and BOTTOM-LINE", () => {
  const plain = extractTail("prose\nCLAIMS:\n- one\n- two\nCONCEDES: none\nBOTTOM LINE: ship it");
  assert.deepEqual(plain.claims, ["one", "two"]);
  assert.equal(plain.concedes, "none");
  assert.equal(plain.bottomLine, "ship it");
  assert.equal(plain.text, "CLAIMS:\n- one\n- two\nCONCEDES: none\nBOTTOM LINE: ship it");

  const bold = extractTail("**CLAIMS:**\n- a\n**CONCEDES**: nope\n**BOTTOM LINE:** go");
  assert.deepEqual(bold.claims, ["a"]);
  assert.equal(bold.concedes, "nope");
  assert.equal(bold.bottomLine, "go");

  const lower = extractTail("claims: one\nconcedes: c\nbottom-line: b");
  assert.deepEqual(lower.claims, ["one"]);
  assert.equal(lower.concedes, "c");
  assert.equal(lower.bottomLine, "b");

  const reordered = extractTail("BOTTOM LINE: last\nCLAIMS:\n- first\nCONCEDES: middle");
  assert.deepEqual(reordered.claims, ["first"]);
  assert.equal(reordered.concedes, "middle");
  assert.equal(reordered.bottomLine, "last");

  const marked = extractTail("# **CLAIMS:**\n- x\n> **CONCEDES:** y\n- **BOTTOM-LINE:** z");
  assert.deepEqual(marked.claims, ["x"]);
  assert.equal(marked.concedes, "y");
  assert.equal(marked.bottomLine, "z");
});

test("extractTail: last CLAIMS wins, FINAL PICK is not folded in, no labels -> null", () => {
  const prose = [
    "I will use a CLAIMS: block.",
    "CLAIMS: this early label is prose",
    "CONCEDES: really",
    "CLAIMS:",
    "- real one",
    "BOTTOM LINE: done",
  ].join("\n");
  const t = extractTail(prose);
  assert.deepEqual(t.claims, ["real one"]);
  assert.equal(t.concedes, "really");

  const withPick = extractTail("CLAIMS:\n- a\nCONCEDES: c\nBOTTOM LINE: b\nFINAL PICK: A - yes");
  assert.equal(withPick.bottomLine, "b");

  const partial = extractTail("BOTTOM LINE: only");
  assert.deepEqual(partial.claims, []);
  assert.equal(partial.concedes, "");
  assert.equal(partial.text, "CLAIMS:\n(none)\nCONCEDES: (none)\nBOTTOM LINE: only");

  assert.equal(extractTail("no labels here"), null);
  assert.equal(extractTail(""), null);
});

test("extractFinalPick: tolerant of bold, case, markers; last wins; none -> null", () => {
  assert.equal(extractFinalPick("FINAL PICK: A - yes"), "A - yes");
  assert.equal(extractFinalPick("**FINAL PICK:** B - no"), "B - no");
  assert.equal(extractFinalPick("final pick: c"), "c");
  assert.equal(extractFinalPick("> - **FINAL PICK**: D - maybe"), "D - maybe");
  assert.equal(extractFinalPick("FINAL PICK: A - first\nFINAL PICK: B - last"), "B - last");
  assert.equal(extractFinalPick("nothing"), null);
});

test("lastWords: last n words, single spaces", () => {
  assert.equal(lastWords("a b c d", 2), "c d");
  assert.equal(lastWords("a  b\n c", 2), "b c");
  assert.equal(lastWords("a b", 0), "");
  assert.equal(lastWords("", 5), "");
});

test("runDebate: 2 engines, 2 rounds, files, digest, _done last", async () => {
  const dir = tmp();
  const spec = validateSpec({
    question: "Which?",
    stances: [{ engine: "copilot", stance: "A" }, { engine: "nim:x/y", stance: "B" }],
  });
  const run = async (engine, prompt) => ({
    engine,
    ok: true,
    body: prompt.includes("OTHER PANELISTS")
      ? tailBody(`r2-${engine}`, "A - because")
      : tailBody(`r1-${engine}`),
  });

  const writes = [];
  const ow = fs.writeFileSync;
  const or = fs.renameSync;
  fs.writeFileSync = (file, ...rest) => (writes.push(String(file)), ow(file, ...rest));
  fs.renameSync = (from, to) => (writes.push(String(to)), or(from, to));
  let res;
  try {
    res = await runDebate({ spec, outDir: dir, run });
  } finally {
    fs.writeFileSync = ow;
    fs.renameSync = or;
  }

  assert.equal(path.basename(writes.at(-1)), "_done");
  assert.ok(fs.existsSync(path.join(dir, "r1", "copilot.prompt.md")));
  assert.ok(fs.existsSync(path.join(dir, "r1", "nim_x_y.md")));
  assert.ok(fs.existsSync(path.join(dir, "r2", "copilot.md")));
  assert.equal(fs.readFileSync(path.join(dir, "_done"), "utf8"), `${res.tally}\n`);
  assert.equal(fs.readFileSync(path.join(dir, "r2", "copilot.md"), "utf8"), `${tailBody("r2-copilot", "A - because")}\n`);

  const digest = fs.readFileSync(res.digestPath, "utf8");
  assert.match(digest, /# Debate digest/);
  assert.match(digest, /R1:\nCLAIMS:/);
  assert.match(digest, /FINAL PICK: A - because/);
  assert.equal(res.records.length, 2);
  assert.equal(res.records[0].served, "copilot");
  assert.equal(res.records[0].r1.status, "ok");
  assert.equal(res.records[1].r1.tail.text.includes("claim one r1-nim:x/y"), true);
  assert.match(res.tally, /^TALLY: a=2$/);
});

test("runDebate: an R1 failure is contained and gets no R2", async () => {
  const dir = tmp();
  const spec = validateSpec({
    question: "Q",
    stances: [
      { engine: "copilot", stance: "A" },
      { engine: "nim:model", stance: "B" },
      { engine: "dsapi", stance: "C" },
    ],
  });
  const run = async (engine, prompt) =>
    engine === "copilot"
      ? { engine, ok: false, reason: "quota" }
      : { engine, ok: true, body: tailBody(`${engine}`, "B - no") };

  const res = await runDebate({ spec, outDir: dir, run });
  assert.equal(res.records[0].r1.status, "failed");
  assert.match(res.records[0].r1.reason, /quota/);
  assert.equal(res.records[0].r2, null);
  assert.ok(!fs.existsSync(path.join(dir, "r2", "copilot.md")));
  assert.ok(fs.existsSync(path.join(dir, "r2", "nim_model.md")));
  assert.ok(fs.existsSync(path.join(dir, "r2", "dsapi.md")));

  const digest = fs.readFileSync(path.join(dir, "digest.md"), "utf8");
  assert.match(digest, /R1: ENGINE_FAILED: quota/);
  assert.match(digest, /R2: \(not run: R1 failed\)/);
  assert.match(digest, /r1\/copilot\.md/);
  assert.match(digest, /no pick: copilot/);
});

test("runDebate: fallback retries once on the first unused engine", async () => {
  const dir = tmp();
  const spec = validateSpec({
    question: "Q",
    rounds: 1,
    stances: [
      { engine: "copilot", stance: "A", fallback: ["openrouter", "nim"] },
      { engine: "openrouter", stance: "B" },
    ],
  });
  const calls = [];
  const prompts = {};
  const run = async (engine, prompt) => {
    calls.push(engine);
    (prompts[engine] ||= []).push(prompt);
    if (engine === "copilot" || engine === "openrouter") return { engine, ok: false, reason: "down" };
    return { engine: "nim:served", ok: true, body: tailBody("nim") };
  };

  const res = await runDebate({ spec, outDir: dir, run });
  assert.equal(res.records[0].label, "nim (for copilot)");
  assert.equal(res.records[0].served, "nim:served");
  assert.ok(fs.existsSync(path.join(dir, "r1", "nim-for-copilot.md")));
  assert.ok(fs.existsSync(path.join(dir, "r1", "nim-for-copilot.prompt.md")));
  assert.ok(calls.filter((e) => e === "openrouter").length === 1, "openrouter is in the panel, not reused");
  assert.equal(prompts.nim[0], prompts.copilot[0]);
  assert.equal(res.records[1].r1.status, "failed");
  assert.match(fs.readFileSync(path.join(dir, "digest.md"), "utf8"), /## nim \(for copilot\)/);
});

test("runDebate: a thrown run does not abort the debate", async () => {
  const dir = tmp();
  const spec = validateSpec({
    question: "Q",
    stances: [{ engine: "copilot", stance: "A" }, { engine: "nim:model", stance: "B" }],
  });
  const run = async (engine) => {
    if (engine === "copilot") throw new Error("boom");
    return { engine, ok: true, body: tailBody("ok") };
  };

  const res = await runDebate({ spec, outDir: dir, run });
  assert.equal(res.records[0].r1.status, "failed");
  assert.match(res.records[0].r1.reason, /^crashed: boom/);
  assert.equal(res.records[1].r1.status, "ok");
  assert.match(fs.readFileSync(path.join(dir, "digest.md"), "utf8"), /ENGINE_FAILED: crashed: boom/);
});

test("runDebate: a missing tail becomes a last-words marker for other panelists", async () => {
  const dir = tmp();
  const spec = validateSpec({
    question: "Q",
    stances: [{ engine: "copilot", stance: "A" }, { engine: "nim:model", stance: "B" }],
  });
  const noTail = "copilot rambles without a structured tail and ends with these final words";
  const prompts = {};
  const run = async (engine, prompt) => {
    (prompts[engine] ||= []).push(prompt);
    if (prompt.includes("OTHER PANELISTS")) return { engine, ok: true, body: tailBody(`r2-${engine}`, "A - yes") };
    return { engine, ok: true, body: engine === "copilot" ? noTail : tailBody("r1-nim") };
  };

  const res = await runDebate({ spec, outDir: dir, run });
  assert.equal(res.records[0].r1.tailMissing, true);
  const nimR2 = prompts["nim:model"].find((p) => p.includes("OTHER PANELISTS"));
  assert.match(nimR2, /\(tail missing; last words\) copilot rambles/);
  assert.ok(nimR2.includes(noTail.split(" ").slice(-3).join(" ")));
  assert.match(fs.readFileSync(path.join(dir, "digest.md"), "utf8"), /TAIL_MISSING/);
});

test("runDebate: fewer than 2 answered skips R2", async () => {
  const dir = tmp();
  const spec = validateSpec({
    question: "Q",
    stances: [{ engine: "copilot", stance: "A" }, { engine: "nim:model", stance: "B" }],
  });
  const prompts = [];
  const run = async (engine, prompt) => {
    prompts.push(prompt);
    return engine === "copilot"
      ? { engine, ok: true, body: tailBody("r1") }
      : { engine, ok: false, reason: "down" };
  };

  const res = await runDebate({ spec, outDir: dir, run });
  assert.ok(!fs.existsSync(path.join(dir, "r2")));
  assert.equal(res.records[0].r2, null);
  assert.ok(!prompts.some((p) => p.includes("OTHER PANELISTS")));
  assert.match(
    fs.readFileSync(path.join(dir, "digest.md"), "utf8"),
    /R2 skipped: fewer than 2 engines answered R1/,
  );
});

test("digest: five typical engines stays compact", async () => {
  const dir = tmp();
  const engines = ["copilot", "codex", "nim:model", "openrouter", "dsapi"];
  const spec = validateSpec({
    question: "Pick one option from the list.",
    stances: engines.map((engine, i) => ({ engine, stance: `stance number ${i} with a short rationale` })),
  });
  const run = async (engine) => ({ engine, ok: true, body: tailBody(engine, "A - because it is best") });

  const res = await runDebate({ spec, outDir: dir, run });
  const digest = fs.readFileSync(res.digestPath, "utf8");
  assert.ok(digest.length < 6000, `digest was ${digest.length} chars`);
  assert.match(digest, /TALLY: a=5/);
});

test("tallyLine: groups option keys and lists no-pick labels", () => {
  const rec = (label, pick) => ({ label, r2: pick ? { finalPick: pick } : null });
  assert.equal(
    tallyLine([rec("a", "A - x"), rec("b", "a - y"), rec("c", "**B** - z"), rec("d", null)]),
    "TALLY: a=2 b=1 (no pick: d)",
  );
  assert.equal(tallyLine([]), "TALLY: (no picks)");
});

test("buildDigest: compact sections and skipped-R2 note", () => {
  const spec = validateSpec({ question: "Q", stances: [{ engine: "copilot", stance: "A" }] });
  const records = [{
    label: "copilot",
    served: "copilot",
    r1: { status: "ok", tail: extractTail(tailBody("r1")), tailMissing: false },
    r2: null,
    files: ["r1/copilot.md"],
  }];
  const d = buildDigest(spec, records, { skippedR2: true });
  assert.match(d, /Answered R1: copilot/);
  assert.match(d, /R2 skipped: fewer than 2 engines answered R1/);
  assert.match(d, /R2: \(skipped: fewer than 2 answered R1\)/);
  assert.match(d, /Files: r1\/copilot\.md/);
  assert.match(d.trimEnd(), /TALLY: \(no pick: copilot\)$/);
});

test("parseArgs: --debate takes a spec path", async () => {
  const { parseArgs } = await import("../lib/args.js");
  assert.equal(parseArgs(["--debate", "s.json", "--out-dir", "d"]).debate, "s.json");
  assert.equal(parseArgs(["hi"]).debate, null);
});

test("consult-cli --debate: bad spec / missing --out-dir exit 2", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-debate-"));
  const spec = path.join(dir, "s.json");
  fs.writeFileSync(spec, JSON.stringify({ question: "q" }));
  const cli = path.join(import.meta.dirname, "..", "consult-cli.js");
  const bad = spawnSync(process.execPath, [cli, "--debate", spec, "--out-dir", path.join(dir, "o")], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /stances/);
  const noOut = spawnSync(process.execPath, [cli, "--debate", spec], { encoding: "utf8" });
  assert.equal(noOut.status, 2);
  assert.match(noOut.stderr, /--out-dir/);
});

test("extractFinalPick: bold around the option is removed everywhere", () => {
  assert.equal(extractFinalPick("**FINAL PICK:** **A** - because"), "A - because");
  assert.equal(extractFinalPick("FINAL PICK: **A** - x"), "A - x");
});
