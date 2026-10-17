# Security Policy

## Scope and local-only design

`model-relay` runs an HTTP server bound strictly to `127.0.0.1` (localhost). It never listens on external network interfaces and only forwards requests to `https://api.anthropic.com` or the provider endpoints explicitly configured in your local `model-relay.json`.

## Storing API keys safely

Prefer `"token": "env:YOUR_ENV_VAR"` in `model-relay.json` so API keys remain in your environment variables or secret manager rather than plaintext files. Never commit `model-relay.json` or `custom-agent.json`.

## Reporting a vulnerability

If you discover a security issue (for example, header leakage across providers or localhost binding bypass), please open a private security advisory on GitHub rather than a public issue.
