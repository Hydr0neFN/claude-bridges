#!/usr/bin/env node
// consult-cli: same panel as consult-bridge, invoked as a plain command instead
// of an MCP server. Rationale: as an MCP the tool schema sits in every request's
// context floor and can be left dangling by tool-search deferral; as a CLI it
// costs nothing until called. Shares lib/engines.js with the MCP version.
//
// Usage: consult "<prompt>" [--mode all|first] [--order copilot,codex,agy] [--cwd <dir>] [--out-dir <dir>]
//        [--copilot-model M] [--copilot-effort E] [--codex-model M] [--codex-effort E]
//        consult --check-updates | --update

import { ENGINES } from "./lib/engines.js";
import { parseArgs, parseOrder } from "./lib/args.js";
import { runPanel, formatSection, summaryLine, writeEngineResult, writeDone } from "./lib/panel.js";
import { checkUpdates, spawnRefresh, settle, applyUpdates, formatFooter } from "./lib/updates.js";

const TIMEOUT_SEC = Number(process.env.CONSULT_TIMEOUT) || 300;

const args = parseArgs(process.argv.slice(2));

if (args.checkUpdates || args.update) {
  const { items } = await settle(checkUpdates({ force: true }), 60000);
  if (args.update) {
    const { log, failed } = await applyUpdates({ items });
    for (const line of log) console.log(line);
    process.exit(failed ? 1 : 0);
  } else {
    console.log(formatFooter(items) || "[consult] everything up to date");
  }
} else {
  await main();
}

async function main() {
  const prompt = args.prompt.join(" ").trim();
  if (!prompt) {
    console.error('usage: consult "<prompt>" [--mode all|first] [--order copilot,codex,agy] [--cwd <dir>] [--out-dir <dir>] | --check-updates | --update');
    process.exit(2);
  }

  
  // A stale cache is refreshed by a detached child; the footer only ever uses the cached result.
  const updates = checkUpdates({ detach: spawnRefresh });

  const cwd = args.cwd || process.cwd();
  const mode = args.mode || (process.env.CONSULT_MODE === "first" ? "first" : "all");
  const order = parseOrder(args.order || process.env.CONSULT_ORDER);
  const opts = {
    copilot: { model: args.copilotModel, effort: args.copilotEffort },
    codex: { model: args.codexModel, effort: args.codexEffort },
  };
  const run = (name) => ENGINES[name]({ prompt, cwd, timeoutSec: TIMEOUT_SEC, ...opts[name] });

  const finish = async (code) => {
    const footer = formatFooter(updates.items);
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

  // Each engine's whole section is printed the moment it settles (completion order);
  // console.log of one string is a single write, so sections never interleave.
  const results = await runPanel({
    order,
    run,
    onSettle: (name, r) => {
      console.log(formatSection(r));
      if (args.outDir) writeEngineResult(args.outDir, name, r);
    },
  });
  const summary = summaryLine(results);
  if (!summary) {
    const failed = results.map((r) => `${r.engine}: ${r.reason}`);
    const msg = `consult: all engines failed.\n${failed.map((t) => `- ${t}`).join("\n")}`;
    if (args.outDir) writeDone(args.outDir, msg);
    console.error(msg);
    return finish(1);
  }
  if (args.outDir) writeDone(args.outDir, summary);
  console.log(`---\n${summary}`);
  return finish(0);
}
