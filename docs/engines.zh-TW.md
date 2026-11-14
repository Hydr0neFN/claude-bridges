# 引擎

`consult` 實際會呼叫哪些引擎，以及每個引擎要怎麼設定才能跑。

`consult` 工具目前會把請求分送到**五個引擎**：

| Engine | Wraps | Tier |
|---|---|---|
| `copilot` | GitHub Copilot CLI (`copilot -p`) | Free (GitHub) |
| `codex` | OpenAI Codex CLI (`codex exec`) | Free (ChatGPT) |
| `agy` | Antigravity / Gemini CLI | Google AI Plus（配額少）；**2026-10-27 起列入預設順序，直到剩餘配額用完為止** |
| `deepseek` | 以 `deeperseeker` proxy 代理 DeepSeek 網頁帳號（HTTP，非 CLI） | Free（拋棄式帳號） |
| `nim` | NVIDIA NIM 託管 API（HTTP，非 CLI） | Free 試用方案；列入預設順序，帶 5 個模型的備援鏈 |
| `openrouter` | OpenRouter 免費模型（HTTP，非 CLI） | Free（有速率限制）；列入預設順序（在 `nim` 之後），並帶有 5 個模型的備援鏈 |
| `opencode` | 官方 OpenCode CLI（`opencode`，已登入 OpenCode Zen），使用其免費模型 | Free；列入預設順序（在 `openrouter` 之後），帶有 5 個模型的備援鏈（`OPENCODE_CHAIN` 可覆寫，`--opencode-model M` 從 M 開始）。在空的暫存目錄以唯讀的 `plan` agent 執行，prompt 走 stdin。**免費模型的內容可能被供應商記錄或使用：只送非機密的 prompt。** |
| `dsapi` | DeepSeek 官方 API，僅限 flash 模型（HTTP，非 CLI） | 按量計費（便宜）；**選用（不在預設順序中）**，但同時是 `deepseek` 的自動備援 |
| `gemini` | Google Gemini API（OpenAI 相容端點，HTTP，非 CLI） | Google AI Studio 免費方案金鑰（`GEMINI_API_KEY` 或 `~/.gemini-api-key`）；僅傳 prompt；列入預設順序（最後），同時是 `agy` 的自動備援 |
| `azure` | Azure OpenAI 聊天補全（HTTP，非 CLI） | Azure 訂閱金鑰（`AZURE_OPENAI_KEY` 或 `~/.azure-openai-key`）加端點（`AZURE_OPENAI_ENDPOINT` 或 `~/.azure-openai-endpoint`）；列入預設順序（在 `opencode` 之後）；單一模型、無備援鏈；僅傳 prompt |

`agy` 原本採選用制（Google AI Plus 配額很少）；2026-10-27 起列入預設順序，配額用完即移除（之前以 `--order copilot,codex,deepseek,agy`
或 MCP 的 `order` 引數加入，建議每次審查只呼叫一次）。

`deepseek` 已列入預設的 `CONSULT_ORDER`（排在最後，因此在 `first` 模式下僅作為備援）。它需要 `deeperseeker` proxy
在 `127.0.0.1:4000` 運作；若 proxy 未啟動或沒有金鑰，會自動備援到官方 API（`dsapi`，僅限 flash，標示 `deepseek->dsapi`，見下），若也沒有金鑰則軟性失敗，其他引擎仍會照常回答。
`nim` 也已列入預設順序（在 `deepseek` 之後，預設為 `copilot,codex,deepseek,agy,nim,openrouter,opencode,azure,gemini`），並帶有 5 個模型的備援鏈（`nvidia/nemotron-3-ultra-550b-a55b` -> `minimaxai/minimax-m3.1-flash` -> `nvidia/nemotron-3.5-super-vl-120b-a12b` -> `z-ai/glm-5.3-flash` -> `openai/gpt-oss-20b`，可用 `NIM_CHAIN` 覆寫；每步最多 120 秒，整條鏈受 `NIM_TIMEOUT` 限制，上限 600 秒）；明確寫 `nim:<其他模型>` 時只跑該模型、不走備援鏈。`openrouter` 自 2026-10-27 起同樣列入預設順序，預設模型 `baidu/ernie-5.5-flash-preview:free` 與 `nim` 不同家族（兩條備援鏈的模型家族完全不重疊，由測試保證），兩者算作獨立的聲音；要排除它請明確指定 `--order`（例如 `--order copilot,codex,deepseek`）。`dsapi` 也是選用制（`--order copilot,codex,deepseek,dsapi`），且 `deepseek` 會自動備援到它（見下）。
與其他 CLI 引擎不同，`deepseek`、`nim`、`openrouter` 與 `dsapi` 沒有 cwd、shell 或檔案存取權限 ——
只看得到 prompt 文字本身，因此送給它們的 prompt 必須自帶完整脈絡。

