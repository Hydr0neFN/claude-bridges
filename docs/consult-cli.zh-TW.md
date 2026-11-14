# consult-cli

把小組諮詢當成一般指令來用：旗標、第二輪、配額鎖、辯論模式與更新檢查。

## 命令列與更新

```bash
node consult-cli.js --mode all --order copilot,codex "prompt"
node consult-cli.js --copilot-model M --copilot-effort high --codex-model M --codex-effort low "prompt"
node consult-cli.js --nim-model M "prompt"       # 指定 nim 引擎的模型（順序中的 nim:M 優先於此旗標）
node consult-cli.js --openrouter-model M "prompt" # 指定 openrouter 引擎的模型（順序中的 openrouter:M 優先於此旗標）
node consult-cli.js --dsapi-model M "prompt"    # 指定 dsapi 引擎的模型（僅限 flash ID；順序中的 dsapi:M 優先於此旗標）
node consult-cli.js --check-nim-models         # 立即強制執行 NIM 新模型檢查
node consult-cli.js --prompt-file review.txt   # 從檔案讀取 prompt（"-" 代表標準輸入），不可與 prompt 文字並用。適用於 diff 等長 prompt，避免超出作業系統的命令列長度上限
node consult-cli.js --out-dir /tmp/c "prompt"   # 每個引擎完成時即寫入 <dir>/<engine>.md，全部完成後寫入 <dir>/_done（檔名中的 : 與 / 等不安全字元會改為 _）
node consult-cli.js --debate spec.json --out-dir /tmp/d   # 結構化辯論（見下方「辯論模式」）；印出 <dir>/digest.md 與 TALLY 行
node consult-cli.js --round2 /tmp/c     # 對已完成的 --out-dir 執行跑第二輪：有回答的引擎會看到彼此的答案（匿名），互相批評、可修改；寫入 /tmp/c/round2/，印出 dissent 區塊
node consult-cli.js --locks           # 列出目前生效的配額鎖
node consult-cli.js --unlock codex    # 解除配額鎖（引擎名稱或 "all"）
node consult-cli.js --ignore-locks "prompt"   # 照樣跑被鎖住的引擎，不寫入新的鎖
node consult-cli.js --check-updates   # 立即檢查、印出結果後結束
node consult-cli.js --update          # brew upgrade --cask <過期的 CLI>；git pull --ff-only（工作樹有未提交變更時拒絕）
```

`--mode all` 時，`consult-cli` 會在每個引擎完成的當下依完成順序印出該引擎完整的 `## <engine>` 區段（回答或 `[failed] reason`），最後才印 `[consult] mode: all | ...` 摘要行。各引擎逾時彼此獨立，慢的引擎不會拖延其他引擎。`consult-bridge` 仍回傳單一彙整結果，但使用相同的執行器（`lib/panel.js`）。

## 意見不一致時的第二輪

`--mode all --out-dir D` 的執行也會把問題存成 `D/_prompt.md`。第一輪的答案對某個決定有衝突時，`consult-cli --round2 D` 會再問一次每個有回答的引擎（至少需要 2 個）：它會看到問題、自己的答案，以及其他引擎的答案（以 `Panelist N` 表示），逐一評論，最後以 `REVISED:`、`POSITION:`、`DISSENT:` 行收尾。輸出寫到 `D/round2/<engine>.md`（另加 `_done`），並印出 dissent 區塊；呼叫端要回報這份 dissent，不能只報自己的結論。被鎖住的引擎與第一輪一樣會略過。`--debate` 對立場類的問題本來就有自己的 R2/R3。實作：`lib/round2.js`，測試 `test/round2.test.js`。

## 配額鎖

`copilot`、`codex` 或 `agy` 因可辨識的用量／配額上限而失敗時，`consult-cli` 會在 `~/.claude/state/consult-locks.json`（環境變數 `CONSULT_LOCKS_FILE`；不進 git）寫下一把鎖，並在 `until` 之前跳過該引擎：`{engine: {until, reason, at}}`。摘要會顯示 `skipped: <engine>: locked until <local time> (<reason>)`，`--mode first` 也會跳過它。有提供重置時間時，`until` 就用引擎自己的時間（Codex：「try again at Nov 16th, 2026 10:54 PM」，視為本地時間）；HTTP 429 用 `Retry-After`；每月額度用完則用下個月 1 號的 00:00 UTC；其他可辨識的上限訊息則加 24 小時。單純的 429 或任何不認得的錯誤不會上鎖。鎖會自己到期；`--unlock <engine|all>` 可以提早解除；`--ignore-locks` 會照跑被鎖的引擎、不寫新鎖（明確只寫 `--order X` 時，即使沒加這個旗標也會遵守鎖）。實作：`lib/locks.js`，測試 `test/locks.test.js`。

