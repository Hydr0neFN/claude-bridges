#!/usr/bin/env node
// consult-cli: same panel as consult-bridge, invoked as a plain command instead
// of an MCP server. Rationale: as an MCP the tool schema sits in every request's
// context floor and can be left dangling by tool-search deferral; as a CLI it
// costs nothing until called. Shares lib/engines.js with the MCP version.
//
// Usage: consult "<prompt>" [--mode all|first] [--order copilot,codex,agy] [--cwd <dir>]

import { ENGINES, ENGINE_NAMES } from "./lib/engines.js";

const TIMEOUT_SEC = Number(process.env.CONSULT_TIMEOUT) || 300;

function parseArgs(argv) {
  const out = { prompt: [], mode: null, order: null, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") out.mode = argv[++i];
    else if (a === "--order") out.order = argv[++i];
    else if (a === "--cwd") out.cwd = argv[++i];
    else out.prompt.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const prompt = args.prompt.join(" ").trim();

if (!prompt) {
  console.error('usage: consult "<prompt>" [--mode all|first] [--order copilot,codex,agy] [--cwd <dir>]');
  process.exit(2);
}

const cwd = args.cwd || process.cwd();
const mode = args.mode || (process.env.CONSULT_MODE === "first" ? "first" : "all");
const order = (args.order || process.env.CONSULT_ORDER || "copilot,codex,agy")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => ENGINE_NAMES.includes(s));

const run = (name) => ENGINES[name]({ prompt, cwd, timeoutSec: TIMEOUT_SEC });

if (mode === "first") {
  const trail = [];
  for (const name of order) {
    const r = await run(name);
    if (r.ok) {
      console.log(r.body);
      console.log(`\n---\n[consult] mode: first | engine: ${name}${trail.length ? ` | failover: ${trail.join("; ")}` : ""}`);
      process.exit(0);
    }
    trail.push(`${name}: ${r.reason}`);
  }
  console.error(`consult: all engines failed.\n${trail.map((t) => `- ${t}`).join("\n")}`);
  process.exit(1);
}

const results = await Promise.all(order.map(run));
const good = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok).map((r) => `${r.engine}: ${r.reason}`);

if (!good.length) {
  console.error(`consult: all engines failed.\n${failed.map((t) => `- ${t}`).join("\n")}`);
  process.exit(1);
}

for (const r of good) console.log(`## ${r.engine}\n\n${r.body}\n`);
console.log(`---\n[consult] mode: all | answered: ${good.map((r) => r.engine).join(", ")}${failed.length ? ` | failed: ${failed.join("; ")}` : ""}`);