## `openrouter`（OpenRouter 免費模型）

金鑰只需設定一次：放進 `~/.openrouter-key`（請限制權限：macOS/Linux 使用 `chmod 600`；Windows 使用
`icacls <file> /inheritance:r /grant:r "%USERNAME%:(R,W)"`）或匯出 `OPENROUTER_API_KEY`。環境變數優先。
沒有金鑰時，該引擎會回報 `[failed] no key`，其他引擎仍會照常回答。

請求送往 `https://openrouter.ai/api/v1/chat/completions`（`max_tokens` 1500）。
免費模型有速率限制，因此裸 `openrouter`（以及由 `--openrouter-model` / `OPENROUTER_MODEL` 指定的模型，或 `openrouter:<該預設模型>`）會依備援鏈往下試，
由指定的模型開始（最多 5 次；可用 `OPENROUTER_CHAIN=a/x:free,b/y:free` 覆寫）：
`baidu/ernie-5.5-flash-preview:free` -> `dots-studio/dots-3-note-preview:free` -> `cohere/north-mini-code:free` -> `recursive/flint-v1.0:free` -> `liquid/lfm-3-1.7b:free`。
遇到 404、410、429、5xx（含 HTTP 200 內夾帶的同類錯誤）、400「not a valid model ID」（模型已下架）、逾時、網路錯誤、空回覆或只含推理過程的回覆時換下一個；
其他錯誤（401 金鑰無效、402 無額度、其他 400）會立即結束備援鏈。開頭的 `<think>...</think>` 區塊會被移除。
結果會標示為實際回答的模型（`openrouter:<model>`）；若全部失敗，失敗訊息會列出各模型與原因（429 顯示為 `rate-limited`）。
順序中**明確**寫 `openrouter:<其他模型>` 時只跑該模型，使用整段逾時、不走備援鏈。
時間預算：每步最多 60 秒（`OPENROUTER_ATTEMPT_TIMEOUT_SEC`），整條鏈受 `OPENROUTER_TIMEOUT` 限制（預設 300 秒 = 5 x 60，上限 600 秒）；剩餘不足 15 秒的後續步驟會被略過。
2026-10-27 實測，這些免費模型回答一個小型 code review 提示約 2-21 秒。
此鏈與 `nim` 鏈沒有任何共同的模型家族（由測試保證）。刻意排除：`thinkingmachines/inkling[-small]:free`（403，僅限 agentic harness）、
`google/gemma-4-*:free` 與 `xingchen-agi/xing4.0-29b-a4b:free`（探測時每次都被上游 429）、`nvidia/nemotron-*:free`（與 `nim` 鏈同家族）。
模型優先順序：順序中的 `openrouter:<model>`，其次 `--openrouter-model`，再其次 `OPENROUTER_MODEL`，最後是內建預設值。
與 `nim`、`deepseek` 一樣沒有檔案存取權限：prompt 必須自帶完整脈絡。

