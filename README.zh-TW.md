# model-relay

[English](README.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" width="900" alt="model-relay：Claude Code 多供應商模型路由與保護快取的 429 自動備援轉發站">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/cablate/model-relay/releases"><img src="https://img.shields.io/github/v/release/cablate/model-relay?include_prereleases&display_name=release&label=release&color=38bdf8" alt="Latest release"></a>
  <a href="https://github.com/cablate/model-relay/actions/workflows/ci.yml"><img src="https://github.com/cablate/model-relay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

**在 Claude Code 中把對話與子代理靈活路由到 Claude、GLM、Gemini、DeepSeek 或任何相容 Anthropic 介面的供應商，具備保護快取的對話黏著（Sticky Session）與 429 額度自動備援。**

<p align="center">
  <img src="docs/assets/relay-flow.svg" width="900" alt="架構與路由流程圖：展示 model-relay 如何在 Claude、GLM、DeepSeek 與 Gemini 之間分流對話、haiku 子代理與 429 自動備援">
</p>

| 情境 | 沒用 `model-relay` | 用了 `model-relay` |
|---|---|---|
| 工作到一半遇到 Claude 5 小時額度上限 | 對話直接卡住，只能等額度重置或重開終端機改環境變數 | 自動切換到備援供應商並固定該對話，工作不中斷 |
| Claude 額度恢復時把長對話切回 Claude | 在 Claude 重建 80 萬+ token 的快取，瞬間燒光剛恢復的額度 | 已切走的舊對話固定留在備援供應商；只有新開的對話回到 Claude |
| 想把 `haiku` 子代理交給便宜快速的模型 | 改全域環境變數會連主線的 Opus/Sonnet 一起換掉 | 透過 `matchModels` 把指定模型導向目標供應商，主線繼續留在 Claude |
| 第三方轉發站遇到 `ToolSearch` 或 `cache_control` 報錯 | 工具整批消失或請求直接回 400 錯誤 | 每個供應商可獨立設定 `stripToolSearch` 與 `stripCacheControl` 自動清洗請求 |

## 快速開始

環境需求：Node.js 20+ 與 Claude Code CLI（已於 Node.js 22.23.2 及 Windows 11 / POSIX 測試）。

1. 初始化設定檔（`~/.claude/model-relay.json`）並在 `~/.claude/settings.json` 自動設定 `ANTHROPIC_BASE_URL`：

```bash
node tools/setup.mjs init --fix
```

2. 設定供應商 API 金鑰環境變數（或使用內建的 `zai`、`deepseek`、`kimi`、`minimax`、`openrouter`、`gemini` 預設集），並執行全鏈路檢查：

```bash
export ZAI_API_KEY="your-api-key"
node tools/setup.mjs doctor --ping
```

確認成功的輸出：

```text
Config OK (~/.claude/model-relay.json)
  Port: 8950
  Providers: glm -> glm-5.3[1m], deepseek -> deepseek-chat, gemini -> gemini-4-argon
  Failover: glm (cooldown 600s)
  Router status: offline on 127.0.0.1:8950 (will auto-start when Claude Code launches)
```

3. 在 Claude Code 安裝並載入外掛（或使用 `--plugin-dir /path/to/model-relay`）：

```bash
/plugin install model-relay --marketplace cablate/model-relay
```

更新方式：拉取最新 commit 後重新啟動 Claude Code 即可。

## 適合誰用

`model-relay` 適合希望在 Claude 額度用完時無縫接續工作、想針對單一視窗用 `/provider` 切換模型、或想把子代理分流到其他供應商又不浪費長對話快取的 Claude Code 使用者。如果你需要的是給多人團隊共用的雲端 API 閘道器，請改用 LiteLLM——`model-relay` 是單機本機端（`127.0.0.1`）專用的輕巧轉發站。

## 功能

### 單一對話 `/provider` 獨立切換，不影響其他視窗

隨時把當前對話固定到任一已設定的供應商（`/provider glm`、`/provider gemini`、`/provider deepseek`），其他開著的 Claude Code 終端機仍維持原本的 Claude 主線。

### 保護快取的 429 自動備援與對話黏著

當 Anthropic 回傳 429 額度上限時，轉發站會自動把請求改送往 `failover.provider` 並將該對話標記固定 7 天。經過 `cooldownMs`（預設 10 分鐘）後，新對話會重新嘗試使用 Claude，而已經切走的長對話會固定留在備援供應商，避免切回時重建巨量快取。

### 宣告式供應商相容規則與本地 Gateway 自動拉起

`providers` 裡的每個供應商都能獨立宣告 `matchModels`（用正規表示式比對 `haiku` 等子代理模型）、`stripToolSearch`（自動移除 `ToolSearch` 與 `defer_loading: true` 工具）、`stripCacheControl`（遞迴移除 `cache_control` 欄位）、`authHeader`（`bearer`、`x-api-key` 或 `both`）、`env:VAR_NAME` 環境變數金鑰讀取，以及 `launch`（當本地端轉發埠未開啟時自動在背景啟動子行程）。

## 設定

設定檔位於 `~/.claude/model-relay.json`（亦向下相容舊檔名 `~/.claude/custom-agent.json`）。設定目錄預設優先讀取 `$CLAUDE_CONFIG_DIR`，若未設定則使用 `$USERPROFILE/.claude` 或 `$HOME/.claude`。

| 欄位 | 預設值 | 說明 |
|---|---|---|
| `port` | `8950` | 本機轉發站監聽的連接埠（`1025`–`65535`） |
| `claudeUrl` | `"https://api.anthropic.com"` | 上游 Anthropic API 網址 |
| `failover.enabled` | `true` | 遇到 Claude 429 額度用完時是否自動切換至備援供應商 |
| `failover.provider` | `"glm"`（或第一個供應商） | 429 自動備援使用的供應商名稱 |
| `failover.cooldownMs` | `600000` | 幾毫秒後讓新對話重新測試 Claude 是否恢復（預設 10 分鐘） |
| `providers.<name>.baseUrl` | （必填） | 該供應商相容 Anthropic 格式的上游網址 |
| `providers.<name>.token` | （必填） | API 金鑰字串，或 `"env:ENV_VAR_NAME"` 從環境變數讀取 |
| `providers.<name>.model` | （必填） | 轉發時改寫的目標模型 ID（如 `[1m]` 等尾綴會在送出時自動剝除） |
| `providers.<name>.matchModels` | `["^<name>"]` | 比對請求 `model` 欄位的正規表示式陣列 |
| `providers.<name>.stripToolSearch` | `true` | 是否在送出前移除 `ToolSearch` 與 `defer_loading: true` 工具 |
| `providers.<name>.stripCacheControl` | `false` | 是否在送出前遞迴移除所有 `cache_control` 欄位 |
| `providers.<name>.authHeader` | `"both"` | 金鑰標頭傳遞方式：`"bearer"`、`"x-api-key"` 或 `"both"` |
| `providers.<name>.launch` | `null` | `{ "command": "...", "args": [...] }`，當本機連接埠未開時自動拉起程序 |

## 指令

| 指令 | 說明 |
|---|---|
| `/provider` | 查看目前對話的路由狀態、備援倒數與可用供應商清單 |
| `/provider <name>` | 將目前這個對話固定改用 `<name>` 供應商（例如 `/provider glm`、`/provider gemini`） |
| `/provider claude` | 將目前這個對話切回 Claude（下一個請求會重建整段對話快取） |

## 花費、隱私與權限

- **網路與資料流向：** 轉發站只綁定本機 `127.0.0.1:<port>`，請求只會送往 `claudeUrl`（`https://api.anthropic.com`）或你在設定檔中指定的 `baseUrl`，不包含任何遙測或第三方統計。
- **本機讀寫檔案：** 讀取 `~/.claude/model-relay.json`（或 `custom-agent.json`），並將對話黏著狀態寫入 `~/.claude/model-relay-state.json`，日誌寫入 `custom-agent-router.log` 與 `custom-agent-requests.log`（超過 5 MB 自動清空）。
- **外掛權限檢查：** 你可以隨時執行 `claude plugin validate /path/to/model-relay` 檢視外掛宣告的所有 hooks 與環境變數存取範圍。

## 支援的環境

| 環境 | 狀態 |
|---|---|
| Windows 11 + Node.js 22 + Git Bash / PowerShell | 實測通過 |
| macOS / Linux + Node.js 20+（`sh` + `curl`） | 依官方 Node.js 與 POSIX 規格（已通過單元測試） |

## 限制

- **上游需支援 Anthropic `/v1/messages` 格式：** 若供應商只支援 OpenAI Chat Completions 格式，需搭配本地轉換 Gateway（可透過 `providers.<name>.launch` 由轉發站自動拉起）。
- **長對話中途切回 Claude 會重建快取：** 不同供應商之間的 Prompt Cache 無法互通，在長對話執行 `/provider claude` 會在下一輪將完整歷史重新送給 Anthropic。

## 疑難排解

| 症狀 | 檢查項目 |
|---|---|
| `/provider` 顯示設定檔不存在或格式錯誤 | 執行 `node tools/setup.mjs check` 檢查 JSON 語法，若使用 `env:VAR` 請確認該環境變數已匯出 |
| 狀態列顯示轉發站離線（`Relay offline: connected directly to Claude`） | 外掛偵測到轉發站未回應時會自動退回直連確保對話不中斷；可執行 `node tools/setup.mjs check` 或查看 `~/.claude/custom-agent-router.log` |
| 切到第三方供應商後工具消失或無法呼叫工具 | 確認該供應商在 `model-relay.json` 中設有 `"stripToolSearch": true` |

## 移除

1. 若曾在 `~/.claude/settings.json` 設定 `ANTHROPIC_BASE_URL` 請將其移除，並停止使用 `--plugin-dir` 載入。
2. 刪除本專案資料夾以及 `~/.claude/model-relay.json`、`~/.claude/model-relay-state.json`、`~/.claude/custom-agent-router.log`、`~/.claude/custom-agent-requests.log`。

## 從原始碼執行

```bash
node tools/check.mjs
claude plugin validate .
claude plugin test .
```

架構說明與發版流程請見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 更多

- [版本紀錄](CHANGELOG.zh-TW.md)
- [貢獻指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [授權條款 (MIT)](LICENSE)
