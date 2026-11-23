import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../lib/args.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "consult-cli.js");

test("parseArgs: --help / -h set help and never become prompt text", () => {
  for (const flag of ["--help", "-h"]) {
    const a = parseArgs([flag]);
    assert.equal(a.help, true);
    assert.deepEqual(a.prompt, []);
  }
});

test("parseArgs: an unknown --flag is collected as unknown, not as prompt", () => {
  const a = parseArgs(["--bogus", "review", "this"]);
  assert.deepEqual(a.unknown, ["--bogus"]);
  assert.deepEqual(a.prompt, ["review", "this"]);
});

test("consult-cli --help output mentions --no-score and default scoring", () => {
  const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--no-score/);
  assert.match(r.stdout, /--mode all/);
  assert.match(r.stdout, /--out-dir/);
});
