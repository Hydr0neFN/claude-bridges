// Pure argument parsing for consult-cli.

import { ENGINE_NAMES } from "./engines.js";

const VALUE_FLAGS = {
  "--mode": "mode",
  "--order": "order",
  "--cwd": "cwd",
  "--out-dir": "outDir",
  "--copilot-model": "copilotModel",
  "--copilot-effort": "copilotEffort",
  "--codex-model": "codexModel",
  "--codex-effort": "codexEffort",
};
const BOOL_FLAGS = { "--check-updates": "checkUpdates", "--update": "update" };

export function parseArgs(argv) {
  const out = { prompt: [], checkUpdates: false, update: false };
  for (const k of Object.values(VALUE_FLAGS)) out[k] = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in VALUE_FLAGS) out[VALUE_FLAGS[a]] = argv[++i] ?? null;
    else if (a in BOOL_FLAGS) out[BOOL_FLAGS[a]] = true;
    else out.prompt.push(a);
  }
  return out;
}

export function parseOrder(raw, fallback = "copilot,codex,agy") {
  return (raw || fallback)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ENGINE_NAMES.includes(s));
}
