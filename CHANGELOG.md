# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

All notable changes to `model-relay` are documented in this file. Format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (while in `0.x`, minor versions may include breaking changes). The canonical version is defined in `.claude-plugin/plugin.json`.

## [Unreleased]

## [0.5.0] - 2026-10-18

A provider that answers 429 or 5xx no longer kills your turn: the relay retries the SAME provider with exponential backoff, polling at `retry.maxDelayMs` when `Retry-After` asks for longer, so Claude Code never sees the intermediate failures. Cross-provider failover after exhausted retries is available as an opt-in.

**Upgrading:** Pull the latest version; same-provider retrying is on by default and needs no configuration. Tune it with the new `retry` settings.

### Added

- **Transparent same-provider retries with backoff:** Failing provider answers (429, 500, 502, 503, 504, 529) are retried on the same provider up to `retry.attempts` times with `retry.delayMs` × `retry.backoff` waits, capped by `retry.maxDelayMs`. Settings: `retry`.
- **`Retry-After` awareness:** A provider asking to wait longer than `retry.maxDelayMs` keeps being polled at that cap instead of giving up early. Setting: `retry.maxDelayMs`.
- **Opt-in cross-provider failover:** With `retry.failover: true`, the original (un-rewritten) request is forwarded to `failover.provider` once retries run out, so the turn completes on the backup model rather than returning the error. Setting: `retry.failover`.

## [0.4.0] - 2026-10-17

Type `/provider` to open an interactive `AbovePrompt` control panel right above your prompt input box: switch the current window's model with one click (or hotkeys `1`–`9`), test live latency across every provider (`[Ping]`), and protect long prompt caches with a two-click confirmation before switching back to Claude. Both English and Traditional Chinese READMEs now have their own animated banners and story diagrams.

**Upgrading:** Pull the latest version or run `claude plugin update model-relay@model-relay`. No configuration changes are required.

### Added

- **Interactive `AbovePrompt` control panel:** Running `/provider` or `/provider panel` opens an interactive panel above the prompt where you can switch providers by clicking buttons or pressing `ctrl+x tab` + `1`–`9`, with a two-step confirmation before switching a pinned session back to Claude.
- **Live upstream latency ping (`/__ping` and `/provider ping`):** Test live HTTP status and response time for all configured providers directly from the panel (`[Ping]`) or via `/provider ping`, and reset 429 cooldown timers via `[Retry Claude]` or `/provider probe`.
- **Separate English and Traditional Chinese animated SVGs:** Added dedicated English and Traditional Chinese dark/light banners (`banner-dark.svg`, `banner-light.svg`, `banner-dark.zh-TW.svg`, `banner-light.zh-TW.svg`) and story animations (`relay-flow.svg` / `.zh-TW.svg`, `panel.svg` / `.zh-TW.svg`).

## [0.3.0] - 2026-10-17

`model-relay` is now open-source as a flexible, multi-provider localhost router and failover toolkit for Claude Code. You can route individual conversations or `haiku` subagents across Claude, GLM (`z.ai`), Gemini (via local gateway), DeepSeek, Kimi, MiniMax, or OpenRouter without losing prompt cache efficiency when Claude hits a 429 usage limit.

**Upgrading:** Existing `~/.claude/custom-agent.json` files continue to work without changes. Run `node tools/setup.mjs init --fix` and `node tools/setup.mjs doctor --ping` to verify your setup or migrate to `~/.claude/model-relay.json`.

### Added

- **Flexible multi-provider routing and built-in presets:** Configure any number of providers under `providers.<name>` using built-in presets (`zai`, `glm`, `deepseek`, `kimi`, `minimax`, `openrouter`, `gemini`, `magpie`) so `baseUrl`, `model`, `matchModels`, `stripToolSearch`, `stripCacheControl`, and `authHeader` work out of the box with just a `token`. Setting: `providers`.
- **Cache-safe sticky 429 failover:** When Anthropic returns a 429 usage-limit response, the router automatically forwards to `failover.provider` and pins that session for 7 days so recovering Claude quota never triggers an expensive 800k-token prompt cache rebuild on existing long chats. Setting: `failover`.
- **Structured `/provider` command and live provider sync:** `/provider` now displays an aligned route list (`●` active vs `○` available) synced directly with the router's live `/__health` endpoint, hiding providers whose `env:VAR_NAME` token is unset.
- **One-command `doctor` and upstream `--ping` CLI:** Run `node tools/setup.mjs doctor --fix --ping` to validate config syntax, detect unset `env:VAR` variables, wire `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`, check localhost router health, and send a 1-token live probe to every configured provider.
- **Local gateway supervision (`launch`):** Providers pointing at `127.0.0.1` or `localhost` can declare `launch: { command, args }` so the router automatically spawns the local gateway whenever its TCP port is closed. Setting: `providers.<name>.launch`.
- **Cross-platform and bilingual UI support:** Supports both Windows (`powershell.exe` + `curl.exe`) and macOS/Linux (`sh` + `curl`), with English and Traditional Chinese status/command output plus SVG architecture diagrams.

### Removed

- **Legacy child-process `custom_agent` tool:** Removed the deprecated `claude.exe -p` child-process wrapper so the plugin focuses purely on fast, zero-overhead HTTP relay and session routing.

[unreleased]: https://github.com/cablate/model-relay/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/cablate/model-relay/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cablate/model-relay/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cablate/model-relay/releases/tag/v0.3.0
