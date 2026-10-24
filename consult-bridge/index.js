#!/usr/bin/env node
// consult-bridge: one tool, `consult`, over a panel of consultant CLIs
// (copilot, codex, deepseek by default; agy, nim and openrouter are opt-in, see lib/engines.js). Default mode "all" runs every engine in parallel and
// returns each successful answer labeled by engine — rationale: the engines sit
// on different plan tiers (agy = paid Gemini Pro, others free), so first-come-
// first-serve would systematically prefer the weakest agent. Mode "first" keeps
// the sequential fallback chain (cheap free tiers first, agy last resort when enabled).

import { z } from "zod";
import { startServer, truncate, positiveInt, okText, errText } from "../lib/common.js";
import { runSpec } from "../lib/engines.js";
import { runPanel, runChain, lastResortNote, authHint } from "../lib/panel.js";
import { parseOrder, parseOrderDetailed, nonBlank } from "../lib/args.js";
import { checkUpdates, formatFooter } from "../lib/updates.js";
import { peekNimModels, nimNoticeGate, orderUsesNim } from "../lib/nim-models.js";

const TIMEOUT_SEC = positiveInt(process.env.CONSULT_TIMEOUT, 300); // per engine
const MAX_OUTPUT_CHARS = positiveInt(process.env.CONSULT_MAX_OUTPUT_CHARS, 50000);
const PER_ENGINE_CHARS = positiveInt(process.env.CONSULT_PER_ENGINE_CHARS, 20000);

const NIM_OPTS = () => ({ nimModel: process.env.NIM_MODEL, openrouterModel: process.env.OPENROUTER_MODEL }); // what a bare `nim` / `openrouter` resolve to

function defaultOrder() {
  const raw = parseOrder(process.env.CONSULT_ORDER, undefined, NIM_OPTS());
  return raw.length ? raw : ["copilot", "codex", "deepseek"];
}

// Throttled (24h) update check, started with the server. Never blocks a call:
// the notice is whatever is known when the first result is built, shown once per
// server process, inside the tool result (stdout belongs to the MCP protocol).
// The NIM notice is throttled by a shared file (3 shows, then a day of silence), not per process.
const updates = checkUpdates();
let noticeShown = false;
const withNotice = (result, order) => {
  const lines = [];
  if (!noticeShown) {
    const footer = formatFooter(updates.items);
    if (footer) (noticeShown = true), lines.push(footer);
  }
  // NIM new-model notice only for runs that use nim; peek may spawn a detached refresh of a stale cache.
  const nim = orderUsesNim(order) ? nimNoticeGate(peekNimModels()) : null;
  if (nim?.text) lines.push(nim.text);
  if (!lines.length) return result;
  const last = result.content.length - 1;
  result.content[last] = { type: "text", text: `${result.content[last].text}\n${lines.join("\n")}` };
  nim?.commit();
  return result;
};

startServer("consult-bridge", "0.1.0", (server) => {
  server.registerTool(
    "consult",
    {
      description:
        "Consult a panel of external models. Default mode 'all' runs GitHub Copilot CLI and OpenAI Codex CLI IN PARALLEL and returns every successful answer labeled by engine — use it for cross-model second opinions where perspective diversity matters. Mode 'first' is a sequential fallback chain (copilot -> codex) returning the first success — cheaper, use for routine questions or when quotas are tight. All engines run read-only/restrictive in `cwd`. Failures (quota, auth, timeout) are reported in the footer, never fatal unless every engine fails.",
      inputSchema: {
        prompt: z.string().describe("The complete question/task for the consultant panel."),
        cwd: z
          .string()
          .optional()
          .describe("Absolute working directory the consultants may read. Defaults to the server's cwd."),
        mode: z
          .enum(["all", "first"])
          .optional()
          .describe(
            "'all' (default): run every engine in parallel, aggregate all successes. 'first': sequential fallback chain, first success wins.",
          ),
        order: z
          .array(z.string())
          .optional()
          .describe(
            "Engine set (mode 'all') or chain order (mode 'first'). Entries are an engine (copilot, codex, agy, nim, deepseek, openrouter) or engine:model (e.g. nim:nvidia/nemotron-3-ultra-550b-a55b; a model only on copilot, codex, nim, deepseek, openrouter). Defaults to copilot,codex,deepseek (or CONSULT_ORDER env); deepseek needs the local deeperseeker proxy and fails soft when it is down. agy, nim and openrouter are opt-in and only run when listed; openrouter (free models, rate-limited, falls back through 3 models) sees only the prompt text like nim and deepseek. Invalid entries are ignored and reported. Pass a single entry to force one engine.",
          ),
      },
    },
    async (args) => {
      const cwd = args.cwd || process.cwd();
      const mode = args.mode || (process.env.CONSULT_MODE === "first" ? "first" : "all");
      const given = nonBlank(args.order); // [""] counts as no order, so CONSULT_ORDER still applies
      const { order, dropped } = given.length
        ? parseOrderDetailed(given.join(","), undefined, NIM_OPTS())
        : { order: defaultOrder(), dropped: [] };
      if (!order.length) {
        return errText(`consult: no valid engine in order (invalid: ${dropped.join(", ")}). Use engine or engine:model; a model only on copilot, codex, nim, deepseek, openrouter.`);
      }
      const run = (name) => runSpec(name, { prompt: args.prompt, cwd, timeoutSec: TIMEOUT_SEC });
      updates.pending.then((r) => { updates.items = r.items; });

      if (mode === "first") {
        const { result: r, trail } = await runChain(order, run);
        if (r) {
          const { text } = truncate(r.body, MAX_OUTPUT_CHARS);
          const meta = [`mode: first`, `engine: ${r.engine}`];
          if (trail.length) meta.push(`failover: ${trail.join("; ")}`);
          if (lastResortNote(r)) meta.push(`note: ${lastResortNote(r)}`);
          if (dropped.length) meta.push(`ignored: ${dropped.join(", ")}`);
          return withNotice(okText(`${text}\n\n---\n[consult] ${meta.join(" | ")}`), order);
        }
        return errText(
          `consult: all engines failed.\n${trail.map((t) => `- ${t}`).join("\n")}${authHint(trail)}`,
        );
      }

      // Panel mode: fan out in parallel, aggregate every success.
      const results = await runPanel({ order, run }); // each engine has its own timeout
      const good = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok).map((r) => `${r.engine}: ${r.reason}`);

      if (!good.length) {
        return errText(
          `consult: all engines failed.\n${failed.map((t) => `- ${t}`).join("\n")}${authHint(failed)}`,
        );
      }

      const perCap = good.length > 1 ? PER_ENGINE_CHARS : MAX_OUTPUT_CHARS;
      const sections = good.map((r) => `## ${r.engine}\n\n${truncate(r.body, perCap).text}`);
      const meta = [`mode: all`, `answered: ${good.map((r) => r.engine).join(", ")}`];
      if (failed.length) meta.push(`failed: ${failed.join("; ")}`);
      if (dropped.length) meta.push(`ignored: ${dropped.join(", ")}`);
      return withNotice(okText(`${sections.join("\n\n")}\n\n---\n[consult] ${meta.join(" | ")}`), order);
    },
  );
});
