#!/usr/bin/env node
// Setup, preset management, and doctor CLI for model-relay.
// Usage:
//   node tools/setup.mjs init [--fix]
//   node tools/setup.mjs presets
//   node tools/setup.mjs add <name> --token <token|env:VAR> [--preset <p>] [--model <m>] [--url <u>]
//   node tools/setup.mjs doctor [--fix] [--ping]   (alias: check)

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const L = require('../router/logic.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.USERPROFILE || process.env.HOME || ''
const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
const relayCfgPath = path.join(cfgDir, 'model-relay.json')
const legacyCfgPath = path.join(cfgDir, 'custom-agent.json')
const settingsPath = path.join(cfgDir, 'settings.json')
const examplePath = path.join(root, 'model-relay.example.json')

const args = process.argv.slice(2)
const cmd = args[0] || 'doctor'
const hasFlag = (f) => args.includes(f)
const getOpt = (f) => {
  const i = args.indexOf(f)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

function resolveActiveCfgPath() {
  if (fs.existsSync(relayCfgPath)) return relayCfgPath
  if (fs.existsSync(legacyCfgPath)) return legacyCfgPath
  return relayCfgPath
}

function ensureSettingsWiring(port, fix) {
  const expectedUrl = `http://127.0.0.1:${port}`
  if (!fs.existsSync(settingsPath)) {
    if (!fix) return { ok: false, msg: `Missing ${settingsPath} (run with --fix to wire ANTHROPIC_BASE_URL=${expectedUrl})` }
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: expectedUrl } }, null, 2) + '\n')
    return { ok: true, msg: `Created ${settingsPath} with ANTHROPIC_BASE_URL=${expectedUrl}` }
  }
  let s = {}
  try {
    s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch (e) {
    return { ok: false, msg: `Invalid JSON in ${settingsPath}: ${e.message}` }
  }
  const cur = s?.env?.ANTHROPIC_BASE_URL
  if (cur === expectedUrl) {
    return { ok: true, msg: `settings.json ANTHROPIC_BASE_URL=${cur}` }
  }
  if (!fix) {
    return {
      ok: false,
      msg: `settings.json env.ANTHROPIC_BASE_URL is ${cur ? `"${cur}"` : 'unset'} (expected "${expectedUrl}" — run "node tools/setup.mjs doctor --fix" to set it)`,
    }
  }
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: expectedUrl }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  return { ok: true, msg: `Updated settings.json env.ANTHROPIC_BASE_URL=${expectedUrl}` }
}

function pingProvider(p) {
  return new Promise((resolve) => {
    const start = Date.now()
    const u = new URL(p.url)
    const lib = u.protocol === 'http:' ? http : https
    const payload = Buffer.from(JSON.stringify({
      model: L.wireModel(p.model),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }))
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'content-length': payload.length,
    }
    if (p.authHeader === 'bearer' || p.authHeader === 'both') headers['authorization'] = `Bearer ${p.token}`
    if (p.authHeader === 'x-api-key' || p.authHeader === 'both') headers['x-api-key'] = p.token

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: L.upstreamPath(p.url, '/v1/messages'),
      method: 'POST',
      headers,
      timeout: 8000,
    }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => {
        const ms = Date.now() - start
        const ok = res.statusCode >= 200 && res.statusCode < 300
        resolve({ ok, status: res.statusCode, ms, body: Buffer.concat(ch).toString('utf8').slice(0, 160) })
      })
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: Date.now() - start, body: 'timeout' }) })
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - start, body: e.message }))
    req.end(payload)
  })
}

if (cmd === 'presets') {
  console.log('Built-in provider presets (use in model-relay.json or "node tools/setup.mjs add <name>"):')
  for (const [k, v] of Object.entries(L.PRESETS)) {
    console.log(`  - ${k.padEnd(10)} model=${v.model.padEnd(25)} url=${v.baseUrl}`)
  }
  process.exit(0)
}

if (cmd === 'init') {
  fs.mkdirSync(cfgDir, { recursive: true })
  const active = resolveActiveCfgPath()
  if (fs.existsSync(active)) {
    console.log(`Config already exists at: ${active}`)
  } else {
    fs.copyFileSync(examplePath, relayCfgPath)
    console.log(`Created ${relayCfgPath} from model-relay.example.json.`)
  }
  if (hasFlag('--fix')) {
    const w = ensureSettingsWiring(8950, true)
    console.log(`  ${w.msg}`)
  }
  console.log('Set your API key environment variables (e.g. ZAI_API_KEY) or run "node tools/setup.mjs add <name> --token ..." before starting Claude Code.')
  process.exit(0)
}