`poolside/laguna-s-2.1:free`（舊預設值）與 `liquid/lfm-2.5-2.6b:free` 已經不在鏈上。
`lib/engines.js` 現在用的是 `baidu/ernie-5.5-flash-preview:free` 與 `liquid/lfm-3-1.7b:free`，程式註解也寫明舊預設值已經下架（404，沒有供應商）。

## `dsapi`（DeepSeek 官方 API，僅限 flash）

金鑰只需設定一次：放進 `~/.deepseek-api-key`（請限制權限：macOS/Linux 使用 `chmod 600`；Windows 使用
`icacls <file> /inheritance:r /grant:r "%USERNAME%:(R,W)"`）或匯出 `DEEPSEEK_API_KEY`。環境變數優先；
檔案內容可含其他文字，取第一個 `sk-...` 字串。沒有金鑰時回報 `[failed] no key`，其他引擎仍會照常回答。

**OpenRouter 額度優先（2026-10-28）。** 有 OpenRouter 金鑰時（`OPENROUTER_API_KEY` 或 `~/.openrouter-key`），`dsapi`
先呼叫 OpenRouter 上的 `deepseek/deepseek-v4.1-flash`（模型在程式中固定，請求帶 `provider.data_collection: "deny"`），
之後才用官方 API。OpenRouter 回 401/402/403（金鑰錯誤、額度用完）時，本程序其餘時間都改走官方 API；429/5xx/網路錯誤只
讓該次請求回退。`DS_UPSTREAM=deepseek` 強制走官方 API。規則與 DS 工作者的金鑰代理（`~/.claude/bin/ds-keyproxy.py`）相同。
由 OpenRouter 回答的結果帶 `upstream: "openrouter"`。共用的 `:free` 額度池（每帳號每日 1000 次，面板與 agent 流程共用）有保留量：
設定 `OR_FREE_RESERVE=<n>` 後，`openrouter` 引擎在 `GET /api/v1/key` 回報剩餘 `<= n` 次時略過 `:free` 模型（每分鐘最多查一次；
面板預設 0＝不查詢，429 時換下一個；agent 流程 50，託管測試 200）。

請求送往 `https://api.deepseek.com/chat/completions`（OpenAI 相容；`max_tokens` 1500，逾時 90 秒，關閉 thinking 模式）。
遇到 HTTP 429（遵循 `Retry-After`，有上限）、5xx、逾時或網路錯誤時重試一次；400/401/402/403 不重試。
開頭的 `<think>...</think>` 區塊會被移除。預設模型為 `deepseek-flash`（DeepSeek 一直讓它指向目前的 Flash 模型，
已用 `GET /models` 確認；舊名 `deepseek-v4-flash` 仍可使用）。

**僅限 flash。** 此引擎用於便宜的第二意見，因此拒絕任何非 Flash 模型。由於 DeepSeek 會不斷更改模型 ID，規則是樣式而非固定清單：
ID 含有 `flash` 字樣（`deepseek-flash`、`deepseek-v6-flash`、`v4.1flash`，大小寫不拘）且**不含** `pro` 或 `reasoner` 才會被接受
（因此 `deepseek-v4-pro`、`deepseek-reasoner`、`deepseek-chat`、`deepseek-flash-pro` 都會被拒絕）。被拒絕的模型
（來自 `dsapi:<model>`、`--dsapi-model` 或 `DSAPI_MODEL`）會以 `dsapi is limited to flash` 失敗，且不會送出任何請求。
模型優先順序：順序中的 `dsapi:<model>`，其次 `--dsapi-model`，再其次 `DSAPI_MODEL`，最後是內建預設值。

**`deepseek` 的自動備援。** 當 `deeperseeker` proxy 無法連線（例如連線被拒）、沒有金鑰或回應 HTTP 5xx 時，`deepseek` 引擎會改用 `dsapi`
重送 prompt，結果標示為 `deepseek->dsapi`，讓預設面板（`copilot,codex,deepseek`）在 proxy 停擺時仍保有 DeepSeek 的聲音。
proxy 正常回答時完全不變；proxy 回 4xx 或指定了 `deepseek:<model>` 時不會觸發備援。備援也失敗時，錯誤訊息會同時列出兩者的原因。
若在同一順序中同時列出 `deepseek` 與 `dsapi`，proxy 停擺時會呼叫兩次。

