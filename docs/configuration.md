# Configuration (env vars)

Every environment variable the bridges read, with its default.

## Common

| Variable | Default | Description |
|---|---|---|
| `*_TIMEOUT` | `600` | Per-engine timeout in seconds |
| `*_MAX_OUTPUT_CHARS` | `50000` | Truncation cap for output |
| `*_MODEL` | (engine default) | Override the model |
| `*_BIN` | (auto-resolved) | Override the CLI executable path |

Overrides for the consult panel: `COPILOT_BRIDGE_BIN`, `CODEX_BRIDGE_BIN`, `AGY_PATH`, `GROK_PATH`.

## copilot-bridge

| Variable | Default | Description |
|---|---|---|
| `COPILOT_BRIDGE_PERM_ARGS` | (restrictive defaults) | Replace permission flags wholesale. JSON array or whitespace-separated string. Deny rules always beat allow rules in Copilot. |

## codex-bridge

| Variable | Default | Description |
|---|---|---|
| `CODEX_BRIDGE_SANDBOX` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access`. Also overridable per call via the `sandbox` argument. |

## consult-bridge

| Variable | Default | Description |
|---|---|---|
| `CONSULT_TIMEOUT` | `300` | Per-engine timeout in seconds (not used by `nim`, see `NIM_TIMEOUT`) |
| `CONSULT_MAX_OUTPUT_CHARS` | `50000` | Total output truncation cap |
| `CONSULT_PER_ENGINE_CHARS` | `20000` | Per-engine truncation in `all` mode |
| `CONSULT_ORDER` | `copilot,codex,deepseek,agy,nim,openrouter,opencode,azure,gemini` | Default engine order |
| `CONSULT_MODE` | `all` | Default mode (`all` or `first`) |
| `COPILOT_MODEL` | (unset = auto) | Passed as `--model` only when set. If Copilot rejects it (auto-only plans such as Student), retried once on auto and labelled `copilot (auto; <model> unavailable on this plan)` |
| `COPILOT_EFFORT` | (unset) | `--reasoning-effort none\|minimal\|low\|medium\|high\|xhigh\|max` |
| `CODEX_MODEL` | (unset) | Passed as `-m` only when set |
| `CODEX_EFFORT` | (unset) | Passed as `-c model_reasoning_effort="..."` |
| `CLAUDE_BRIDGES_CACHE_DIR` | `~/.cache/claude-bridges` | Update-check cache location |
| `DEEPSEEKER_BASE` | `http://127.0.0.1:4000` | deeperseeker proxy base URL |
| `DEEPSEEKER_MODEL` | `v4.1flash` | Model id passed to the proxy |
| `DEEPSEEKER_API_KEY` | (read from proxy `.env`) | Proxy API key; falls back to `DEEPSEEKER_ENV_PATH` |
| `DEEPSEEKER_ENV_PATH` | `~/Claude/deeperseeker/.env` | Where to read the key from when the env var is unset |
| `NIM_API_KEY` | (unset) | NVIDIA NIM key; takes precedence over the key file |
| `NIM_KEY_PATH` | `~/.nvidia-nim-key` | Key file read when `NIM_API_KEY` is unset |
| `NIM_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b` | Default NIM model when neither the order entry nor `--nim-model` sets one (first step of the fallback chain) |
| `NIM_CHAIN` | `nvidia/nemotron-3-ultra-550b-a55b,minimaxai/minimax-m3.1-flash,nvidia/nemotron-3.5-super-vl-120b-a12b,z-ai/glm-5.3-flash,openai/gpt-oss-20b` | Comma list of models the fallback chain walks after the requested one (5 attempts at most; each step 120 s at most, whole chain within `NIM_TIMEOUT`) |
| `NIM_BASE` | `https://integrate.api.nvidia.com` | NIM API base URL |
| `NIM_MAX_TOKENS` | `8192` | `max_tokens` sent to NIM |
| `NIM_TIMEOUT` | `600` | NIM timeout in seconds (positive number); capped at 600, ignores `CONSULT_TIMEOUT`. MCP registrations need `"timeout": 660000` or more to use all of it |
| `NIM_MODELS_CHECK_DAYS` | `14` | Interval of the NIM new-model check (positive number of days) |
| `OPENROUTER_API_KEY` | (unset) | OpenRouter key; takes precedence over the key file |
| `OPENROUTER_KEY_PATH` | `~/.openrouter-key` | Key file read when `OPENROUTER_API_KEY` is unset (the first `sk-or-...` token is used) |
| `OPENROUTER_MODEL` | `baidu/ernie-5.5-flash-preview:free` | Default OpenRouter model when neither the order entry nor `--openrouter-model` sets one (first step of the fallback chain) |
| `OPENROUTER_CHAIN` | `baidu/ernie-5.5-flash-preview:free,dots-studio/dots-3-note-preview:free,cohere/north-mini-code:free,recursive/flint-v1.0:free,liquid/lfm-3-1.7b:free` | Comma list of models the fallback chain walks after the requested one (5 attempts at most; each step 60 s at most, whole chain within `OPENROUTER_TIMEOUT`) |
| `OPENROUTER_TIMEOUT` | `300` | Whole openrouter chain budget in seconds (positive number); capped at 600, ignores `CONSULT_TIMEOUT` |
| `DEEPSEEK_API_KEY` | (unset) | Official DeepSeek API key for `dsapi`; takes precedence over the key file |
| `DSAPI_KEY_PATH` | `~/.deepseek-api-key` | Key file read when `DEEPSEEK_API_KEY` is unset (the first `sk-...` token is used) |
| `DSAPI_MODEL` | `deepseek-flash` | Default `dsapi` model when neither the order entry nor `--dsapi-model` sets one; must be a flash id (no `pro`/`reasoner`) |
