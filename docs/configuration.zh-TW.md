# 設定（環境變數）

bridge 會讀取的每一個環境變數與其預設值。

## 通用設定

| 變數 | 預設值 | 說明 |
|---|---|---|
| `*_TIMEOUT` | `600` | 各引擎逾時時間（秒） |
| `*_MAX_OUTPUT_CHARS` | `50000` | 輸出截斷上限字數 |
| `*_MODEL` | （引擎預設） | 覆寫所使用的模型 |
| `*_BIN` | （自動解析） | 覆寫 CLI 執行檔路徑 |

consult 小組的覆寫變數：`COPILOT_BRIDGE_BIN`、`CODEX_BRIDGE_BIN`、`AGY_PATH`、`GROK_PATH`。

## copilot-bridge

| 變數 | 預設值 | 說明 |
|---|---|---|
| `COPILOT_BRIDGE_PERM_ARGS` | （限制性預設值） | 整批替換權限旗標。JSON 陣列或以空白分隔的字串。在 Copilot 中拒絕規則（Deny）永遠優先於允許規則（Allow）。 |

## codex-bridge

| 變數 | 預設值 | 說明 |
|---|---|---|
| `CODEX_BRIDGE_SANDBOX` | `read-only` | `read-only`、`workspace-write` 或 `danger-full-access`。每次呼叫也可以用 `sandbox` 引數覆寫。 |

## consult-bridge

| 變數 | 預設值 | 說明 |
|---|---|---|
| `CONSULT_TIMEOUT` | `300` | 各引擎逾時時間（秒）（`nim` 不適用，請見 `NIM_TIMEOUT`） |
| `CONSULT_MAX_OUTPUT_CHARS` | `50000` | 總輸出截斷上限字數 |
| `CONSULT_PER_ENGINE_CHARS` | `20000` | `all` 模式下各引擎截斷字數 |
| `CONSULT_ORDER` | `copilot,codex,deepseek,agy,nim,openrouter,opencode,azure,gemini` | 預設引擎順序 |
| `CONSULT_MODE` | `all` | 預設模式（`all` 或 `first`） |
| `COPILOT_MODEL` | （未設 = auto） | 僅在設定時以 `--model` 傳入。若 Copilot 拒絕（如 Student 方案僅支援 auto），會改用 auto 重試一次並標示為 `copilot (auto; <model> unavailable on this plan)` |
| `COPILOT_EFFORT` | （未設） | `--reasoning-effort none\|minimal\|low\|medium\|high\|xhigh\|max` |
| `CODEX_MODEL` | （未設） | 僅在設定時以 `-m` 傳入 |
| `CODEX_EFFORT` | （未設） | 以 `-c model_reasoning_effort="..."` 傳入 |
| `CLAUDE_BRIDGES_CACHE_DIR` | `~/.cache/claude-bridges` | 更新檢查的快取位置 |
| `DEEPSEEKER_BASE` | `http://127.0.0.1:4000` | deeperseeker proxy 的 base URL |
| `DEEPSEEKER_MODEL` | `v4.1flash` | 傳給 proxy 的 model id |
| `DEEPSEEKER_API_KEY` | （從 proxy `.env` 讀取） | Proxy API key，未設時回退至 `DEEPSEEKER_ENV_PATH` |
| `DEEPSEEKER_ENV_PATH` | `~/Claude/deeperseeker/.env` | 環境變數未設時，從何處讀取金鑰 |
| `NIM_API_KEY` | （未設定） | NVIDIA NIM 金鑰，優先於金鑰檔案 |
| `NIM_KEY_PATH` | `~/.nvidia-nim-key` | 未設 `NIM_API_KEY` 時讀取的金鑰檔案 |
| `NIM_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b` | 順序項目與 `--nim-model` 都未指定時的預設 NIM 模型（備援鏈第一步） |
| `NIM_CHAIN` | `nvidia/nemotron-3-ultra-550b-a55b,minimaxai/minimax-m3.1-flash,nvidia/nemotron-3.5-super-vl-120b-a12b,z-ai/glm-5.3-flash,openai/gpt-oss-20b` | 備援鏈在指定模型之後依序嘗試的模型（逗號分隔；最多 5 次，每步最多 120 秒，整條鏈受 `NIM_TIMEOUT` 限制） |
| `NIM_BASE` | `https://integrate.api.nvidia.com` | NIM API 基底 URL |
| `NIM_MAX_TOKENS` | `8192` | 傳給 NIM 的 `max_tokens` |
| `NIM_TIMEOUT` | `600` | NIM 逾時時間（正數，單位為秒），上限 600，不受 `CONSULT_TIMEOUT` 影響。MCP 註冊需設定 `"timeout": 660000` 或更大才能用滿 |
| `NIM_MODELS_CHECK_DAYS` | `14` | NIM 新模型檢查的間隔（正數，單位為天） |
| `OPENROUTER_API_KEY` | （未設定） | OpenRouter 金鑰，優先於金鑰檔案 |
| `OPENROUTER_KEY_PATH` | `~/.openrouter-key` | 未設 `OPENROUTER_API_KEY` 時讀取的金鑰檔案（取第一個 `sk-or-...` 字串） |
| `OPENROUTER_MODEL` | `baidu/ernie-5.5-flash-preview:free` | 順序項目與 `--openrouter-model` 都未指定時的預設 OpenRouter 模型（備援鏈第一步） |
| `OPENROUTER_CHAIN` | `baidu/ernie-5.5-flash-preview:free,dots-studio/dots-3-note-preview:free,cohere/north-mini-code:free,recursive/flint-v1.0:free,liquid/lfm-3-1.7b:free` | 備援鏈在指定模型之後依序嘗試的模型（逗號分隔；最多 5 次，每步最多 60 秒，整條鏈受 `OPENROUTER_TIMEOUT` 限制） |
| `OPENROUTER_TIMEOUT` | `300` | openrouter 整條備援鏈的逾時秒數（正數）；上限 600，忽略 `CONSULT_TIMEOUT` |
| `DEEPSEEK_API_KEY` | （未設定） | `dsapi` 使用的 DeepSeek 官方 API 金鑰，優先於金鑰檔案 |
| `DSAPI_KEY_PATH` | `~/.deepseek-api-key` | 未設 `DEEPSEEK_API_KEY` 時讀取的金鑰檔案（取第一個 `sk-...` 字串） |
| `DSAPI_MODEL` | `deepseek-flash` | 順序項目與 `--dsapi-model` 都未指定時的預設 `dsapi` 模型；必須是 flash ID（不含 `pro`/`reasoner`） |
