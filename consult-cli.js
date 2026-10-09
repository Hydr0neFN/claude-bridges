#!/usr/bin/env node
// consult-cli: same panel as consult-bridge, invoked as a plain command instead
// of an MCP server. Rationale: as an MCP the tool schema sits in every request's
// context floor and can be left dangling by tool-search deferral; as a CLI it
// costs nothing until called. Shares lib/engines.js with the MCP version.
//
// Usage: consult "<prompt>" [--mode all|first] [--order copilot,codex,agy] [--cwd <dir>]
//        [--copilot-model M] [--copilot-effort E] [--codex-model M] [--codex-effort E]
//        consult --check-updates | --update

import { ENGINES } from "./lib/engines.js";
import { parseArgs, parseOrder } from "./lib/args.js";
import { checkUpdates, settle, applyUpdates, formatFooter } from "./lib/updates.js";

const TIMEOUT_SEC = Number(process.env.CONSULT_TIMEOUT) || 300;
const UPDATE_WAIT_MS = Number(process.env.CLAUDE_BRIDGES_UPDATE_WAIT_MS) || 4000;

const args = parseArgs(process.argv.slice(2));

if (args.checkUpdates || args.update) {
  const { items } = await settle(checkUpdates({ force: true }), 60000);
  if (args.update) {
    for (const line of await applyUpdates({ items })) console.log(line);
    checkUpdates({ force: true }).pending.then(() => process.exit(0));
  } else {
    console.log(formatFooter(items) || "[consult] everything up to date");
  }
} else {
  await main();
}

async function main() {
  const prompt = args.prompt.join(" ").trim();
  if (!prompt) {
    console.error('usage: consult "<prompt>" [--mode all|first] [--order copilot,codex,agy] [--cwd <dir>] | --check-updates | --update');
    process.exit(2);
  }

  // Started now, runs concurrently with the consult; only cached/finished results are ever shown.
  const updates = checkUpdates();

  const cwd = args.cwd || process.cwd();
  const mode = args.mode || (process.env.CONSULT_MODE === "first" ? "first" : "all");
  const order = parseOrder(args.order || process.env.CONSULT_ORDER);
  const opts = {
    copilot: { model: args.copilotModel, effort: args.copilotEffort },
    codex: { model: args.codexModel, effort: args.codexEffort },
  };
  const run = (name) => ENGINES[name]({ prompt, cwd, timeoutSec: TIMEOUT_SEC, ...opts[name] });

  const finish = async (code) => {
    const footer = formatFooter((await settle(updates, UPDATE_WAIT_MS)).items);
    if (footer) console.error(footer);
    process.exit(code);
  };

  if (mode === "first") {
    const trail = [];
    for (const name of order) {
      const r = await run(name);
      if (r.ok) {
        console.log(r.body);
        console.log(`\n---\n[consult] mode: first | engine: ${r.engine}${trail.length ? ` | failover: ${trail.join("; ")}` : ""}`);
        return finish(0);
      }
      trail.push(`${r.engine}: ${r.reason}`);
    }
    console.error(`consult: all engines failed.\n${trail.map((t) => `- ${t}`).join("\n")}`);
    return finish(1);
  }

  const results = await Promise.all(order.map(run));
  const good = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok).map((r) => `${r.engine}: ${r.reason}`);

  if (!good.length) {
    console.error(`consult: all engines failed.\n${failed.map((t) => `- ${t}`).join("\n")}`);
    return finish(1);
  }

  for (const r of good) console.log(`## ${r.engine}\n\n${r.body}\n`);
  console.log(`---\n[consult] mode: all | answered: ${good.map((r) => r.engine).join(", ")}${failed.length ? ` | failed: ${failed.join("; ")}` : ""}`);
  return finish(0);
}
