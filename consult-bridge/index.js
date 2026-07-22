#!/usr/bin/env node
// consult-bridge: one tool, `consult`, over a panel of consultant CLIs
// (copilot, codex, agy). Default mode "all" runs every engine in parallel and
// returns each successful answer labeled by engine — rationale: the engines sit
// on different plan tiers (agy = paid Gemini Pro, others free), so first-come-
// first-serve would systematically prefer the weakest agent. Mode "first" keeps
// the sequential fallback chain (cheap free tiers first, agy last resort).

import { z } from "zod";
import { startServer, truncate, positiveInt, okText, errText } from "../lib/common.js";
import { ENGINES, ENGINE_NAMES } from "../lib/engines.js";

const TIMEOUT_SEC = positiveInt(process.env.CONSULT_TIMEOUT, 300); // per engine
const MAX_OUTPUT_CHARS = positiveInt(process.env.CONSULT_MAX_OUTPUT_CHARS, 50000);
const PER_ENGINE_CHARS = positiveInt(process.env.CONSULT_PER_ENGINE_CHARS, 20000);

function defaultOrder() {
  const raw = (process.env.CONSULT_ORDER || "copilot,codex,agy")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ENGINE_NAMES.includes(s));
  return raw.length ? raw : ["copilot", "codex", "agy"];
}

startServer("consult-bridge", "0.1.0", (server) => {
  server.registerTool(
    "consult",
    {
      description:
        "Consult a panel of external models. Default mode 'all' runs GitHub Copilot CLI, OpenAI Codex CLI, and the Antigravity CLI (Gemini) IN PARALLEL and returns every successful answer labeled by engine — use it for cross-model second opinions where perspective diversity matters. Mode 'first' is a sequential fallback chain (copilot -> codex -> agy) returning the first success — cheaper, use for routine questions or when quotas are tight. All engines run read-only/restrictive in `cwd`. Failures (quota, auth, timeout) are reported in the footer, never fatal unless every engine fails.",
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
          .array(z.enum(["copilot", "codex", "agy"]))
          .optional()
          .describe(
            "Engine set (mode 'all') or chain order (mode 'first'). Defaults to copilot,codex,agy (or CONSULT_ORDER env). Pass a single entry to force one engine.",
          ),
      },
    },
    async (args) => {
      const cwd = args.cwd || process.cwd();
      const mode = args.mode || (process.env.CONSULT_MODE === "first" ? "first" : "all");
      const order = args.order?.length ? args.order : defaultOrder();
      const run = (name) => ENGINES[name]({ prompt: args.prompt, cwd, timeoutSec: TIMEOUT_SEC });

      if (mode === "first") {
        const trail = [];
        for (const name of order) {
          const r = await run(name);
          if (r.ok) {
            const { text } = truncate(r.body, MAX_OUTPUT_CHARS);
            const meta = [`mode: first`, `engine: ${name}`];
            if (trail.length) meta.push(`failover: ${trail.join("; ")}`);
            return okText(`${text}\n\n---\n[consult] ${meta.join(" | ")}`);
          }
          trail.push(`${name}: ${r.reason}`);
        }
        return errText(
          `consult: all engines failed.\n${trail.map((t) => `- ${t}`).join("\n")}\n\nCheck auth (copilot login / codex login / agy) or quotas, then retry.`,
        );
      }

      // Panel mode: fan out in parallel, aggregate every success.
      const results = await Promise.all(order.map(run));
      const good = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok).map((r) => `${r.engine}: ${r.reason}`);

      if (!good.length) {
        return errText(
          `consult: all engines failed.\n${failed.map((t) => `- ${t}`).join("\n")}\n\nCheck auth (copilot login / codex login / agy) or quotas, then retry.`,
        );
      }

      const perCap = good.length > 1 ? PER_ENGINE_CHARS : MAX_OUTPUT_CHARS;
      const sections = good.map((r) => `## ${r.engine}\n\n${truncate(r.body, perCap).text}`);
      const meta = [`mode: all`, `answered: ${good.map((r) => r.engine).join(", ")}`];
      if (failed.length) meta.push(`failed: ${failed.join("; ")}`);
      return okText(`${sections.join("\n\n")}\n\n---\n[consult] ${meta.join(" | ")}`);
    },
  );
});
