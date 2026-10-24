#!/usr/bin/env node
// consult-cli: same panel as consult-bridge, invoked as a plain command instead
// of an MCP server. Rationale: as an MCP the tool schema sits in every request's
// context floor and can be left dangling by tool-search deferral; as a CLI it
// costs nothing until called. Shares lib/engines.js with the MCP version.
//
// Usage: consult "<prompt>" | --prompt-file <path|-> [--mode all|first] [--order copilot,codex] [--cwd <dir>] [--out-dir <dir>]
//        [--copilot-model M] [--copilot-effort E] [--codex-model M] [--codex-effort E] [--nim-model M] [--openrouter-model M] [--dsapi-model M]
//        --order entries are `engine` or `engine:model`, e.g. nim:moonshotai/kimi-k3,codex (model wins over the flags)
//        consult --check-updates | --update | --check-nim-models | --refresh-nim-models

import { runSpec, dsapiUsageNotice } from "./lib/engines.js";
import { parseArgs, parseOrderDetailed, resolvePrompt } from "./lib/args.js";
import { runPanel, runChain, lastResortNote, formatSection, summaryLine, writeEngineResult, writeDone } from "./lib/panel.js";
import { checkUpdates, spawnRefresh, settle, applyUpdates, formatFooter } from "./lib/updates.js";
import { peekNimModels, refreshNimModels, formatNimNotice, nimNoticeGate, orderUsesNim } from "./lib/nim-models.js";

const TIMEOUT_SEC = Number(process.env.CONSULT_TIMEOUT) || 300;

const args = parseArgs(process.argv.slice(2));

if (args.refreshNimModels) {
  // Detached-refresh entry point (also for external hooks): throttled, silent, writes only the cache.
  await refreshNimModels().catch(() => {});
  process.exit(0);
} else if (args.checkNimModels) {
  const { skipped, cache } = await refreshNimModels({ force: true });
  if (skipped === "no key") console.log("[consult] NIM: no key configured (env NIM_API_KEY or ~/.nvidia-nim-key), check skipped");
  else if (cache?.error) console.log(`[consult] NIM: check failed: ${cache.error}`);
  else console.log(formatNimNotice(cache) || `[consult] NIM: no new models (${cache?.seen.length ?? 0} known)`);
  // Only a listing failure in THIS run is an error; a stale error in the cache must not fail a no-key run.
  process.exit(skipped === null && cache?.error ? 1 : 0);
} else if (args.checkUpdates || args.update) {
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
  let prompt;
  try {
    prompt = resolvePrompt(args);
  } catch (e) {
    console.error(`consult: ${e.message}`);
    process.exit(2);
  }
  if (!prompt) {
    console.error('usage: consult "<prompt>" | --prompt-file <path|-> [--mode all|first] [--order copilot,codex] [--cwd <dir>] [--out-dir <dir>] [--nim-model M] [--openrouter-model M] [--dsapi-model M] | --check-updates | --update | --check-nim-models');
    process.exit(2);
  }

  const { order, dropped } = parseOrderDetailed(args.order || process.env.CONSULT_ORDER, undefined, {
    nimModel: args.nimModel || process.env.NIM_MODEL,
    openrouterModel: args.openrouterModel || process.env.OPENROUTER_MODEL,
    dsapiModel: args.dsapiModel || process.env.DSAPI_MODEL,
  });
  if (dropped.length) console.error(`consult: ignoring invalid order entries: ${dropped.join(", ")}`);
  if (!order.length) {
    console.error("consult: no valid engine in the order (use engine or engine:model; a model only on copilot, codex, nim, deepseek, openrouter, dsapi)");
    process.exit(2);
  }

  // A stale cache is refreshed by a detached child; the footer only ever uses the cached result.
  const updates = checkUpdates({ detach: spawnRefresh });

  const cwd = args.cwd || process.cwd();
  const mode = args.mode || (process.env.CONSULT_MODE === "first" ? "first" : "all");
  // Only runs that use nim see the NIM notice (cached view; a stale cache triggers a detached refresh).
  // The throttle is decided in finish(), right before printing: a run can take minutes, and parallel runs
  // must see each other's shows.
  const nimCache = orderUsesNim(order) ? peekNimModels() : null;
  const opts = {
    copilot: { model: args.copilotModel, effort: args.copilotEffort },
    codex: { model: args.codexModel, effort: args.codexEffort },
    nim: { model: args.nimModel },
    openrouter: { model: args.openrouterModel },
    dsapi: { model: args.dsapiModel },
  };
  const run = (name) => runSpec(name, { prompt, cwd, timeoutSec: TIMEOUT_SEC }, opts);

  // Resolves true once the stream has flushed `text` (a write to a closed pipe reports false).
  const write = (stream, text) => new Promise((resolve) => stream.write(text, (err) => resolve(!err)));
  const finish = async (code) => {
    const nimGate = nimCache ? nimNoticeGate(nimCache) : null; // at most 3 shows a day (shared throttle file)
    // dsapi soft alarm: only for runs that can call the official API (dsapi listed, or deepseek falling back to it).
    const dsapiNote = order.some((s) => /^(dsapi|deepseek)(:|$)/.test(s)) ? dsapiUsageNotice() : null;
    const footer = [formatFooter(updates.items), nimGate?.text, dsapiNote].filter(Boolean).join("\n");
    // Piped stdio can be asynchronous: drain stdout, then the footer, before exiting.
    await write(process.stdout, "");
    const written = footer ? await write(process.stderr, `${footer}\n`) : false;
    if (written && nimGate?.text) nimGate.commit(); // only count a notice that was really delivered
    process.exit(code);
  };

  if (mode === "first") {
    const { result: r, trail } = await runChain(order, run);
    if (r) {
      console.log(r.body);
      const note = lastResortNote(r);
      console.log(`\n---\n[consult] mode: first | engine: ${r.engine}${trail.length ? ` | failover: ${trail.join("; ")}` : ""}${note ? ` | note: ${note}` : ""}`);
      return finish(0);
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