**用量警示。** 每次請求與回應中的 token 用量（prompt + completion）會依本地日期記錄在
`~/.dsapi-usage.json`（`{"day","requests","promptTokens","completionTokens"}`）。每日超過 **300 次請求**時，
可能呼叫 dsapi 的執行會在頁尾印出一行警告（`[consult] dsapi: N requests today ...`；CLI 為 stderr，MCP 工具則附加在結果後）。
300 僅是軟性警示：不會阻擋任何請求，因為 Flash 很便宜。

## `nim`（NVIDIA NIM）

金鑰只需設定一次：放進 `~/.nvidia-nim-key`（請限制權限：macOS/Linux 使用 `chmod 600`；
Windows 則依賴使用者設定檔的 ACL），或設定環境變數 `NIM_API_KEY`（環境變數優先）。

順序中的項目可寫成 `engine` 或 `engine:model`（只以第一個 `:` 切分，因此含 `/` 的模型 ID 可正常使用）。
`copilot`、`codex`、`nim`、`deepseek`、`openrouter`、`dsapi` 支援指定模型；`agy:x` 與未知引擎會被忽略。
（`copilot:<model>` 在語法上可接受，但僅支援自動選模型的 Copilot 方案會拒絕 `--model`；此時引擎會改用自動模式重試一次，
並將結果標示為 `copilot (auto; <model> unavailable on this plan)`。）`nim:<預設模型>` 與單獨的 `nim` 視為同一項目，會去除重複。
如此一次諮詢即可同時詢問多個 NIM 模型，結果會標示為 `nim:<model>`：

```bash
node consult-cli.js --order nim:moonshotai/kimi-k3,nim:z-ai/glm-5.3,codex "prompt"
```

`nim` 的模型優先順序：順序中的 `engine:model`，其次 `--nim-model`，再其次 `NIM_MODEL`，最後是內建預設值。

**備援鏈。** 免費方案的 NIM 模型會卡住、消失（HTTP 404，或終止支援後回 410），或只回推理過程，因此裸 `nim`
（以及由 `--nim-model` / `NIM_MODEL` 指定的模型，或 `nim:<該預設模型>`）會依鏈往下試，由指定的模型開始：
`nvidia/nemotron-3-ultra-550b-a55b` -> `minimaxai/minimax-m3.1-flash` -> `nvidia/nemotron-3.5-super-vl-120b-a12b` -> `z-ai/glm-5.3-flash` -> `openai/gpt-oss-20b`（最多 5 次；
可用 `NIM_CHAIN=a/x,b/y,c/z` 覆寫）。遇到 404、410、5xx、429（先照常重試一次）、逾時、網路錯誤、閘道錯誤、空回覆或只含推理過程的回覆時換下一個；
400/401/402/403 與其他 4xx 則直接停止（換模型也會得到同樣的錯）。
結果會標示為實際回答的模型（`nim:<model>`）；若全部失敗，原因會列出每一次嘗試；若唯一有內容的是推理過程，則以第一個僅推理的回覆作為最後手段顯示。
順序中**明確**寫 `nim:<其他模型>` 時只跑該模型，使用整段逾時、不走備援鏈，單一模型的評測才不會失真。時間預算：每步最多 120 秒
（`NIM_ATTEMPT_TIMEOUT_SEC`），整條鏈受 `NIM_TIMEOUT` 限制（預設與上限都是 600 秒，即 5 x 120 秒）；剩餘不足 15 秒的後續步驟會被略過（第一步一定會跑）。
這條鏈是 2026-10-27 用一份夾帶故意錯誤的 code review 提示測出來的：ultra 以 27-79 秒回答、minimax-m3.1-flash 93 秒、super-vl 57 秒，三者都找到那些錯誤；
glm-5.3（396 秒）、glm-5.3-flash（該次 319 秒，之後幾次 10-15 秒；它是第 4 步）與 step-5-preview（228 秒，之後 35-87 秒）不是太慢就是太不穩，放不進前幾步
（`openai/gpt-oss-20b` 以 5-10 秒回答，收在鏈尾），deepseek-v4.1-flash 回 504、kimi-k3 回 410（終止支援）、kimi-k2.6 回 404，nemotron-3.5-bolt-e4b 答得很弱。延遲每次差很多
（免費佇列是共用的），所以鏈上混用不同廠牌。
若模型只回推理過程而沒有最終答案，該段會以 `[reasoning only: ...]` 開頭；
回答被截斷時會附上 `[truncated: hit max_tokens]`（可調高 `NIM_MAX_TOKENS`），被截斷的回答仍視為有效回答。
只有「僅含推理過程」的回覆在 `--mode all` 中仍會顯示，但在 `--mode first` 中視為失敗，會改由下一個引擎接手
（若所有引擎都只回傳推理過程，則以第一個此類回覆作為最後手段顯示，並附上說明）。只有回覆最開頭的 `<think>` 區塊會被當作推理過程；回答中途引用的標籤不會被處理。