## 辯論模式

`consult-cli --debate <spec.json> --out-dir <dir>` 以固定流程跑最多三輪辯論，並讓呼叫端的上下文保持精簡：完整回答寫入檔案，呼叫端只需讀 `digest.md`（5 個引擎約 1.5k token）。Spec：

```json
{ "question": "A or B?", "context": "optional inline text", "context_files": ["notes.md"],
  "word_cap": 250, "rebuttal_cap": 150, "cross_cap": 100, "rounds": 3,
  "stances": [ { "engine": "copilot", "stance": "argue for A" },
               { "engine": "deepseek", "stance": "argue for B", "fallback": ["openrouter", "nim"] } ] }
```

- Prompt 一律自給自足（內嵌 `context` 加上 `context_files`，每檔 20 KB、總計 60 KB，截斷處會標記），因為 deepseek、nim、openrouter 沒有檔案存取權限。每則回覆必須以 `CLAIMS`（最多 3 點）/ `CONCEDES` / `BOTTOM LINE` 區塊結尾。
- 第 1 輪：所有立場並行執行（`<dir>/r1/<engine>.md`，另有 `.prompt.md`）。第 2 輪（`rounds: 2`）：第 1 輪有回答的引擎各自收到自己的立場，加上其他引擎第 1 輪的結尾區塊（不含全文），並以 `FINAL PICK: <option> - <reason>` 結尾（`<dir>/r2/`）。第 1 輪同樣以開場 `FINAL PICK` 結尾。
- 防從眾（第 2、3 輪）：對手以 `Debater N` 呈現（不含引擎名稱、票數或多數暗示），prompt 明說「多數同意不是證據」。每則回覆加上 `CHANGED BECAUSE:`（哪位 Debater 的哪項主張改變了立場，或 `unchanged`）與 `WOULD CHANGE MY MIND IF:`。
- 第 3 輪（`rounds: 3`，字數上限 `cross_cap` 預設 100）僅在第 2 輪 FINAL PICK 仍不一致時執行；每位有 pick 的辯手只會看到「pick 與自己不同」的辯手的主張並只回應這些（`<dir>/r3/`）；否則略過，digest 會說明原因。digest 另列每個引擎的 pick 軌跡，例如 `nim: D -> A -> A (R2 changed: Debater 2 claim 1)`；沒說明理由就改變 pick 會標記 `NO REASON GIVEN`，TALLY 採用各引擎最後一次的 pick。借用的做法：獨立第一輪與匿名化同儕（Du et al. 2023；arXiv 2510.07517）、批判而非求共識的提示（Free-MAD，arXiv 2509.11035）；也有論文指出單純多數決即可達到辯論的多數增益，因此 digest 保留原始 pick 與軌跡，而非由裁判下結論。
- 缺少結尾區塊標為 `TAIL_MISSING`（其他引擎會看到該引擎最後約 120 字並加註），失敗的引擎標為 `ENGINE_FAILED: <reason>`；單一引擎失敗不會中止辯論。立場的 `fallback` 清單只重試一次，使用第一個尚未被使用的引擎，並標示為 `<fallback> (for <engine>)`。
- `digest.md` 逐字收錄各引擎的結尾區塊與 FINAL PICK、檔案路徑與 `TALLY:` 行；`<dir>/_done` 最後寫入。Spec 錯誤時結束碼為 2。

`consult-cli` 與 `consult-bridge` 啟動時會檢查（每 24 小時至多一次，快取於 `~/.cache/claude-bridges/updates.json`）引擎 CLI（brew 安裝的 cask 用 `brew outdated --cask --greedy`，否則用 `copilot version`）與本儲存庫（`git fetch` 後比對落後 commit 數）是否過期。頁尾取自上一次檢查的快取結果；快取過期時由分離的背景行程（CLI）或並行（MCP 伺服器）更新，因此不會拖慢或使諮詢失敗；僅在有過期項目時印出一行頁尾（MCP 伺服器則放在工具結果內）。未加 `--update` 不會安裝任何東西。

## `consult-cli.js --json`

加上 `--json`（可用於 prompt、`--mode all|first` 或 `--debate`）時，stdout 只有一個 `{ok,code,message,data}` 物件，不再是文字區段，並有固定的結束碼對照；詳見 `cli-json.md`。`data.engines[]` 內含每個引擎的 `ok`、`code`（`OK`、`QUOTA_EXHAUSTED`、`AUTH_FAILED`、`TIMEOUT`、`NOT_INSTALLED`、`EMPTY_OUTPUT`、`CRASHED`、`ENGINE_ERROR`）、`reason`，以及 `file`（搭配 `--out-dir`）或 `body`；`data.quota_exhausted` 會列出配額用完的引擎。不加 `--json` 時行為完全不變。
