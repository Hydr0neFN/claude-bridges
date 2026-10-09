**English** · [繁體中文](README.zh-TW.md)

# claude-bridges

MCP servers that let Claude Code delegate to other coding CLIs — cross-model second opinions, structured reviews, and a multi-engine consultation panel.

Most people use AI to autocomplete or to ask one model one question. I use multiple models as a structured thinking system with checks and balances: debate, execute, review, cross-check, iterate.

## The Thinking Loop

```mermaid
flowchart TD
    A["🧠 I think / identify problem"] --> B["Claude Opus 4.6 @ claude.ai<br/>(debates with me, holds personal memory)"]
    B --> C["Claude Code: Fable refines plan<br/>(optional, costly)"]
    C --> D["Claude Code: Sonnet 5 executes<br/>(Opus 4.8 advisor) → HANDOFF.md"]
    D --> E["Opus 4.6 reviews with me"]
    E --> F{"Cross-model review<br/>(consult-bridge)"}
    F --> G["Gemini (agy-bridge)"]
    F --> H["GitHub Copilot CLI"]
    F --> I["OpenAI Codex CLI"]
    F -.-> J["Grok / others<br/>(planned, not yet wired)"]
    G & H & I --> K["Synthesize + next iteration"]
    K --> A

    style A fill:#2d3748,color:#fff
    style F fill:#4a5568,color:#fff
    style J fill:#718096,color:#a0aec0,stroke-dasharray: 5 5
```

This isn't "ask ChatGPT." Each model has a role, a sandbox, and a review gate. No single model's output ships unchecked.

## What's Actually Wired

The `consult` tool currently fans out to **four engines**:

| Engine | Wraps | Tier |
|---|---|---|
| `copilot` | GitHub Copilot CLI (`copilot -p`) | Free (GitHub) |
| `codex` | OpenAI Codex CLI (`codex exec`) | Free (ChatGPT) |
| `agy` | Antigravity / Gemini CLI | Paid (Gemini Pro/Flash) |
| `deepseek` | `deeperseeker` proxy over a DeepSeek web account (HTTP, not a CLI) | Free (throwaway account) |

`deepseek` is opt-in: it is not in the default `CONSULT_ORDER`, so pass `--order ...,deepseek`
or set `CONSULT_ORDER` to include it. Unlike the CLI engines it gets no cwd, shell or file
access — it only ever sees the prompt text, so give it self-contained prompts.

Grok and others are in the aspirational loop but don't have bridges yet. The system is designed to add engines — each is ~30 lines in `lib/engines.js`.

## Architecture

```
claude-bridges/
  package.json            shared deps (@modelcontextprotocol/sdk, zod)
  node_modules/           one install serves all bridges
  lib/
    common.js             shared MCP boilerplate, CLI runner, cross-platform exe resolution
    engines.js            engine runners shared by consult-bridge and consult-cli
    args.js               consult-cli argument parsing
    updates.js            throttled update check + --update
  consult-cli.js          same panel as a plain command (no MCP schema cost)
  test/                   node --test suite (npm test)
  copilot-bridge/
    index.js              standalone MCP server → copilot_exec tool
  codex-bridge/
    index.js              standalone MCP server → codex_exec tool
  consult-bridge/
    index.js              aggregator MCP server → consult tool
  agy-bridge-vendored/    vendored copy of the agy-bridge (Gemini)
```

Three MCP servers; `consult-bridge` is the one in active use, the other two are **legacy** (kept working, not registered by default):

| Bridge | Tool | Default Posture |
|---|---|---|
| `copilot-bridge` | `copilot_exec` | Restrictive: no file writes, only read/search/git-gh shell auto-approved |
| `codex-bridge` | `codex_exec` | Sandboxed `read-only` |
| `consult-bridge` | `consult` | Aggregator: runs engines in parallel (`mode: all`) or sequential fallback (`mode: first`) |

