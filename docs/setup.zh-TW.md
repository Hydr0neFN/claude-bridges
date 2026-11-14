# 安裝與註冊

在根目錄跑一次 `npm install` 就夠全部 bridge 用；接著把 MCP 伺服器註冊在使用者範圍。

## 安裝

```powershell
cd ~/claude-bridges
npm install
```

在根目錄執行單次 `npm install` 即可供應所有伺服器 —— Node 會從各個 `index.js` 向上查找來解析 `node_modules`。

## 註冊（使用者範圍）

```powershell
claude mcp add-json copilot-bridge  '{"command":"node","args":["C:/Users/YOU/claude-bridges/copilot-bridge/index.js"],"timeout":600000}' -s user
claude mcp add-json codex-bridge    '{"command":"node","args":["C:/Users/YOU/claude-bridges/codex-bridge/index.js"],"timeout":600000}' -s user
claude mcp add-json consult-bridge  '{"command":"node","args":["C:/Users/YOU/claude-bridges/consult-bridge/index.js"],"timeout":660000}' -s user
```

請將 `C:/Users/YOU` 替換為你的實際家目錄。這三個 CLI 都必須先完成驗證：

```bash
copilot login    # GitHub Copilot CLI
codex login      # OpenAI Codex CLI
# agy: see agy-bridge docs for Gemini auth
```