免費試用金鑰的上限約為每分鐘 40 個請求；NVIDIA 並未公開限制，且可能隨時調整。
使用須遵守 NVIDIA API Trial Terms（僅限評估、非正式環境用途）。額度以金鑰為單位，
因此任何使用同一把金鑰的其他應用程式都會共用這份額度。收到 HTTP 429 時，consult 會等待
（依 `Retry-After`，否則 5 秒，最長 15 秒）並重試一次，仍失敗則回報該引擎受到速率限制。

免費方案的延遲會因模型而有很大差異：在煙霧測試中，預設的 `nvidia/nemotron-3-ultra-550b-a55b` 約 20 秒就回答了一個小型審查 prompt，
而其他部分模型要 150 秒，甚至在 180 秒時逾時。此外，NIM 的 `/v1/models` 會列出這把金鑰無法呼叫的模型
（HTTP 404，`Function ... Not found for account`），因此請先試用再依賴。`nim` 有自己的逾時設定，與 `CONSULT_TIMEOUT` 無關：`NIM_TIMEOUT` 秒（預設 600），上限固定為 600
（10 分鐘；設得更大會被限制為 600，無效的值則回到 600）。各引擎是平行執行的，因此慢速模型只會拖慢它自己的區段。
429 重試與此共用同一個期限。

`nim` 請求採用串流（SSE）：consult 會累積增量內容（答案與推理），並組成與一般回覆相同的結果。約有兩個限制落在 300 秒：模型在該時間內仍未開始回答時，NVIDIA 的閘道會回傳真正的
HTTP 504（顯示為 `NVIDIA gateway timeout ...`，不重試）；而 Node 的 `fetch` 在 300 秒內沒有收到回應標頭，
或串流途中 300 秒沒有任何資料區塊（指區塊之間的閒置時間，而非總時間）時也會放棄（顯示為
`no response headers within ~300 s` / `stream stalled, no data for ~300 s`，而不是 `fetch failed`）。簡言之：
第一個 token 必須在約 300 秒內出現，之後整個串流可以持續到 `NIM_TIMEOUT`（最高 600 秒）。若不串流，整個答案都得在 300 秒內完成，
因此超過 300 的 `NIM_TIMEOUT` 只對已經開始回答的模型有幫助；卡在免費方案佇列中的模型仍會在約 300 秒時失敗。若期限在串流途中到達，
會回傳目前已收到的文字並附上 `[truncated: timed out after Ns]`（只有推理內容時以僅推理方式顯示；什麼都沒收到則為一般逾時）。
非 `text/event-stream` 的回覆會當作一般完成結果解析。`deepseek` 不使用串流。HTTP 504 代表閘道等不到第一個 token 而放棄；HTTP 502 則顯示為一般的
`NVIDIA gateway error (HTTP 502)` 並附上回應內容。兩者都不會重試。

