# Bridges and tools

Three MCP servers; `consult-bridge` is the one in active use, the other two are **legacy** (kept working, not registered by default):

| Bridge | Tool | Default Posture |
|---|---|---|
| `copilot-bridge` | `copilot_exec` | Restrictive: no file writes, only read/search/git-gh shell auto-approved |
| `codex-bridge` | `codex_exec` | Sandboxed `read-only` |
| `consult-bridge` | `consult` | Aggregator: runs engines in parallel (`mode: all`) or sequential fallback (`mode: first`) |

All three resolve CLI binaries through `lib/common.js` (PATH plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` on macOS/Linux; Windows AppData fallbacks only on Windows). `consult-bridge` and `consult-cli` build their own arguments in `lib/engines.js`. A missing CLI fails only its own engine, e.g. `copilot: not installed (looked in ...)`.

## `consult` (the star)

Consult a panel of external models. Two modes:

- **`all`** (default) — runs every engine in parallel, returns all successful answers labeled by engine. Use for cross-model second opinions where perspective diversity matters.
- **`first`** — sequential fallback chain, first success wins. Cheaper, use for routine questions or tight quotas.

```
consult({
  prompt: "Review this auth middleware for timing attacks",
  mode: "all",           // "all" | "first"
  order: ["copilot", "codex", "deepseek"]  // engine set/chain order
})
```

Engine order configurable via `order` arg or `CONSULT_ORDER` env (default `copilot,codex,deepseek,agy,nim,openrouter,opencode,azure,gemini`); both accept `engine:model` entries (the MCP `order` is a list of strings; invalid entries are ignored and reported, and an order with no valid entry is an error). A failed engine (quota, auth, timeout, empty output, nonzero exit) fails over to the next; the trail is appended to the result.

## `copilot_exec`

Delegate to GitHub Copilot CLI, headless and non-interactive. Read-only by default — can read and search files under `cwd` but cannot modify them.

## `codex_exec`

Delegate to OpenAI Codex CLI via `codex exec`. Sandboxed read-only by default. Pass `sandbox: "workspace-write"` only when you actually intend Codex to edit files.
