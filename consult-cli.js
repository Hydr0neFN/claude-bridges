#!/usr/bin/env node
// consult-cli: same panel as consult-bridge, invoked as a plain command instead
// of an MCP server. Rationale: as an MCP the tool schema sits in every request's
// context floor and can be left dangling by tool-search deferral; as a CLI it
// costs nothing until called. Shares lib/engines.js with the MCP version.
//
// Engines: copilot, codex, deepseek, agy, nim, openrouter, dsapi
// Usage: consult "<prompt>" | --prompt-file <path|-> [--mode all|first] [--order copilot,codex] [--cwd <dir>] [--out-dir <dir>]
//        [--copilot-model M] [--copilot-effort E] [--codex-model M] [--codex-effort E] [--nim-model M] [--openrouter-model M] [--dsapi-model M]
//        --order entries are `engine` or `engine:model`, e.g. nim:moonshotai/kimi-k3,codex (model wins over the flags)
//        consult --debate <spec.json> --out-dir <dir>   (structured debate, up to 3 rounds; writes <dir>/digest.md, prints its path + a TALLY line)
//        --json (with a prompt, --mode all|first or --debate): stdout is exactly one {ok,code,message,data} object (docs/cli-json.md)
//        --ignore-locks: run engines even while quota-locked (and write no new locks); consult --locks | --unlock <engine|all>
//        (an engine that reports a usage/quota limit is locked until its reset time, state in ~/.claude/state/consult-locks.json)
//        consult --round2 <round-1 out-dir>   (round 2: answering engines see each other's round-1 answers, critique, may revise; writes <dir>/round2/, prints a dissent block)
//        consult --check-updates | --update | --check-nim-models | --refresh-nim-models

