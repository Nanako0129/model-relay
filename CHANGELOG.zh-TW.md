# 版本紀錄

[English](CHANGELOG.md)

本檔案記錄 `model-relay` 的所有重要變更。格式依據 [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)，版號遵循 [語意化版本](https://semver.org/)（`0.x` 階段的次版號可能包含不相容變更），並以 `.claude-plugin/plugin.json` 的版號為準。

## [未發布]

## [0.3.0] - 2026-10-17

`model-relay` 正式開源為 Claude Code 專用的多供應商本機模型轉發站與 429 自動備援工具。你可以在不中斷工作、不浪費長對話快取的前提下，將單一對話或 `haiku` 子代理靈活分流至 Claude、GLM（`z.ai`）、Gemini（透過本地端 Gateway）、DeepSeek、Kimi、MiniMax 或 OpenRouter。

**升級：** 既有的 `~/.claude/custom-agent.json` 無須修改即可繼續使用。可執行 `node tools/setup.mjs init --fix` 與 `node tools/setup.mjs doctor --ping` 進行全鏈路體檢或遷移至 `~/.claude/model-relay.json`。

### 新增

- **彈性多供應商路由與內建 Presets：** 在 `providers.<name>` 下自由新增任意數量的供應商，內建 `zai`、`glm`、`deepseek`、`kimi`、`minimax`、`openrouter`、`gemini`、`magpie` 預設集，只需填寫 `token` 即可自動帶入最佳的 `baseUrl`、`model`、`matchModels`、`stripToolSearch`、`stripCacheControl` 與 `authHeader`。設定：`providers`。
- **保護快取的 429 自動備援與對話黏著：** 當 Anthropic 回傳 429 額度上限時，自動切換至 `failover.provider` 並將該對話固定 7 天；Claude 額度恢復後只有新對話回到 Claude，避免長對話切回時重建 80 萬+ token 快取而瞬間燒光額度。設定：`failover`。
- **結構化 `/provider` 清單與即時狀態同步：** `/provider` 改為對齊顯示目前所在路由（`●`）與可切換路由（`○`），並直接與轉發站 `/__health` 同步，自動隱藏尚未匯出 `env:VAR_NAME` 金鑰的供應商。
- **一鍵 `doctor` 全鏈路體檢與上游 `--ping` 實測：** 執行 `node tools/setup.mjs doctor --fix --ping` 即可一次檢查設定檔語法、未設定的 `env:VAR` 環境變數、自動將 `ANTHROPIC_BASE_URL` 寫入 `~/.claude/settings.json`、確認本機轉發站健康度，並對每個供應商發送 1-token 真實請求測試連線延遲。
- **本地端 Gateway 自動拉起（`launch`）：** 指向 `127.0.0.1` 或 `localhost` 的供應商可設定 `launch: { command, args }`，當本機連接埠未開啟時由轉發站在背景自動啟動程序。設定：`providers.<name>.launch`。
- **跨平台與中英雙語介面：** 同時支援 Windows（`powershell.exe` + `curl.exe`）與 macOS/Linux（`sh` + `curl`），依 Claude Code 語系設定自動切換繁體中文／英文介面，並附深淺色 Banner 與架構流程 SVG。

### 移除

- **舊版 `custom_agent` 子程序工具：** 移除已棄用的 `claude.exe -p` 子程序包裝程式碼，讓外掛專注於純粹、零額外負擔的 HTTP 模型轉發與對話路由。

[unreleased]: https://github.com/cablate/model-relay/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/cablate/model-relay/releases/tag/v0.3.0
