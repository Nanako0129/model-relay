# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

All notable changes to `model-relay` are documented in this file. Format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (while in `0.x`, minor versions may include breaking changes). The canonical version is defined in `.claude-plugin/plugin.json`.

## [Unreleased]

## [0.3.0] - 2026-10-17

You can now configure any number of Anthropic-compatible providers (GLM, Gemini, DeepSeek, OpenRouter, or local gateways) in a single `providers` map, reference API keys via `env:VAR_NAME`, and run on both Windows and macOS/Linux.

**Upgrading:** Existing `~/.claude/custom-agent.json` files continue to work without changes. To adopt the new multi-provider format, copy `model-relay.example.json` to `~/.claude/model-relay.json`.

### Added

- **Flexible multi-provider routing:** Configure arbitrary providers under `providers.<name>` and switch per conversation with `/provider <name>`, with per-provider `matchModels`, `stripToolSearch`, `stripCacheControl`, `authHeader`, and localhost `launch` supervision. Setting: `providers`.
- **Environment variable token resolution:** Keep API keys out of config files by setting `"token": "env:YOUR_API_KEY"`. Setting: `providers.<name>.token`.
- **Cross-platform and bilingual UI support:** Added POSIX (`sh` + `curl`) process helpers alongside Windows PowerShell, plus English/Traditional Chinese status and `/provider` messages based on Claude Code `language` settings.
- **Setup and verification CLI:** Run `node tools/setup.mjs init` and `node tools/setup.mjs check` to initialize and verify your relay configuration and health.

### Removed

- **Legacy child-process `custom_agent` tool:** Removed the deprecated `claude.exe -p` child-process wrapper so the plugin focuses purely on clean HTTP relay and session routing.