import fs from "node:fs";
import path from "node:path";
import { runSpec, dsapiUsageNotice } from "./lib/engines.js";
import { validateSpec, loadContext, runDebate } from "./lib/debate.js";
import { parseArgs, parseOrderDetailed, resolvePrompt, retiredInOrder } from "./lib/args.js";
import { runEnvelope, envelope, EXIT } from "./lib/cli-json.js";
import { runPanel, runChain, lastResortNote, formatSection, summaryLine, writeEngineResult, writeDone } from "./lib/panel.js";
import { checkUpdates, spawnRefresh, settle, applyUpdates, formatFooter } from "./lib/updates.js";
import { readRound1, buildRound2Prompt, dissentBlock } from "./lib/round2.js";
import { withLocks, activeLocks, unlock, localTime } from "./lib/locks.js";
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
} else if (args.locks || args.unlock) {
  if (args.unlock) {
    const done = unlock(args.unlock);
    console.log(done.length ? `[consult] unlocked: ${done.join(", ")}` : `[consult] no lock for ${args.unlock}`);
  } else {
    const rows = Object.entries(activeLocks()).map(([n, e]) => `${n}: locked until ${localTime(e.until)} (${e.reason})`);
    console.log(rows.length ? rows.join("\n") : "[consult] no active locks");
  }
  process.exit(0);
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

// --json: the envelope is the whole stdout; the human message still goes to stderr.
function jsonFail(code, message) {
  if (args.json) console.log(JSON.stringify(envelope(false, code, message, {})));
}

async function main() {
  let prompt;
  try {
    prompt = args.debate || args.round2 ? "" : resolvePrompt(args);
  } catch (e) {
    console.error(`consult: ${e.message}`);
    const missing = args.json && args.promptFile && args.promptFile !== "-" && !fs.existsSync(args.promptFile);
    jsonFail(missing ? "NOT_FOUND" : "USAGE", e.message);
    process.exit(missing ? EXIT.notFound : 2);
  }
  if (!prompt && !args.debate && !args.round2) {
    jsonFail("USAGE", "no prompt given");
    console.error('usage: consult "<prompt>" | --prompt-file <path|-> [--mode all|first] [--order copilot,codex] [--cwd <dir>] [--out-dir <dir>] [--nim-model M] [--openrouter-model M] [--dsapi-model M] | --debate <spec.json> --out-dir <dir> | --check-updates | --update | --check-nim-models');
    process.exit(2);
  }

  // agy is in the default set only while it drains its remaining quota (owner 2026-10-27); drop it here and in lib/args.js once it reports quota exhausted.
  const rawOrder = args.order || process.env.CONSULT_ORDER || "copilot,codex,deepseek,agy,nim,openrouter";
  // A retired engine is a hard usage error, not a silent drop (parseOrderDetailed still drops unknown entries).
  const retiredEntry = retiredInOrder(rawOrder);
  if (retiredEntry) {
    const msg = `consult: engine ${retiredEntry} was removed (unknown engine); use copilot,codex,deepseek,agy,nim,openrouter`;
    jsonFail("USAGE", msg);
    console.error(msg);
    process.exit(2);
  }
  const { order, dropped } = parseOrderDetailed(rawOrder, undefined, {
    nimModel: args.nimModel || process.env.NIM_MODEL,
    openrouterModel: args.openrouterModel || process.env.OPENROUTER_MODEL,
    dsapiModel: args.dsapiModel || process.env.DSAPI_MODEL,
  });
  if (dropped.length) console.error(`consult: ignoring invalid order entries: ${dropped.join(", ")}`);
  if (!order.length) {
    console.error("consult: no valid engine in the order (use engine or engine:model; a model only on copilot, codex, nim, deepseek, openrouter, dsapi)");
    jsonFail("USAGE", "no valid engine in the order");
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
  if (args.outDir && !args.debate && !args.round2) {
    fs.mkdirSync(args.outDir, { recursive: true });
    fs.writeFileSync(path.join(args.outDir, "_prompt.md"), `${prompt}\n`); // lets --round2 <out-dir> re-ask without the prompt
  }
  const ran = []; // --json mode first: every engine tried, in order
  const runLocked = withLocks(runSpec, { ignore: args.ignoreLocks });
  const run = (name) => runLocked(name, { prompt, cwd, timeoutSec: TIMEOUT_SEC }, opts).then((r) => (ran.push(r), r));

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

  if (args.round2) {
    let r1;
    try {
      r1 = readRound1(args.round2);
      if (r1.answers.length < 2) throw new Error(`round 2 needs at least 2 round-1 answers in ${args.round2} (found ${r1.answers.length})`);
      if (!r1.prompt) throw new Error(`no ${path.join(args.round2, "_prompt.md")}: re-run round 1 with --out-dir, or write the question there`);
    } catch (e) {
      console.error(`consult: ${e.message}`);
      jsonFail(e?.code === "ENOENT" ? "NOT_FOUND" : "USAGE", e.message);
      return finish(e?.code === "ENOENT" ? EXIT.notFound : 2);
    }
    const dir2 = path.join(args.round2, "round2");
    const results2 = await runPanel({
      order: r1.answers.map((a) => a.label),
      run: (name) => runLocked(name, { prompt: buildRound2Prompt(r1.prompt, r1.answers, r1.answers.findIndex((a) => a.label === name)), cwd, timeoutSec: TIMEOUT_SEC }, opts),
      onSettle: (name, r) => {
        if (!args.json) console.log(formatSection(r));
        writeEngineResult(dir2, name, r);
      },
    });
    const block = dissentBlock(results2);
    writeDone(dir2, block);
    if (args.json) console.log(JSON.stringify(envelope(results2.some((r) => r.ok), results2.some((r) => r.ok) ? "OK" : "ALL_ENGINES_FAILED", "round 2 finished", { out_dir: dir2, dissent: block })));
    else console.log(`---\n${block}`);
    return finish(results2.some((r) => r.ok) ? 0 : 1);
  }

  if (args.debate) {
    // Debate: spec problems are usage errors (exit 2); engine failures are contained inside runDebate.
    let spec;
    try {
      if (!args.outDir) throw new Error("--debate needs --out-dir <dir>");
      spec = validateSpec(JSON.parse(fs.readFileSync(args.debate, "utf8")));
    } catch (e) {
      console.error(`consult: ${e.message}`);
      const missing = args.json && e?.code === "ENOENT";
      jsonFail(missing ? "NOT_FOUND" : "USAGE", e.message);
      return finish(missing ? EXIT.notFound : 2);
    }
    const { digestPath, tally } = await runDebate({
      spec,
      outDir: args.outDir,
      ctx: loadContext(spec),
      run: (name, p) => runLocked(name, { prompt: p, cwd, timeoutSec: TIMEOUT_SEC }, opts),
    });
    if (args.json) console.log(JSON.stringify(envelope(true, "OK", "debate finished", { digest_path: digestPath, tally, out_dir: args.outDir })));
    else console.log(`${digestPath}
${tally}`);
    return finish(0);
  }

  if (mode === "first") {
    const { result: r, trail } = await runChain(order, run);
    if (args.json) {
      const env = runEnvelope({ mode: "first", results: ran, trail });
      if (!env.ok) console.error(`consult: all engines failed.\n${trail.map((t) => `- ${t}`).join("\n")}`);
      console.log(JSON.stringify(env));
      return finish(env.ok ? 0 : 1);
    }
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
      if (!args.json) console.log(formatSection(r));
      if (args.outDir) writeEngineResult(args.outDir, name, r);
    },
  });
  const summary = summaryLine(results);
  if (args.json) {
    const env = runEnvelope({ mode: "all", results, outDir: args.outDir || undefined });
    if (args.outDir) writeDone(args.outDir, summary || `consult: all engines failed.\n${results.map((r) => `- ${r.engine}: ${r.reason}`).join("\n")}`);
    if (!summary) console.error(`consult: all engines failed.\n${results.map((r) => `- ${r.engine}: ${r.reason}`).join("\n")}`);
    console.log(JSON.stringify(env));
    return finish(summary ? 0 : 1);
  }
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
