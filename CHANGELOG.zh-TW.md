# 版本紀錄

[English](CHANGELOG.md)

本檔案記錄 `model-relay` 的所有重要變更。格式依據 [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)，版號遵循 [語意化版本](https://semver.org/)（`0.x` 階段的次版號可能包含不相容變更），並以 `.claude-plugin/plugin.json` 的版號為準。

## [未發布]

## [0.3.0] - 2026-10-17

現在可以在 `providers` 設定任意數量的 Anthropic 相容供應商（GLM、Gemini、DeepSeek、OpenRouter 或本地端 Gateway），支援用 `env:VAR_NAME` 從環境變數讀取金鑰，並同時支援 Windows 與 macOS/Linux。

**升級：** 既有的 `~/.claude/custom-agent.json` 無須修改即可繼續使用；若要改用新版多供應商格式，可將 `model-relay.example.json` 複製為 `~/.claude/model-relay.json`。

### 新增

- **彈性多供應商路由：** 在 `providers.<name>` 下自由新增供應商並透過 `/provider <name>` 依對話切換，每個供應商皆可獨立設定 `matchModels`、`stripToolSearch`、`stripCacheControl`、`authHeader` 與本機 `launch` 自動拉起。設定：`providers`。
- **環境變數金鑰解析：** 支援 `"token": "env:YOUR_API_KEY"` 語法，不必將明文金鑰寫進設定檔。設定：`providers.<name>.token`。
- **跨平台與中英雙語介面：** 除 Windows PowerShell 外新增 POSIX（`sh` + `curl`）啟動支援，並依 Claude Code 的 `language` 設定自動切換繁體中文／英文狀態列與 `/provider` 回報。
- **安裝與健檢命令列工具：** 新增 `node tools/setup.mjs init` 與 `node tools/setup.mjs check` 快速建立設定檔並檢查轉發站狀態。

### 移除

- **舊版 `custom_agent` 子程序工具：** 移除已棄用的 `claude.exe -p` 子程序包裝程式碼，讓外掛專注於純粹、快速的 HTTP 模型轉發與對話路由。
