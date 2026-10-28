import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../lib/args.js";
import { failureCode, engineEntry, runEnvelope, EXIT } from "../lib/cli-json.js";
import { formatSection, summaryLine } from "../lib/panel.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "consult-cli.js");
const cli = (args, input = "") => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input, timeout: 20000, env: { ...process.env, HOME: os.tmpdir() } });

test("parseArgs: --json is a flag, not prompt text; default false", () => {
  assert.equal(parseArgs(["hello"]).json, false);
  const a = parseArgs(["--json", "hello", "world"]);
  assert.equal(a.json, true);
  assert.deepEqual(a.prompt, ["hello", "world"]);
  // the dad-console call shape is untouched
  const d = parseArgs(["--prompt-file", "p.md", "--mode", "all", "--order", "copilot,codex", "--out-dir", "o", "--cwd", "w"]);
  assert.deepEqual([d.json, d.promptFile, d.mode, d.order, d.outDir, d.cwd, d.prompt], [false, "p.md", "all", "copilot,codex", "o", "w", []]);
});

test("failureCode: stable codes, quota first", () => {
  assert.equal(failureCode("rate-limited (HTTP 429): slow down"), "QUOTA_EXHAUSTED");
  assert.equal(failureCode("free pool at 3 requests left today (reserve 5); :free models skipped"), "QUOTA_EXHAUSTED");
  assert.equal(failureCode("You have exhausted your capacity"), "QUOTA_EXHAUSTED");
  assert.equal(failureCode("exit 1: Error: No authentication information found."), "AUTH_FAILED");
  assert.equal(failureCode("HTTP 401"), "AUTH_FAILED");
  assert.equal(failureCode("timed out after 300s"), "TIMEOUT");
  assert.equal(failureCode("codex is not installed"), "NOT_INSTALLED");
  assert.equal(failureCode("empty output (reasoning only)"), "EMPTY_OUTPUT");
  assert.equal(failureCode("crashed: boom"), "CRASHED");
  assert.equal(failureCode("something odd"), "ENGINE_ERROR");
  assert.equal(failureCode(undefined), "ENGINE_ERROR");
});

test("runEnvelope all: answered/failed/quota lists, file paths with out-dir, bodies inline without", () => {
  const results = [
    { engine: "codex", ok: true, body: "answer A" },
    { engine: "nim:z-ai/glm", ok: false, reason: "rate-limited (HTTP 429): x" },
    { engine: "agy", ok: false, reason: "timed out after 300s" },
  ];
  const withDir = runEnvelope({ mode: "all", results, outDir: "/o" });
  assert.deepEqual([withDir.ok, withDir.code], [true, "OK"]);
  assert.deepEqual(withDir.data.answered, ["codex"]);
  assert.deepEqual(withDir.data.failed, ["nim:z-ai/glm", "agy"]);
  assert.deepEqual(withDir.data.quota_exhausted, ["nim:z-ai/glm"]);
  assert.equal(withDir.data.out_dir, "/o");
  assert.equal(withDir.data.done_file, path.join("/o", "_done"));
  const [c, n, a] = withDir.data.engines;
  assert.equal(c.file, path.join("/o", "codex.md"));
  assert.equal(c.body, undefined);
  assert.equal(n.file, undefined);
  assert.deepEqual([n.code, a.code], ["QUOTA_EXHAUSTED", "TIMEOUT"]);
  assert.equal(runEnvelope({ mode: "all", results }).data.engines[0].body, "answer A");
});

test("runEnvelope: nobody answered -> ALL_ENGINES_FAILED; first mode inlines the body and keeps the failover trail", () => {
  const f = runEnvelope({ mode: "all", results: [{ engine: "codex", ok: false, reason: "HTTP 429" }] });
  assert.deepEqual([f.ok, f.code], [false, "ALL_ENGINES_FAILED"]);
  assert.deepEqual(f.data.quota_exhausted, ["codex"]);
  const first = runEnvelope({ mode: "first", results: [{ engine: "codex", ok: false, reason: "HTTP 429" }, { engine: "agy", ok: true, body: "B" }], outDir: "/o", trail: ["codex: HTTP 429"] });
  assert.equal(first.ok, true);
  assert.equal(first.data.engines[1].body, "B");
  assert.deepEqual(first.data.failover, ["codex: HTTP 429"]);
  assert.equal(engineEntry({ engine: "x", ok: false, reason: "y".repeat(2000) }).reason.length < 500, true);
});

test("text-mode helpers that dad-console parses are unchanged", () => {
  assert.equal(formatSection({ engine: "codex", ok: true, body: "hi" }), "## codex\n\nhi\n");
  assert.equal(formatSection({ engine: "agy", ok: false, reason: "bad" }), "## agy\n\n[failed] bad\n");
  assert.equal(summaryLine([{ engine: "codex", ok: true, body: "x" }, { engine: "agy", ok: false, reason: "bad" }]), "[consult] mode: all | answered: codex | failed: agy: bad");
});

test("CLI without --json: usage errors keep exit 2, stdout empty, message on stderr", () => {
  const r = cli([]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /usage: consult/);
  const m = cli(["--prompt-file", "/nonexistent/p.md"]);
  assert.equal(m.status, 2);
  assert.equal(m.stdout, "");
  assert.match(m.stderr, /cannot read prompt from/);
});

test("CLI with --json: usage 2, missing prompt file 6, bad order 2; stdout is one envelope", () => {
  const one = (r) => { const l = r.stdout.trim().split("\n"); assert.equal(l.length, 1, r.stdout); return JSON.parse(l[0]); };
  const u = cli(["--json"]);
  assert.equal(u.status, EXIT.usage);
  assert.deepEqual([one(u).ok, one(u).code], [false, "USAGE"]);
  const n = cli(["--json", "--prompt-file", "/nonexistent/p.md"]);
  assert.equal(n.status, EXIT.notFound);
  assert.equal(one(n).code, "NOT_FOUND");
  const o = cli(["--json", "--order", "bogus", "hi"]);
  assert.equal(o.status, EXIT.usage);
  assert.equal(one(o).code, "USAGE");
  const both = cli(["--json", "--prompt-file", "-", "words"], "x");
  assert.equal(both.status, EXIT.usage);
  assert.equal(one(both).code, "USAGE");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-json-"));
  const d = cli(["--json", "--debate", path.join(dir, "nope.json"), "--out-dir", dir]);
  assert.equal(d.status, EXIT.notFound);
  assert.equal(one(d).code, "NOT_FOUND");
});
