// Pure argument parsing for consult-cli.

import fs from "node:fs";
import { ENGINE_NAMES, MODEL_ENGINES, DEFAULT_NIM_MODEL, DEFAULT_OPENROUTER_MODEL, DEFAULT_DSAPI_MODEL, parseSpec } from "./engines.js";

const VALUE_FLAGS = {
  "--mode": "mode",
  "--order": "order",
  "--cwd": "cwd",
  "--out-dir": "outDir",
  "--prompt-file": "promptFile",
  "--debate": "debate",
  "--copilot-model": "copilotModel",
  "--copilot-effort": "copilotEffort",
  "--codex-model": "codexModel",
  "--codex-effort": "codexEffort",
  "--nim-model": "nimModel",
  "--openrouter-model": "openrouterModel",
  "--dsapi-model": "dsapiModel",
};
const BOOL_FLAGS = {
  "--check-updates": "checkUpdates",
  "--update": "update",
  "--check-nim-models": "checkNimModels",
  "--refresh-nim-models": "refreshNimModels",
  "--json": "json", // one {ok,code,message,data} object on stdout (docs/cli-json.md); without it the output is unchanged
};

export function parseArgs(argv) {
  const has = (o, k) => Object.hasOwn(o, k);
  const out = { prompt: [], checkUpdates: false, update: false, checkNimModels: false, refreshNimModels: false, json: false };
  for (const k of Object.values(VALUE_FLAGS)) out[k] = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (has(VALUE_FLAGS, a)) out[VALUE_FLAGS[a]] = argv[++i] ?? null;
    else if (has(BOOL_FLAGS, a)) out[BOOL_FLAGS[a]] = true;
    else out.prompt.push(a);
  }
  return out;
}

/**
 * Prompt text from positional words or --prompt-file ("-" = stdin); never both.
 * A long prompt (e.g. a diff) can exceed the OS command-line limit, hence the file.
 * Throws an Error with a user-facing message on misuse.
 */
export function resolvePrompt({ prompt, promptFile }, { readFile = (p) => fs.readFileSync(p, "utf8"), readStdin = () => fs.readFileSync(0, "utf8") } = {}) {
  if (promptFile && prompt.length) throw new Error("give the prompt either as words or via --prompt-file, not both");
  if (!promptFile) return prompt.join(" ").trim();
  try {
    return (promptFile === "-" ? readStdin() : readFile(promptFile)).trim();
  } catch (e) {
    throw new Error(`cannot read prompt from ${promptFile === "-" ? "stdin" : promptFile}: ${e.message}`);
  }
}

// An entry is `engine` or `engine:model`; a model is only valid on engines that take one.
function validSpec(spec) {
  const { engine, model } = parseSpec(spec);
  if (!ENGINE_NAMES.includes(engine)) return false;
  return model === null || (model !== "" && MODEL_ENGINES.includes(engine));
}

/** Drop blank entries (e.g. [""]); an order with none left means "no order given". */
export const nonBlank = (list) => (list || []).map((s) => String(s).trim()).filter(Boolean);

/**
 * -> { order: valid, normalised, deduped specs; dropped: entries that were not valid }.
 * `nimModel` / `openrouterModel` / `dsapiModel` are the models a bare `nim` / `openrouter` / `dsapi` resolve to (flag/env);
 * `nim:<that model>` is normalised to bare `nim` (likewise openrouter, dsapi) so the two never run twice under one label.
 */
export function parseOrderDetailed(raw, fallback = "copilot,codex,deepseek,agy,nim,openrouter", { nimModel, openrouterModel, dsapiModel } = {}) {
  const entries = (raw || fallback).split(",").map((s) => s.trim()).filter(Boolean);
  const defaults = { nim: nimModel || DEFAULT_NIM_MODEL, openrouter: openrouterModel || DEFAULT_OPENROUTER_MODEL, dsapi: dsapiModel || DEFAULT_DSAPI_MODEL };
  const specs = entries.filter(validSpec).map((s) => {
    const { engine, model } = parseSpec(s);
    if (model === null || (Object.hasOwn(defaults, engine) && model === defaults[engine])) return engine;
    return `${engine}:${model}`;
  });
  return { order: [...new Set(specs)], dropped: entries.filter((s) => !validSpec(s)) };
}

export const parseOrder = (raw, fallback, opts) => parseOrderDetailed(raw, fallback, opts).order;
