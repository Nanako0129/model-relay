'use strict'
// Local relay router for Claude Code: routes requests across Claude and custom providers
// (GLM, Gemini, DeepSeek, Kimi, MiniMax, OpenRouter, etc.), with sticky session cache protection and 429 failover.
// Usage: node router.js <config-dir>
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const L = require('./logic')

const dir = process.argv[2] || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude')

function resolveCfgPath() {
  const relay = path.join(dir, 'model-relay.json')
  if (fs.existsSync(relay)) return relay
  return path.join(dir, 'custom-agent.json')
}

function resolveStatePath() {
  const relay = path.join(dir, 'model-relay-state.json')
  if (fs.existsSync(relay)) return relay
  const legacy = path.join(dir, 'custom-agent-state.json')
  if (fs.existsSync(legacy)) return legacy
  return relay
}

const LOG_FILE = path.join(dir, 'custom-agent-router.log')
const REQLOG = path.join(dir, 'custom-agent-requests.log')

const readCfg = () => {
  try {
    return L.parseCfg(JSON.parse(fs.readFileSync(resolveCfgPath(), 'utf8')))
  } catch {
    return null
  }
}

let state = (() => {
  try {
    return L.parseState(JSON.parse(fs.readFileSync(resolveStatePath(), 'utf8')))
  } catch {
    return L.emptyState()
  }
})()

// In-memory runtime latency/status per provider
const providerStats = {}

const log = (line) => {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const save = () => {
  state = L.pruneSticky(state, Date.now())
  try {
    fs.writeFileSync(resolveStatePath(), JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + '\n')
  } catch {}
}

const setState = (next, why) => {
  state = next
  save()
  if (why) log(why)
}
setInterval(save, 600000).unref()

const short = (sid) => (sid ? sid.slice(0, 8) : '-')
const stick = (sid, providerName, why) => {
  if (!sid || !providerName) return
  const prev = state.sticky?.[sid]?.provider
  state = L.setSticky(state, sid, providerName, Date.now())
  if (prev !== providerName) setState(state, `session ${short(sid)} moved to ${providerName} (${why})`)
}

const logReq = (entry) => {
  try {
    if (fs.statSync(REQLOG).size > 5 * 1024 * 1024) fs.writeFileSync(REQLOG, '')
  } catch {}
  try {
    fs.appendFileSync(REQLOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n')
  } catch {}
}

const apiError = (res, status, message) => {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `model-relay router: ${message}` } }))
}

const json = (res, obj) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function send(base, req, body, headers, onResponse, onError) {
  const u = new URL(base)
  const lib = u.protocol === 'http:' ? http : https
  const up = lib.request(
    {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: L.upstreamPath(base, req.url),
      method: req.method,
      headers: { ...headers, host: u.host, 'content-length': body.length },
    },
    onResponse,
  )
  up.on('error', onError)
  up.end(body)
}

function buildAuthHeaders(provider, baseHeaders = {}) {
  const headers = { ...baseHeaders }
  delete headers['x-api-key']
  delete headers['authorization']
  if (provider.authHeader === 'bearer' || provider.authHeader === 'both') {
    headers['authorization'] = `Bearer ${provider.token}`
  }
  if (provider.authHeader === 'x-api-key' || provider.authHeader === 'both') {
    headers['x-api-key'] = provider.token
  }
  return headers
}

function pingOne(provider) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const u = new URL(provider.url)
    const lib = u.protocol === 'http:' ? http : https
    const payload = Buffer.from(JSON.stringify({
      model: L.wireModel(provider.model),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }))
    const headers = buildAuthHeaders(provider, {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'content-length': payload.length,
      host: u.host,
    })
    const up = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: L.upstreamPath(provider.url, '/v1/messages'),
      method: 'POST',
      headers,
      timeout: 8000,
    }, (ur) => {
      ur.resume()
      ur.on('end', () => {
        const entry = { status: ur.statusCode || 0, ms: Date.now() - t0, at: Date.now() }
        providerStats[provider.name] = entry
        resolve(entry)
      })
    })
    up.on('timeout', () => {
      up.destroy()
      const entry = { status: 0, ms: Date.now() - t0, at: Date.now() }
      providerStats[provider.name] = entry
      resolve(entry)
    })
    up.on('error', () => {
      const entry = { status: 0, ms: Date.now() - t0, at: Date.now() }
      providerStats[provider.name] = entry
      resolve(entry)
    })
    up.end(payload)
  })
}

