# 版本紀錄

[English](CHANGELOG.md)

本檔案記錄 `model-relay` 的所有重要變更。格式依據 [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)，版號遵循 [語意化版本](https://semver.org/)（`0.x` 階段的次版號可能包含不相容變更），並以 `.claude-plugin/plugin.json` 的版號為準。

## [未發布]

## [0.5.0] - 2026-10-18

供應商回 429 或 5xx 不再讓你的回合中斷：轉發站在**同一個供應商**上以指數退避自動重試，`Retry-After` 要求更久時以 `retry.maxDelayMs` 為間隔持續輪詢——Claude Code 完全看不到中間的失敗。跨供應商備援改為選配開關。

**升級：** 拉取最新版本即可；同供應商重試預設開啟、免設定。需要調整時用新的 `retry` 設定。

### 新增

- **同一供應商透明重試與退避：** 供應商失敗回應（429、500、502、503、504、529）在原供應商上以 `retry.attempts` 次數、`retry.delayMs` × `retry.backoff` 的間隔退避重試，單次等待受 `retry.maxDelayMs` 上限。設定：`retry`。
- **`Retry-After` 感知：** 供應商要求等待超過 `retry.maxDelayMs` 時，改以該上限為間隔持續輪詢，不提前放棄。設定：`retry.maxDelayMs`。
- **選配跨供應商備援：** 開啟 `retry.failover: true` 後，重試用盡時把原始（未改寫的）請求轉送 `failover.provider`，讓該輪在備援模型上完成，而不是回傳錯誤。設定：`retry.failover`。

## [0.4.0] - 2026-10-17

輸入 `/provider` 即可在輸入框上方開啟 `AbovePrompt` 互動控制面板：一鍵（或按熱鍵 `1`–`9`）切換單一視窗的模型、即時測試各供應商的回應延遲（`[Ping]`），並在切回 Claude 前提供二次確認以保護長對話快取。英文與繁體中文 README 現在各自擁有獨立的深淺色動態 Banner 與情境動畫圖。

**升級：** 拉取最新版本或執行 `claude plugin update model-relay@model-relay` 即可，無須修改現有設定檔。

### 新增

- **輸入框上方的 `AbovePrompt` 互動控制面板：** 執行 `/provider` 或 `/provider panel` 會在輸入框上方打開互動面板，可直接點選按鈕或按 `ctrl+x tab` 加數字鍵 `1`–`9` 切換模型，並在將已固定的長對話切回 Claude 前提供二次確認防呆。
- **上游供應商即時連線測速（`/__ping` 與 `/provider ping`）：** 可直接從面板點選 `[Ping]` 或輸入 `/provider ping` 即時測試所有供應商的 HTTP 狀態碼與回應時間，並支援透過 `[Retry Claude]` 或 `/provider probe` 重置 429 冷卻計時。
- **中英雙語獨立動態 SVG：** 為英文與繁體中文分別設計專屬的深淺色動態 Banner（`banner-dark.svg`、`banner-light.svg`、`banner-dark.zh-TW.svg`、`banner-light.zh-TW.svg`）以及兩組情境動畫（`relay-flow.svg` / `.zh-TW.svg`、`panel.svg` / `.zh-TW.svg`）。

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

[unreleased]: https://github.com/cablate/model-relay/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/cablate/model-relay/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cablate/model-relay/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cablate/model-relay/releases/tag/v0.3.0