if (cmd === 'add') {
  const name = (args[1] || '').trim().toLowerCase()
  const token = getOpt('--token')
  if (!name || name.startsWith('--') || !token) {
    console.error('Usage: node tools/setup.mjs add <name> --token <token|env:VAR> [--preset <p>] [--model <m>] [--url <u>]')
    process.exit(2)
  }
  fs.mkdirSync(cfgDir, { recursive: true })
  const active = resolveActiveCfgPath()
  let raw = { port: 8950, failover: { enabled: true, provider: name, cooldownMs: 600000 }, providers: {} }
  if (fs.existsSync(active)) {
    try { raw = JSON.parse(fs.readFileSync(active, 'utf8')) } catch {}
  }
  raw.providers = raw.providers || {}
  const presetKey = (getOpt('--preset') || name).toLowerCase()
  const preset = L.PRESETS[presetKey] || {}
  raw.providers[name] = {
    ...(presetKey && L.PRESETS[presetKey] ? { preset: presetKey } : {}),
    baseUrl: getOpt('--url') || preset.baseUrl || 'https://api.example.com/anthropic',
    token,
    model: getOpt('--model') || preset.model || `${name}-default`,
  }
  fs.writeFileSync(active, JSON.stringify(raw, null, 2) + '\n')
  console.log(`Saved provider "${name}" (${raw.providers[name].model}) in ${active}`)
  process.exit(0)
}

if (cmd === 'check' || cmd === 'doctor') {
  const active = resolveActiveCfgPath()
  if (!fs.existsSync(active)) {
    console.error(`Missing config: ${active} (run "node tools/setup.mjs init" first)`)
    process.exit(1)
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(active, 'utf8'))
  } catch (e) {
    console.error(`Invalid JSON in ${active}: ${e.message}`)
    process.exit(1)
  }

  // Check for unset env:VAR tokens in raw.providers
  const skippedEnv = []
  if (raw && typeof raw.providers === 'object' && raw.providers !== null) {
    for (const [k, v] of Object.entries(raw.providers)) {
      if (v && typeof v.token === 'string' && v.token.startsWith('env:')) {
        const varName = v.token.slice(4).trim()
        if (!process.env[varName]) skippedEnv.push(`${k} (${varName} is unset)`)
      }
    }
  }

  const cfg = L.parseCfg(raw)
  if (!cfg) {
    console.error(`Config validation failed in ${active}. Ensure at least one provider has a resolved token (or set ${skippedEnv.join(', ')}).`)
    process.exit(1)
  }
  const names = Object.keys(cfg.providers)
  console.log(`Config OK (${active})`)
  console.log(`  Port: ${cfg.port}`)
  console.log(`  Providers: ${names.map((k) => `${k} -> ${cfg.providers[k].model}`).join(', ')}`)
  if (skippedEnv.length > 0) {
    console.log(`  Skipped (unset env var): ${skippedEnv.join(', ')}`)
  }
  console.log(`  Failover: ${cfg.failoverEnabled ? `${cfg.failoverProvider} (cooldown ${cfg.probeEveryMs / 1000}s)` : 'disabled'}`)

  const wiring = ensureSettingsWiring(cfg.port, hasFlag('--fix'))
  console.log(`  Claude settings: ${wiring.ok ? '✓' : '⚠'} ${wiring.msg}`)

  await new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${cfg.port}/__health`, { timeout: 2000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        console.log(`  Router health: ${Buffer.concat(chunks).toString('utf8').trim()}`)
        resolve()
      })
    })
    req.on('error', () => {
      console.log(`  Router status: offline on 127.0.0.1:${cfg.port} (will auto-start when Claude Code launches)`)
      resolve()
    })
    req.end()
  })

  if (hasFlag('--ping')) {
    console.log('  Upstream ping:')
    for (const [k, p] of Object.entries(cfg.providers)) {
      const r = await pingProvider(p)
      console.log(`    ${r.ok ? '✓' : '✗'} ${k.padEnd(10)} (${p.model}) -> HTTP ${r.status} in ${r.ms}ms${r.ok ? '' : ` [${r.body}]`}`)
    }
  }
} else {
  console.error('Usage: node tools/setup.mjs [init|presets|add|doctor|check] [--fix] [--ping]')
  process.exit(2)
}