All three resolve CLI binaries through `lib/common.js` (PATH plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` on macOS/Linux; Windows AppData fallbacks only on Windows). `consult-bridge` and `consult-cli` build their own arguments in `lib/engines.js`. A missing CLI fails only its own engine, e.g. `copilot: not installed (looked in ...)`.

## Tools

### `consult` (the star)

Consult a panel of external models. Two modes:

- **`all`** (default) — runs every engine in parallel, returns all successful answers labeled by engine. Use for cross-model second opinions where perspective diversity matters.
- **`first`** — sequential fallback chain, first success wins. Cheaper, use for routine questions or tight quotas.

```
consult({
  prompt: "Review this auth middleware for timing attacks",
  mode: "all",           // "all" | "first"
  order: ["copilot", "codex", "agy"]  // engine set/chain order
})
```

Engine order configurable via `order` arg or `CONSULT_ORDER` env (default `copilot,codex,agy`). A failed engine (quota, auth, timeout, empty output, nonzero exit) fails over to the next; the trail is appended to the result.

### `copilot_exec`

Delegate to GitHub Copilot CLI, headless and non-interactive. Read-only by default — can read and search files under `cwd` but cannot modify them.

### `codex_exec`

Delegate to OpenAI Codex CLI via `codex exec`. Sandboxed read-only by default. Pass `sandbox: "workspace-write"` only when you actually intend Codex to edit files.

## Command line and updates

```bash
node consult-cli.js --mode all --order copilot,codex "prompt"
node consult-cli.js --copilot-model M --copilot-effort high --codex-model M --codex-effort low "prompt"
node consult-cli.js --out-dir /tmp/c "prompt"   # also write <dir>/<engine>.md as each engine settles, <dir>/_done at the end
node consult-cli.js --check-updates   # force a check now, print the result, exit
node consult-cli.js --update          # brew upgrade --cask <outdated CLIs>; git pull --ff-only (refuses on a dirty repo)
```

In `--mode all`, `consult-cli` prints each engine's whole `## <engine>` section (answer or `[failed] reason`) the moment it settles, in completion order, then the `[consult] mode: all | ...` summary last. Per-engine timeouts are independent, so a slow engine never delays the others. `consult-bridge` returns one aggregated result but uses the same runner (`lib/panel.js`).

On start, both `consult-cli` and `consult-bridge` check (at most once per 24h, cache in `~/.cache/claude-bridges/updates.json`) whether the engine CLIs (`brew outdated --cask` for brew-installed casks; `copilot version` otherwise) or this repo (`git fetch`, behind-count) are outdated. The check runs concurrently, never delays or fails a consult, and prints one footer line only when something is outdated (in the tool result for the MCP server). Nothing is installed without `--update`.

## Install

```powershell
cd ~/claude-bridges
npm install
```

A single `npm install` at the root serves all servers — Node resolves `node_modules` by walking up from each `index.js`.

## Register (user scope)

```powershell
claude mcp add-json copilot-bridge  '{"command":"node","args":["C:/Users/YOU/claude-bridges/copilot-bridge/index.js"],"timeout":600000}' -s user
claude mcp add-json codex-bridge    '{"command":"node","args":["C:/Users/YOU/claude-bridges/codex-bridge/index.js"],"timeout":600000}' -s user
claude mcp add-json consult-bridge  '{"command":"node","args":["C:/Users/YOU/claude-bridges/consult-bridge/index.js"],"timeout":600000}' -s user
```

Replace `C:/Users/YOU` with your actual home directory. All three CLIs must be authenticated first:

```bash
copilot login    # GitHub Copilot CLI
codex login      # OpenAI Codex CLI
# agy: see agy-bridge docs for Gemini auth
```

## Configuration (env vars)

### Common

| Variable | Default | Description |
|---|---|---|
| `*_TIMEOUT` | `600` | Per-engine timeout in seconds |
| `*_MAX_OUTPUT_CHARS` | `50000` | Truncation cap for output |
| `*_MODEL` | (engine default) | Override the model |
| `*_BIN` | (auto-resolved) | Override the CLI executable path |

Overrides for the consult panel: `COPILOT_BRIDGE_BIN`, `CODEX_BRIDGE_BIN`, `AGY_PATH`, `GROK_PATH`.

### copilot-bridge

| Variable | Default | Description |
|---|---|---|
| `COPILOT_BRIDGE_PERM_ARGS` | (restrictive defaults) | Replace permission flags wholesale. JSON array or whitespace-separated string. Deny rules always beat allow rules in Copilot. |

### codex-bridge

| Variable | Default | Description |
|---|---|---|
| `CODEX_BRIDGE_SANDBOX` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access`. Also overridable per call via the `sandbox` argument. |

### consult-bridge

| Variable | Default | Description |
|---|---|---|
| `CONSULT_TIMEOUT` | `300` | Per-engine timeout in seconds |
| `CONSULT_MAX_OUTPUT_CHARS` | `50000` | Total output truncation cap |
| `CONSULT_PER_ENGINE_CHARS` | `20000` | Per-engine truncation in `all` mode |
| `CONSULT_ORDER` | `copilot,codex,agy` | Default engine order |
| `CONSULT_MODE` | `all` | Default mode (`all` or `first`) |
| `COPILOT_MODEL` | (unset = auto) | Passed as `--model` only when set. If Copilot rejects it (auto-only plans such as Student), retried once on auto and labelled `copilot (auto; <model> unavailable on this plan)` |
| `COPILOT_EFFORT` | (unset) | `--reasoning-effort none\|minimal\|low\|medium\|high\|xhigh\|max` |
| `CODEX_MODEL` | (unset) | Passed as `-m` only when set |
| `CODEX_EFFORT` | (unset) | Passed as `-c model_reasoning_effort="..."` |
| `CLAUDE_BRIDGES_CACHE_DIR` | `~/.cache/claude-bridges` | Update-check cache location |
| `CLAUDE_BRIDGES_UPDATE_WAIT_MS` | `4000` | CLI only: max wait for a live update check before exiting (cached result is used otherwise) |
| `DEEPSEEKER_BASE` | `http://127.0.0.1:4000` | deeperseeker proxy base URL |
| `DEEPSEEKER_MODEL` | `v4.1flash` | Model id passed to the proxy |
| `DEEPSEEKER_API_KEY` | (read from proxy `.env`) | Proxy API key; falls back to `DEEPSEEKER_ENV_PATH` |
| `DEEPSEEKER_ENV_PATH` | `~/Claude/deeperseeker/.env` | Where to read the key from when the env var is unset |

## Why This Exists

I've been building things since junior high — first Arduino sketches, now PCBs and trading systems. AI is part of my toolkit and my learning loop: I think with Opus 4.6 (planner/debater by nature), execute with Sonnet 5 + Opus 4.8 (strict prompt-followers, built to ship), and cross-check across Gemini, Copilot, and Codex before anything lands.

Each model has a job that matches how it was trained:

- **Think** — Opus 4.6 @ claude.ai holds my personal memory, debates approaches, and stress-tests plans before I commit. Its training leans toward reasoning and nuance — exactly what planning needs.
- **Execute** — Sonnet 5 writes the code; Opus 4.8 reviews as advisor. Both are trained for strict prompt-following and precise output — they ship, not philosophize.
- **Cross-check** — `consult` fans out to Copilot, Codex, and Gemini in parallel. Different training data, different blind spots, independent verdicts. No single model gets the last word.
- **Iterate** — everything feeds back to me. I synthesize, decide, and kick off the next cycle. The human stays in the loop at every gate.

Beyond model selection, each delegation gets a **role prompt** — "As a Security auditor…", "As a Frontend engineer…", "As a Karpathy-style code reviewer…" — so the model responds from a specific expertise frame, not as a generic assistant. I maintain a full role table (20+ roles across engineering, product, content, and research) that maps each role to the right model tier and tool.

The bridges are the plumbing that makes cross-checking programmatic — not manual copy-paste between chat windows.
