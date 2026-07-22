#!/usr/bin/env node
// copilot-bridge: wraps headless `copilot -p "<prompt>"` with restrictive tool
// permissions and returns Copilot's stdout. Modeled on the agy-bridge pattern.

import { z } from "zod";
import {
  startServer,
  runCli,
  truncate,
  positiveInt,
  resolveCopilot,
  okText,
  errText,
} from "../lib/common.js";

const TIMEOUT_SEC = positiveInt(process.env.COPILOT_BRIDGE_TIMEOUT, 600);
const MAX_OUTPUT_CHARS = positiveInt(process.env.COPILOT_BRIDGE_MAX_OUTPUT_CHARS, 50000);
const DEFAULT_MODEL = process.env.COPILOT_BRIDGE_MODEL || undefined;

// Restrictive, read-mostly permission posture: no file writes, only a safe set of
// read/search/VCS shell commands auto-approved. Everything else is neither allowed
// nor promptable in headless mode, so it simply cannot run. Deny rules beat allow
// rules in Copilot, so `--deny-tool=write` is authoritative.
// Override wholesale with COPILOT_BRIDGE_PERM_ARGS (a JSON array or whitespace list).
const DEFAULT_PERM_ARGS = [
  "-s",
  "--no-color",
  "--no-ask-user",
  "--deny-tool=write",
  "--allow-tool=shell(ls)",
  "--allow-tool=shell(dir)",
  "--allow-tool=shell(cat)",
  "--allow-tool=shell(type)",
  "--allow-tool=shell(head)",
  "--allow-tool=shell(tail)",
  "--allow-tool=shell(grep)",
  "--allow-tool=shell(rg)",
  "--allow-tool=shell(find)",
  "--allow-tool=shell(pwd)",
  "--allow-tool=shell(wc)",
  "--allow-tool=shell(git:*)",
  "--allow-tool=shell(gh:*)",
];

function permArgs() {
  const raw = process.env.COPILOT_BRIDGE_PERM_ARGS;
  if (!raw) return DEFAULT_PERM_ARGS;
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through to whitespace split */
    }
  }
  return t.split(/\s+/).filter(Boolean);
}

startServer("copilot-bridge", "0.1.0", (server) => {
  server.registerTool(
    "copilot_exec",
    {
      description:
        "Delegate a task to the GitHub Copilot CLI, headless and non-interactive, with restrictive tool permissions (no file writes; only read/search/git-gh shell commands are auto-approved). Returns Copilot's stdout. Use it for a cross-model second opinion or Copilot-specific strengths. It can read and search files under `cwd` but cannot modify them.",
      inputSchema: {
        prompt: z.string().describe("The complete task/question for Copilot."),
        cwd: z
          .string()
          .optional()
          .describe("Absolute working directory Copilot runs in. Defaults to the server's cwd."),
        model: z
          .string()
          .optional()
          .describe("Override the Copilot model (e.g. 'gpt-5.4', or 'auto'). Normally omit."),
      },
    },
    async (args) => {
      const cwd = args.cwd || process.cwd();
      const model = args.model || DEFAULT_MODEL;
      const { cmd, pre } = resolveCopilot();
      const cliArgs = [
        ...pre,
        "-p",
        args.prompt,
        "-C",
        cwd,
        ...permArgs(),
        ...(model ? ["--model", model] : []),
      ];

      let res;
      try {
        res = await runCli({ cmd, args: cliArgs, cwd, timeoutSec: TIMEOUT_SEC });
      } catch (e) {
        return errText(
          `copilot-bridge: failed to launch Copilot (${e.message}). Ensure '@github/copilot' is installed (npm i -g @github/copilot) and authenticated (copilot login), or set COPILOT_BRIDGE_BIN.`,
        );
      }

      const body = res.stdout.trim();
      if (res.timedOut) {
        return errText(
          `copilot-bridge: Copilot timed out after ${TIMEOUT_SEC}s (COPILOT_BRIDGE_TIMEOUT to adjust).${
            body ? `\n\nPartial stdout:\n${body}` : ""
          }`,
        );
      }
      if (!body) {
        const tail = res.stderr.trim().slice(-2000);
        return errText(
          `copilot-bridge: Copilot returned no output (exit ${res.code}). This usually means it is not logged in (run 'copilot login') or a permitted tool was blocked.${
            tail ? `\n\nstderr:\n${tail}` : ""
          }`,
        );
      }

      const { text } = truncate(body, MAX_OUTPUT_CHARS);
      return okText(
        `${text}\n\n---\n[copilot-bridge] model: ${model || "copilot default"} | exit: ${res.code}`,
      );
    },
  );
});
