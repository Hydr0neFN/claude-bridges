# Install and register

One `npm install` serves every bridge; then register the MCP servers at user scope.

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
claude mcp add-json consult-bridge  '{"command":"node","args":["C:/Users/YOU/claude-bridges/consult-bridge/index.js"],"timeout":660000}' -s user
```

Replace `C:/Users/YOU` with your actual home directory. All three CLIs must be authenticated first:

```bash
copilot login    # GitHub Copilot CLI
codex login      # OpenAI Codex CLI
# agy: see agy-bridge docs for Gemini auth
```
