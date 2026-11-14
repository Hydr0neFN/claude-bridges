# Bridge 與工具

三個 MCP 伺服器；實際使用的是 `consult-bridge`，另外兩個為**舊版（legacy）**（仍可運作，但預設不註冊）：

| Bridge | 工具 | 預設策略 |
|---|---|---|
| `copilot-bridge` | `copilot_exec` | 限制性：禁止寫入檔案，僅自動核准讀取/搜尋/git-gh shell |
| `codex-bridge` | `codex_exec` | 沙盒化 `read-only` |
| `consult-bridge` | `consult` | 聚合器：平行執行所有引擎（`mode: all`）或循序後備切換（`mode: first`） |

三者都用 `lib/common.js` 解析 CLI 執行檔（PATH，加上 macOS/Linux 的 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`；Windows AppData 後備路徑僅在 Windows 使用）。`consult-bridge` 與 `consult-cli` 在 `lib/engines.js` 自行建構引數。缺少某個 CLI 只會讓該引擎失敗，例如 `copilot: not installed (looked in ...)`。

## `consult`（核心工具）

諮詢外部模型小組。有兩種模式：

- **`all`**（預設）—— 平行執行每個引擎，回傳所有成功的回答並標上引擎名稱。需要不同觀點的跨模型第二意見時用這個。
- **`first`** —— 循序後備鏈，以第一個成功的回應為主。成本較低，例行問題或額度吃緊時用這個。

```
consult({
  prompt: "Review this auth middleware for timing attacks",
  mode: "all",           // "all" | "first"
  order: ["copilot", "codex", "deepseek"]  // engine set/chain order
})
```

引擎順序可透過 `order` 引數或 `CONSULT_ORDER` 環境變數設定（預設為 `copilot,codex,deepseek,agy,nim,openrouter,opencode,azure,gemini`；`order` 與 `CONSULT_ORDER` 的項目都可寫成 `engine:model`；MCP 的 `order` 是字串陣列，無效的項目會被忽略並回報，若沒有任何有效項目則回傳錯誤）。失敗的引擎（配額耗盡、驗證失敗、逾時、輸出為空、非零結束代碼）會自動改用下一個引擎；過程紀錄會附在結果後面。

## `copilot_exec`

委派給 GitHub Copilot CLI，用 headless、非互動的模式跑。預設為唯讀 —— 可以讀取與搜尋 `cwd` 下的檔案，但無法修改檔案。

## `codex_exec`

用 `codex exec` 委派給 OpenAI Codex CLI。預設為沙盒化唯讀。只有當你確實打算讓 Codex 編輯檔案時，才傳入 `sandbox: "workspace-write"`。
