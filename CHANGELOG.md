# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

All notable changes to `model-relay` are documented in this file. Format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (while in `0.x`, minor versions may include breaking changes). The canonical version is defined in `.claude-plugin/plugin.json`.

## [Unreleased]

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

[unreleased]: https://github.com/cablate/model-relay/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/cablate/model-relay/releases/tag/v0.3.0
