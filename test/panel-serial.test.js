import test from "node:test";
import assert from "node:assert/strict";
import { runPanel, CLI_ENGINES, cliSerialEnabled } from "../lib/panel.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GiB = 1024 ** 3;

test("runPanel serial: serial specs never overlap, non-serial runs concurrently, order preserved", async () => {
  const isCli = (spec) => CLI_ENGINES.has(spec.split(":")[0]);
  const order = ["copilot", "nim:ultra", "codex", "openrouter", "agy:model", "opencode"];

  let activeSerial = 0;
  let maxSerial = 0;
  const serialStarts = [];
  const events = [];

  const results = await runPanel({
    order,
    serial: isCli,
    run: async (spec) => {
      const ser = isCli(spec);
      events.push(`start:${spec}`);
      if (ser) {
        serialStarts.push(spec);
        activeSerial += 1;
        maxSerial = Math.max(maxSerial, activeSerial);
      }
      await sleep(ser ? 25 : 10);
      if (ser) activeSerial -= 1;
      events.push(`end:${spec}`);
      return { engine: spec, ok: true, body: spec };
    },
  });

  assert.equal(maxSerial, 1);
  assert.deepEqual(serialStarts, ["copilot", "codex", "agy:model", "opencode"]);
  assert.ok(events.indexOf("start:nim:ultra") < events.indexOf("end:copilot"));
  assert.ok(events.indexOf("start:openrouter") < events.indexOf("end:copilot"));
  assert.deepEqual(results.map((r) => r.engine), order);
});

test("runPanel serial: a throwing run or failing onSettle does not stall the serial queue", async () => {
  const ran = [];
  const results = await runPanel({
    order: ["copilot", "codex", "agy"],
    serial: () => true,
    run: async (spec) => {
      ran.push(spec);
      if (spec === "copilot") throw new Error("boom");
      return { engine: spec, ok: true, body: spec };
    },
    onSettle: (spec) => {
      if (spec === "codex") throw new Error("sink failed");
    },
  });

  assert.deepEqual(ran, ["copilot", "codex", "agy"]);
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /^crashed: boom$/);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, true);
});

test("cliSerialEnabled: env overrides and totalmem threshold", () => {
  assert.equal(cliSerialEnabled({ CONSULT_CLI_SERIAL: "1" }, 32 * GiB), true);
  assert.equal(cliSerialEnabled({ CONSULT_CLI_SERIAL: "0" }, 8 * GiB), false);
  assert.equal(cliSerialEnabled({}, 8 * GiB), true);
  assert.equal(cliSerialEnabled({}, 12 * GiB), true);
  assert.equal(cliSerialEnabled({}, 32 * GiB), false);
});