function toProvider(provider, req, res, body, rewrite, sid, attempt = 0) {
  const t0 = Date.now()
  let out = body
  if (body.length) {
    try {
      out = L.rewriteBody(body, {
        model: rewrite ? provider.model : null,
        stripCacheControl: provider.stripCacheControl,
        stripToolSearch: provider.stripToolSearch,
      })
    } catch {
      if (rewrite) return apiError(res, 400, `could not rewrite request for provider "${provider.name}"`)
    }
  }
  const headers = buildAuthHeaders(provider, req.headers)
  const cfgNow = readCfg()
  const retryCfg = cfgNow ? cfgNow.retry : null

  // Retries exhausted on this provider: hand the ORIGINAL body to the failover provider when one exists
  const giveUp = (status, text, upstreamHeaders) => {
    const fo = cfgNow && cfgNow.failoverEnabled !== false ? cfgNow.providers[cfgNow.failoverProvider] : null
    if (retryCfg && retryCfg.failover && fo && fo.name !== provider.name) {
      log(`provider "${provider.name}" kept failing (last ${status}); failing over to "${fo.name}" for this request`)
      return toProvider(fo, req, res, body, true, sid, 0)
    }
    if (text !== null) {
      res.writeHead(status, upstreamHeaders || { 'content-type': 'application/json' })
      return res.end(text)
    }
    return apiError(res, 502, `provider "${provider.name}" unreachable`)
  }

  const maybeRetry = (status, upstreamHeaders, onErrorText) => {
    providerStats[provider.name] = { status, ms: Date.now() - t0, at: Date.now() }
    if (!retryCfg) return false
    const wait = L.retryWaitMs(status, upstreamHeaders, attempt, retryCfg)
    if (wait === null) return false
    log(`provider "${provider.name}" answered ${status}; retry ${attempt + 1}/${retryCfg.attempts} in ${wait}ms`)
    setTimeout(() => toProvider(provider, req, res, body, rewrite, sid, attempt + 1), wait)
    return true
  }

  send(provider.url, req, out, headers, (ur) => {
    const status = ur.statusCode || 0
    if (status >= 200 && status < 300) {
      res.writeHead(ur.statusCode, ur.headers)
      let tail = ''
      ur.on('data', (c) => {
        tail = (tail + c.toString('utf8')).slice(-4000)
      })
      ur.on('end', () => {
        providerStats[provider.name] = { status, ms: Date.now() - t0, at: Date.now() }
        const all = [...tail.matchAll(/"input_tokens"\s*:\s*(\d+)/g)]
        const last = all.length ? Number(all[all.length - 1][1]) : null
        const tag = provider.name === 'glm' ? 'zai' : provider.name
        logReq({ to: `${tag}-reply`, sid: short(sid), rewrite, status, bytes: out.length, inputTokens: last, attempt })
      })
      return ur.pipe(res)
    }
    // Failure: buffer the whole answer, then retry, fail over, or pass it through untouched
    const chunks = []
    ur.on('data', (c) => chunks.push(c))
    ur.on('end', () => {
      const text = Buffer.concat(chunks)
      logReq({ to: `${provider.name}-fail`, sid: short(sid), status, bytes: text.length, attempt })
      if (maybeRetry(status, ur.headers, null)) return
      giveUp(status, text, ur.headers)
    })
  }, (e) => {
    logReq({ to: `${provider.name}-fail`, sid: short(sid), status: 0, attempt, error: e.message })
    if (maybeRetry(502, null, e.message)) return
    giveUp(502, null, null)
  })
}

function toClaude(cfg, req, res, body, trial, sid) {
  send(cfg.claudeUrl, req, body, { ...req.headers }, (ur) => {
    if (ur.statusCode !== 429) {
      if (trial && ur.statusCode < 400) setState(L.onClaudeOk(state), 'claude ok again: new sessions use Claude')
      res.writeHead(ur.statusCode, ur.headers)
      return ur.pipe(res)
    }
    const chunks = []
    ur.on('data', (c) => chunks.push(c))
    ur.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const foProvider = cfg.providers[cfg.failoverProvider]
      if (cfg.failoverEnabled && foProvider && L.isUsageLimit(429, ur.headers, text)) {
        setState(L.onLimited(state, cfg, Date.now()), `claude usage limit${trial ? ' (still)' : ''}: using ${foProvider.name} (${foProvider.model})`)
        stick(sid, foProvider.name, 'usage limit')
        return toProvider(foProvider, req, res, body, true, sid)
      }
      res.writeHead(ur.statusCode, ur.headers)
      res.end(text)
    })
  }, (e) => apiError(res, 502, `Anthropic unreachable: ${e.message}`))
}

