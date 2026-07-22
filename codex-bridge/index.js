#!/usr/bin/env node
// codex-bridge: wraps `codex exec "<prompt>"` (sandboxed read-only by default) and
// returns Codex's final message. Modeled on the agy-bridge pattern.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  startServer,
  runCli,
  truncate,
  positiveInt,
  resolveCodex,
  okText,
  errText,
} from "../lib/common.js";

const TIMEOUT_SEC = positiveInt(process.env.CODEX_BRIDGE_TIMEOUT, 600);
const MAX_OUTPUT_CHARS = positiveInt(process.env.CODEX_BRIDGE_MAX_OUTPUT_CHARS, 50000);
const DEFAULT_MODEL = process.env.CODEX_BRIDGE_MODEL || undefined;
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
const DEFAULT_SANDBOX = SANDBOX_MODES.includes(process.env.CODEX_BRIDGE_SANDBOX || "")
  ? process.env.CODEX_BRIDGE_SANDBOX
  : "read-only";

startServer("codex-bridge", "0.1.0", (server) => {
  server.registerTool(
    "codex_exec",
    {
      description:
        "Delegate a task to the OpenAI Codex CLI via `codex exec`, non-interactive and sandboxed read-only by default. Returns Codex's final message. Use it for a cross-model second opinion or Codex-specific strengths. Only pass sandbox='workspace-write' when you actually intend Codex to edit files under `cwd`.",
      inputSchema: {
        prompt: z.string().describe("The complete task/question for Codex."),
        cwd: z
          .string()
          .optional()
          .describe("Absolute working root Codex runs in (passed as -C). Defaults to the server's cwd."),
        model: z.string().optional().describe("Override the Codex model (e.g. 'o3'). Normally omit."),
        sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional()
          .describe(
            "Codex sandbox policy. Defaults to 'read-only'. Use 'workspace-write' only when edits in cwd are intended.",
          ),
      },
    },
    async (args) => {
      const cwd = args.cwd || process.cwd();
      const sandbox = args.sandbox || DEFAULT_SANDBOX;
      const model = args.model || DEFAULT_MODEL;
      const outFile = path.join(os.tmpdir(), `codex-bridge-${process.pid}-${randomUUID()}.txt`);
      const { cmd, pre } = resolveCodex();
      const cliArgs = [
        ...pre,
        "exec",
        args.prompt,
        "-C",
        cwd,
        "--sandbox",
        sandbox,
        "--skip-git-repo-check",
        "--color",
        "never",
        "-o",
        outFile,
        ...(model ? ["-m", model] : []),
      ];

      let res;
      try {
        res = await runCli({ cmd, args: cliArgs, cwd, timeoutSec: TIMEOUT_SEC });
      } catch (e) {
        return errText(
          `codex-bridge: failed to launch Codex (${e.message}). Ensure '@openai/codex' is installed (npm i -g @openai/codex) and authenticated (codex login), or set CODEX_BRIDGE_BIN.`,
        );
      }

      // `-o` writes just the final assistant message; prefer it over the noisier stdout.
      let finalMsg = "";
      try {
        finalMsg = fs.readFileSync(outFile, "utf8").trim();
      } catch {
        /* file may not exist if codex errored early */
      }
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* best effort cleanup */
      }

      const body = finalMsg || res.stdout.trim();
      if (res.timedOut) {
        return errText(
          `codex-bridge: Codex timed out after ${TIMEOUT_SEC}s (CODEX_BRIDGE_TIMEOUT to adjust).${
            body ? `\n\nPartial output:\n${body}` : ""
          }`,
        );
      }
      if (!body) {
        const tail = res.stderr.trim().slice(-2000);
        return errText(
          `codex-bridge: Codex returned no output (exit ${res.code}). This usually means it is not logged in (run 'codex login').${
            tail ? `\n\nstderr:\n${tail}` : ""
          }`,
        );
      }

      const { text } = truncate(body, MAX_OUTPUT_CHARS);
      return okText(
        `${text}\n\n---\n[codex-bridge] sandbox: ${sandbox} | model: ${
          model || "codex default"
        } | exit: ${res.code}`,
      );
    },
  );
});