若 consult 是以 MCP `consult-bridge` 執行，其註冊需設定 `"timeout": 660000` 或更大，`nim` 才能用滿 10 分鐘（`docs/setup.zh-TW.md` 的註冊範例已使用此值）。
在 `--mode first` 中各引擎是依序執行，卡住的 `nim` 最多會拖住整條備援鏈 600 秒，`nim` 加上備援引擎可能超過 660 秒：
請把 `nim` 放在順序的最後，或改用 `--mode all`（平行執行）。

### 每兩週一次的新模型檢查

NIM 經常新增模型，因此只要存在 NIM 金鑰，使用到 `nim` 的 consult 執行（順序中含 `nim` 或 `nim:<model>`）
最多每 14 天（`NIM_MODELS_CHECK_DAYS`）會在背景處理程序中檢查一次 `/v1/models`。成本是每 14 天一次 `/v1/models` 請求，
不會呼叫任何模型。第一次檢查只會記錄基準；之後的檢查會把清單與先前看過的 ID 比對（嵌入、安全防護、語音等非對話模型會被忽略）。
結果會以一行通知呈現，直到下一次檢查為止（`consult-cli` 輸出於 stderr；`consult-bridge` 附加於工具結果），例如
`[consult] NIM: 2 new models since 2026-10-10: a/b, c/d -> worth a look in a separate session; try --order nim:<id>`
（最多列出 6 個 ID，其餘以 `(+K more)` 表示）。出現在清單中並不代表你的金鑰能呼叫該模型，或在免費方案上夠快，請視為參考提示。

- 結果快取：`~/.cache/claude-bridges/nim-models.json`（或 `$CLAUDE_BRIDGES_CACHE_DIR/nim-models.json`），格式為
  `{checkedAt, attemptAt, baselineAt, seen, new: [ids], error}`；其中絕不會包含金鑰。`checkedAt` 是最近一次成功取得清單的時間
  （失敗時不變），`attemptAt` 是最近一次嘗試的時間。當 `checkedAt` 已超過檢查間隔且 `attemptAt` 已超過一天時才會再次檢查，
  因此清單服務失敗時會每天重試，而不是等上兩週。
- 通知節流：通知最多顯示 3 次，之後靜默一天（出現新的檢查結果則重新計算）。狀態存放在快取旁的 `nim-notice.json`，
  格式為 `{key, count, windowStart, cooldownUntil}`，其中 `key` = `<checkedAt>:<new ids joined by ,>`，且只有在通知實際
  印出或附加時才會（以原子方式）寫入。所有使用端共用同一份狀態，包括遵循相同規則的外部 hook：`key` 不同就從零開始；
  `now < cooldownUntil` 時保持靜默；若 `now - windowStart >= 24 h`（或 `now < windowStart`，即時鐘被往回調）則重設 `count` 並令 `windowStart = now`；
  接著 `count += 1`，當 `count >= 3` 時設定 `cooldownUntil = now + 24 h`。檔案不存在或損毀視為「顯示」；
  節流檔案的任何錯誤都不會中斷 consult 執行。
- 以下兩個旗標不需要在順序中包含 `nim`。
- `node consult-cli.js --check-nim-models` 立即強制檢查並印出通知（或 `no new models`）。
- `node consult-cli.js --refresh-nim-models` 在處理程序內執行受節流限制的檢查，不輸出任何內容，只寫入快取
  （背景的分離式更新與外部 hook 都是呼叫此旗標）。

Grok 與其他模型已列入構想循環中，但尚未建立 bridge。本系統設計具備擴充引擎的能力 —— 每個引擎在 `lib/engines.js` 中僅需約 30 行程式碼。