function control(req, res, body) {
  const u = new URL(req.url, 'http://x')
  const cfg = readCfg()
  if (u.pathname === '/__health') {
    const sid = u.searchParams.get('sid') || ''
    const providers = {}
    if (cfg) {
      for (const [k, p] of Object.entries(cfg.providers)) providers[k] = p.model
    }
    return json(res, {
      ok: true,
      pid: process.pid,
      failoverSince: state.failoverSince,
      nextClaudeTry: state.nextClaudeTry,
      failoverProvider: cfg ? cfg.failoverProvider : 'glm',
      providers,
      stats: providerStats,
      sessionsOnCustom: Object.keys(state.sticky || {}).length,
      sessionsOnGlm: Object.keys(state.onGlm || {}).length,
      session: L.getSessionProvider(state, cfg, sid),
    })
  }
  if (u.pathname === '/__session' && req.method === 'POST') {
    let sid = ''
    let on = ''
    try {
      ;({ sid, on } = JSON.parse(body.toString('utf8')))
    } catch {}
    on = String(on || '').trim().toLowerCase()
    if (!sid || !on) return apiError(res, 400, 'need {sid, on: "<provider>" | "claude"}')
    if (on !== 'claude' && !cfg?.providers?.[on]) {
      const avail = cfg ? Object.keys(cfg.providers).join(', ') : 'none'
      return apiError(res, 400, `unknown provider "${on}" (configured: ${avail})`)
    }
    setState(L.setSticky(state, sid, on, Date.now()), `session ${short(sid)} set to ${on} by hand`)
    return json(res, { ok: true, session: on })
  }
  if (u.pathname === '/__probe' && req.method === 'POST') {
    setState({ ...state, nextClaudeTry: 0 }, 'manual probe requested: next new session will try Claude')
    return json(res, { ok: true, failoverSince: state.failoverSince, nextClaudeTry: 0 })
  }
  if (u.pathname === '/__ping' && req.method === 'POST') {
    if (!cfg) return apiError(res, 500, 'config missing')
    let target = ''
    try {
      target = String(JSON.parse(body.toString('utf8')).provider || '').trim().toLowerCase()
    } catch {}
    const list = target && cfg.providers[target] ? [cfg.providers[target]] : Object.values(cfg.providers)
    Promise.all(list.map(pingOne)).then(() => {
      json(res, { ok: true, stats: providerStats })
    })
    return
  }
  return apiError(res, 404, 'unknown control path')
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (req.url.startsWith('/__')) return control(req, res, body)
    const cfg = readCfg()
    if (!cfg) return apiError(res, 500, 'model-relay.json / custom-agent.json is missing or invalid')
    const sid = String(req.headers['x-claude-code-session-id'] || '')
    let model = null
    let nMsgs = 0
    if (body.length) {
      try {
        const j = JSON.parse(body.toString('utf8'))
        model = j.model
        nMsgs = (j.messages || []).length
      } catch {}
    }
    const route = L.decide(state, cfg, model, sid, Date.now())
    logReq({ sid: short(sid), model, nMsgs, route })
    const parsed = L.parseRoute(route, cfg)
    if (parsed.kind === 'provider' && parsed.provider) {
      if (parsed.rewrite && state.failoverSince && L.getSessionProvider(state, cfg, sid) === 'claude') {
        stick(sid, parsed.name, 'claude still out')
      }
      return toProvider(parsed.provider, req, res, body, parsed.rewrite, sid)
    }
    return toClaude(cfg, req, res, body, parsed.trial, sid)
  })
})

const cfg0 = readCfg()
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0)
  log(`server error: ${e.message}`)
  process.exit(1)
})
server.listen(cfg0 ? cfg0.port : 8950, '127.0.0.1', () => {
  log(`router up on ${cfg0 ? cfg0.port : 8950}, pid ${process.pid}`)
  superviseLaunchers()
  setInterval(superviseLaunchers, 30000).unref()
})

// Any local provider with `launch: {command, args}` is automatically started when its local port is closed.
function superviseLaunchers() {
  const cfg = readCfg()
  if (!cfg) return
  for (const p of Object.values(cfg.providers)) {
    const l = p.launch
    if (!l || typeof l.command !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(p.url)) continue
    const u = new URL(p.url)
    const port = Number(u.port) || 80
    const sock = require('net').connect({ host: '127.0.0.1', port })
    sock.setTimeout(2000)
    sock.on('connect', () => sock.destroy())
    const down = () => {
      sock.destroy()
      try {
        const c = require('child_process').spawn(l.command, Array.isArray(l.args) ? l.args : [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        c.on('error', (e) => log(`launch [${p.name}] failed: ${e.message}`))
        c.unref()
        log(`launched [${p.name}] ${l.command} (port ${port} was closed)`)
      } catch (e) {
        log(`launch [${p.name}] failed: ${e.message}`)
      }
    }
    sock.on('error', down)
    sock.on('timeout', down)
  }
}
