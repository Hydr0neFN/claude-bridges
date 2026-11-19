import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/args.js";

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
