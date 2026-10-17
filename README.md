# model-relay

[繁體中文](README.zh-TW.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" width="900" alt="model-relay: multi-provider router and cache-safe failover for Claude Code">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/cablate/model-relay/releases"><img src="https://img.shields.io/github/v/release/cablate/model-relay?include_prereleases&display_name=release&label=release&color=38bdf8" alt="Latest release"></a>
  <a href="https://github.com/cablate/model-relay/actions/workflows/ci.yml"><img src="https://github.com/cablate/model-relay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

**Route Claude Code conversations and subagents across Claude, GLM, Gemini, DeepSeek, or any Anthropic-compatible provider with cache-safe sticky sessions and automatic 429 failover.**

<p align="center">
  <img src="docs/assets/relay-flow.svg" width="900" alt="Architecture diagram showing how model-relay routes Claude Code sessions, haiku subagents, and 429 failovers across Claude, GLM, DeepSeek, and Gemini">
</p>

| Scenario | Without `model-relay` | With `model-relay` |
|---|---|---|
| Claude hits a 5-hour usage limit mid-task | Conversation stops until quota resets or you restart with a different env | Automatically fails over to your backup provider and pins the session |
| Switching a long chat back when Claude recovers | Rebuilds an 800k+ token prompt cache on Claude and burns quota | Sticky sessions stay on the backup provider; only new chats return to Claude |
| Offloading `haiku` subagents to a cheaper/faster endpoint | Requires global env overrides that affect the main Opus/Sonnet thread | Routes matching models (`matchModels`) to a target provider while keeping the main thread on Claude |
| Third-party gateways choke on `ToolSearch` or `cache_control` | Tools disappear or requests fail with 400 errors | Per-provider `stripToolSearch` and `stripCacheControl` flags clean requests on the fly |

## Quick start

Requirements: Node.js 20+ and Claude Code CLI (tested on Node.js 22.23.2 and Windows 11 / POSIX).

1. Initialize your configuration file (`~/.claude/model-relay.json`) and wire `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`:

```bash
node tools/setup.mjs init --fix
```

2. Set your provider API key (or add a provider with a built-in preset like `zai`, `deepseek`, `kimi`, `minimax`, `openrouter`, `gemini`) and run the doctor check:

```bash
export ZAI_API_KEY="your-api-key"
node tools/setup.mjs doctor --ping
```

Expected output:

```text
Config OK (~/.claude/model-relay.json)
  Port: 8950
  Providers: glm -> glm-5.3[1m], deepseek -> deepseek-chat, gemini -> gemini-4-argon
  Failover: glm (cooldown 600s)
  Router status: offline on 127.0.0.1:8950 (will auto-start when Claude Code launches)
```

3. Install and load the plugin in Claude Code (or pass `--plugin-dir /path/to/model-relay`):

```bash
/plugin install model-relay --marketplace cablate/model-relay
```

To update, pull the latest commits and restart Claude Code.

## Who this is for

`model-relay` is for Claude Code users who want uninterrupted sessions during usage limits, per-session `/provider` switching, or subagent model offloading without losing prompt cache efficiency. If you want a general-purpose multi-tenant cloud API gateway for a team server, use LiteLLM instead—`model-relay` is a single-user localhost daemon (`127.0.0.1`).

## Features

### Per-session `/provider` switching without touching other windows

Switch the current conversation to any configured provider (`/provider glm`, `/provider gemini`, `/provider deepseek`) while other open Claude Code terminals stay on Claude.

### Cache-safe sticky failover on 429 usage limits

When Anthropic returns a 429 usage-limit response, the router forwards the request to your configured `failover.provider` and marks the session sticky for 7 days. After `cooldownMs` (default 10 minutes), new sessions probe Claude again while existing sticky sessions stay on their backup provider so they never pay to rebuild a massive prompt cache.

### Declarative provider quirks and local gateway supervision

Each provider in `providers` can declare `matchModels` (regexes to route specific model IDs like `haiku`), `stripToolSearch` (removes `ToolSearch` and `defer_loading: true` tools), `stripCacheControl` (strips `cache_control` blocks), `authHeader` (`bearer`, `x-api-key`, or `both`), `env:VAR_NAME` token references, and an optional `launch` command to auto-start a local gateway when its localhost port is closed.

## Configuration

Configuration lives in `~/.claude/model-relay.json` (or legacy `~/.claude/custom-agent.json`). The directory defaults to `$CLAUDE_CONFIG_DIR` when set, falling back to `$USERPROFILE/.claude` or `$HOME/.claude`.

| Field | Default | Meaning |
|---|---|---|
| `port` | `8950` | Localhost port for the relay HTTP server (`1025`–`65535`) |
| `claudeUrl` | `"https://api.anthropic.com"` | Upstream Anthropic API base URL |
| `failover.enabled` | `true` | Automatically switch to `failover.provider` on Claude 429 usage limits |
| `failover.provider` | `"glm"` (or first provider) | Provider key used for 429 failover |
| `failover.cooldownMs` | `600000` | Milliseconds before probing Claude again for new sessions (10 minutes) |
| `providers.<name>.baseUrl` | (required) | Anthropic-compatible upstream URL for this provider |
| `providers.<name>.token` | (required) | Literal token or `"env:ENV_VAR_NAME"` |
| `providers.<name>.model` | (required) | Target model ID when rewriting requests (suffixes like `[1m]` are stripped on wire) |
| `providers.<name>.matchModels` | `["^<name>"]` | Regex patterns matched against incoming request `model` |
| `providers.<name>.stripToolSearch` | `true` | Strip `ToolSearch` and `defer_loading: true` tools from requests |
| `providers.<name>.stripCacheControl` | `false` | Recursively remove `cache_control` fields before forwarding |
| `providers.<name>.authHeader` | `"both"` | How to send credentials: `"bearer"`, `"x-api-key"`, or `"both"` |
| `providers.<name>.launch` | `null` | `{ "command": "...", "args": [...] }` to auto-spawn if localhost port is closed |

## Commands

| Command | Description |
|---|---|
| `/provider` | Show current session routing status, failover state, and available providers |
| `/provider <name>` | Pin the current conversation to provider `<name>` (e.g. `/provider glm`, `/provider gemini`) |
| `/provider claude` | Switch the current conversation back to Claude (rebuilds prompt cache on next turn) |

## Cost, privacy, and permissions

- **Network and data flow:** The router listens only on `127.0.0.1:<port>`. Requests go strictly to `claudeUrl` (`https://api.anthropic.com`) or the `baseUrl` endpoints you configure. No telemetry or external analytics are sent.
- **Local files:** Reads `~/.claude/model-relay.json` (or `custom-agent.json`) and writes session sticky state to `~/.claude/model-relay-state.json` plus local logs (`custom-agent-router.log` and `custom-agent-requests.log`, auto-truncated at 5 MB).
- **Plugin permissions:** You can inspect the exact hooks and env access at any time by running `claude plugin validate /path/to/model-relay`.

## Supported environments

| Environment | Status |
|---|---|
| Windows 11 + Node.js 22 + Git Bash / PowerShell | Tested |
| macOS / Linux + Node.js 20+ (`sh` + `curl`) | Per official Node.js & POSIX specs (unit-tested) |

## Limitations

- **Requires an Anthropic-compatible `/v1/messages` endpoint:** Providers that only speak OpenAI Chat Completions require a local translation proxy (and can be supervised via `providers.<name>.launch`).
- **Switching back to Claude mid-session rebuilds cache:** Because prompt caches do not transfer across providers, `/provider claude` on a long conversation will resend the full conversation history to Anthropic.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `/provider` says config is missing or invalid | Run `node tools/setup.mjs check` to verify JSON syntax and ensure `env:VAR` variables are set in your shell |
| Status bar shows `Relay offline: connected directly to Claude` | The plugin automatically bypassed a stopped router so your chat keeps working; run `node tools/setup.mjs check` or check `~/.claude/custom-agent-router.log` |
| Tools are missing on a third-party provider | Set `"stripToolSearch": true` on that provider in `model-relay.json` so `ToolSearch` does not hide other tools |

## Uninstall

1. Remove `ANTHROPIC_BASE_URL` from `~/.claude/settings.json` if you set it there, and stop passing `--plugin-dir`.
2. Delete the plugin directory and optional state files (`~/.claude/model-relay.json`, `~/.claude/model-relay-state.json`, `~/.claude/custom-agent-router.log`, `~/.claude/custom-agent-requests.log`).

## Run from source

```bash
node tools/check.mjs
claude plugin validate .
claude plugin test .
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture and release steps.

## More

- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [License (MIT)](LICENSE)
