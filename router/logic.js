'use strict'
// Pure routing decisions for router.js, tested by logic.test.js (node --test).

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function resolveToken(rawToken, env = process.env) {
  const s = str(rawToken)
  if (!s) return null
  if (s.startsWith('env:')) {
    const key = s.slice(4).trim()
    return key ? str(env[key]) : null
  }
  return s
}

function defaultPrefixRegex(name, model) {
  const clean = wireModel(model)
  const prefix = clean.split(/[-_.:/]/)[0] || name
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
}

const PRESETS = {
  zai: {
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.3[1m]',
    matchModels: ['^glm', 'haiku'],
    stripToolSearch: true,
    stripCacheControl: false,
    authHeader: 'both',
  },
  glm: {
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.3[1m]',
    matchModels: ['^glm', 'haiku'],
    stripToolSearch: true,
    stripCacheControl: false,
    authHeader: 'both',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-chat',
    matchModels: ['^deepseek'],
    stripToolSearch: true,
    stripCacheControl: false,
    authHeader: 'bearer',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.ai/anthropic',
    model: 'kimi-k2',
    matchModels: ['^kimi', '^moonshot'],
    stripToolSearch: true,
    stripCacheControl: false,
    authHeader: 'bearer',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/anthropic',
    model: 'MiniMax-M1',
    matchModels: ['^minimax'],
    stripToolSearch: true,
    stripCacheControl: false,
    authHeader: 'bearer',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    model: 'anthropic/claude-sonnet-4',
    matchModels: ['^openrouter/'],
    stripToolSearch: true,
    stripCacheControl: false,
    authHeader: 'bearer',
  },
  gemini: {
    baseUrl: 'http://127.0.0.1:3425',
    model: 'gemini-4-argon',
    matchModels: ['^gemini'],
    stripToolSearch: true,
    stripCacheControl: true,
    authHeader: 'both',
  },
  magpie: {
    baseUrl: 'http://127.0.0.1:3425',
    model: 'gemini-4-argon',
    matchModels: ['^gemini'],
    stripToolSearch: true,
    stripCacheControl: true,
    authHeader: 'both',
  },
}

function parseProvider(name, raw, env = process.env) {
  if (typeof raw !== 'object' || raw === null) return null
  const presetKey = (str(raw.preset) || name || '').toLowerCase()
  const preset = PRESETS[presetKey] || null
  const url = str(raw.baseUrl || raw.url || preset?.baseUrl)
  const token = resolveToken(raw.token, env)
  const model = str(raw.model || preset?.model)
  if (!url || !/^https?:\/\//.test(url) || !token || !model) return null

  const isGeminiLike = /^gemini$/i.test(name) || /^gemini/i.test(model)
  const stripToolSearch = raw.stripToolSearch !== undefined
    ? Boolean(raw.stripToolSearch)
    : (preset ? preset.stripToolSearch : true)
  const stripCacheControl = raw.stripCacheControl !== undefined
    ? Boolean(raw.stripCacheControl)
    : (preset ? preset.stripCacheControl : isGeminiLike)
  const authHeader = raw.authHeader === 'bearer' || raw.authHeader === 'x-api-key' || raw.authHeader === 'both'
    ? raw.authHeader
    : (preset?.authHeader || (isGeminiLike ? 'both' : 'bearer'))

  const rawMatchers = Array.isArray(raw.matchModels) && raw.matchModels.length > 0
    ? raw.matchModels.filter((m) => typeof m === 'string' && m.length > 0)
    : (preset?.matchModels || [defaultPrefixRegex(name, model)])

  const matchRegexes = []
  for (const pat of rawMatchers) {
    try {
      matchRegexes.push(new RegExp(pat, 'i'))
    } catch {}
  }

  let launch = null
  if (typeof raw.launch === 'object' && raw.launch !== null && str(raw.launch.command)) {
    launch = {
      command: raw.launch.command,
      args: Array.isArray(raw.launch.args) ? raw.launch.args.filter((a) => typeof a === 'string') : [],
    }
  }

  return {
    name,
    url,
    token,
    model,
    stripToolSearch,
    stripCacheControl,
    authHeader,
    matchRegexes,
    launch,
  }
}

function parseCfg(raw, env = process.env) {
  if (typeof raw !== 'object' || raw === null) return null
  const providers = {}

  // 1. Modern format: { providers: { glm: {...}, gemini: {...}, ... } }
  if (typeof raw.providers === 'object' && raw.providers !== null) {
    for (const [k, v] of Object.entries(raw.providers)) {
      const key = k.trim().toLowerCase()
      if (!key || key === 'claude') continue
      const p = parseProvider(key, v, env)
      if (p) providers[key] = p
    }
  }

  // 2. Legacy format compatibility: top-level { baseUrl, token, model, gemini: {...} }
  if (!providers.glm && str(raw.baseUrl) && str(raw.token) && str(raw.model)) {
    const glm = parseProvider('glm', {
      baseUrl: raw.baseUrl,
      token: raw.token,
      model: raw.model,
      matchModels: ['^glm'],
      stripToolSearch: true,
      stripCacheControl: false,
      authHeader: 'bearer',
      launch: raw.launch,
    }, env)
    if (glm) providers.glm = glm
  }
  if (!providers.gemini && typeof raw.gemini === 'object' && raw.gemini !== null) {
    const gem = parseProvider('gemini', {
      ...raw.gemini,
      matchModels: raw.gemini.matchModels || ['^gemini'],
      stripCacheControl: raw.gemini.stripCacheControl !== undefined ? raw.gemini.stripCacheControl : true,
      authHeader: raw.gemini.authHeader || 'both',
    }, env)
    if (gem) providers.gemini = gem
  }

  const names = Object.keys(providers)
  if (names.length === 0) return null

  const fo = typeof raw.failover === 'object' && raw.failover !== null ? raw.failover : {}
  const failoverEnabled = fo.enabled !== undefined ? fo.enabled !== false : raw.failoverEnabled !== false
  const preferredFo = str(fo.provider || raw.failoverProvider)?.toLowerCase()
  const failoverProvider = (preferredFo && providers[preferredFo]) ? preferredFo : (providers.glm ? 'glm' : names[0])

  const rawMin = typeof fo.probeEveryMin === 'number' ? fo.probeEveryMin : raw.probeEveryMin
  const min = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : 10
  const port = Number.isInteger(raw.port) && raw.port > 1024 && raw.port < 65536 ? raw.port : 8950

  const primary = providers[failoverProvider]
  return {
    providers,
    failoverProvider,
    // Keep legacy fields for existing callers/tests
    zaiUrl: primary.url,
    token: primary.token,
    model: primary.model,
    gemini: providers.gemini || null,
    port,
    claudeUrl: str(raw.claudeUrl) || 'https://api.anthropic.com',
    failoverEnabled,
    probeEveryMs: Math.min(120, Math.max(1, min)) * 60000,
    retry: parseRetryCfg(raw.retry),
  }
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])

function parseRetryCfg(raw) {
  const r = typeof raw === 'object' && raw !== null ? raw : {}
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    attempts: Math.min(30, Math.floor(num(r.attempts, 3))),
    delayMs: Math.min(60000, num(r.delayMs, 2000)),
    backoff: Math.min(4, Math.max(1, num(r.backoff, 2))),
    maxDelayMs: Math.min(300000, num(r.maxDelayMs, 10000)),
    failover: r.failover === true,
  }
}

// How long to wait before retrying the SAME provider, or null when retrying cannot help
// (status not retryable, or attempts exhausted). Retry-After within budget is honoured;
// a longer one keeps polling at maxDelayMs instead of giving up.
function retryWaitMs(status, headers, attempt, cfg) {
  if (!RETRYABLE_STATUSES.has(status)) return null
  if (attempt >= cfg.attempts) return null
  const ra = headers && headers['retry-after']
  const raText = Array.isArray(ra) ? ra[0] : ra
  const raSec = Number(raText)
  if (Number.isFinite(raSec) && raSec > 0) {
    return Math.min(Math.max(raSec * 1000, cfg.delayMs), cfg.maxDelayMs)
  }
  return Math.min(cfg.maxDelayMs, cfg.delayMs * Math.pow(cfg.backoff, attempt))
}

const isGeminiModel = (model) => typeof model === 'string' && /^gemini/i.test(model)
const isGlmModel = (model) => typeof model === 'string' && /^glm/i.test(model)

function matchProviderByModel(cfg, model) {
  if (typeof model !== 'string' || !model || !cfg || !cfg.providers) return null
  const clean = wireModel(model)
  for (const p of Object.values(cfg.providers)) {
    if (clean.toLowerCase() === wireModel(p.model).toLowerCase()) return p.name
    if (p.matchRegexes && p.matchRegexes.some((re) => re.test(model) || re.test(clean))) return p.name
  }
  return null
}

// Subscription usage limits come back as 429 with the unified rate-limit status
// "rejected"; the message wording is the fallback signal.
function isUsageLimit(status, headers, bodyText) {
  if (status !== 429) return false
  if (String((headers && headers['anthropic-ratelimit-unified-status']) || '').toLowerCase() === 'rejected') return true
  return /usage limit|limit reached|hit your limit|limit (will )?resets?/i.test(bodyText || '')
}

// `sticky` maps sessionId -> { provider, at }. `onGlm` and `onGemini` are kept in sync for backward compatibility.
function syncLegacyViews(sticky) {
  const onGlm = {}
  const onGemini = {}
  for (const [sid, entry] of Object.entries(sticky)) {
    if (!entry || typeof entry.at !== 'number') continue
    if (entry.provider === 'glm') onGlm[sid] = entry.at
    else if (entry.provider === 'gemini') onGemini[sid] = entry.at
  }
  return { onGlm, onGemini }
}

function emptyState() {
  return { failoverSince: 0, nextClaudeTry: 0, sticky: {}, onGlm: {}, onGemini: {} }
}

function parseState(raw) {
  const s = emptyState()
  if (typeof raw !== 'object' || raw === null) return s
  if (typeof raw.failoverSince === 'number') s.failoverSince = raw.failoverSince
  if (typeof raw.nextClaudeTry === 'number') s.nextClaudeTry = raw.nextClaudeTry

  const sticky = {}
  if (typeof raw.onGlm === 'object' && raw.onGlm !== null) {
    for (const [sid, t] of Object.entries(raw.onGlm)) {
      if (typeof t === 'number') sticky[sid] = { provider: 'glm', at: t }
    }
  }
  if (typeof raw.onGemini === 'object' && raw.onGemini !== null) {
    for (const [sid, t] of Object.entries(raw.onGemini)) {
      if (typeof t === 'number') sticky[sid] = { provider: 'gemini', at: t }
    }
  }
  if (typeof raw.sticky === 'object' && raw.sticky !== null) {
    for (const [sid, v] of Object.entries(raw.sticky)) {
      if (v && typeof v === 'object' && typeof v.provider === 'string' && typeof v.at === 'number') {
        sticky[sid] = { provider: v.provider.toLowerCase(), at: v.at }
      }
    }
  }
  const views = syncLegacyViews(sticky)
  return { failoverSince: s.failoverSince, nextClaudeTry: s.nextClaudeTry, sticky, ...views }
}

const STICKY_TTL_MS = 7 * 24 * 3600e3

function pruneSticky(state, now) {
  const base = parseState(state)
  const sticky = {}
  for (const [sid, entry] of Object.entries(base.sticky)) {
    if (now - entry.at < STICKY_TTL_MS) sticky[sid] = entry
  }
  return { ...base, sticky, ...syncLegacyViews(sticky) }
}

const pruneGlm = pruneSticky

function setSticky(state, sid, provider, now) {
  if (!sid) return state
  const base = parseState(state)
  const sticky = { ...base.sticky }
  if (!provider || provider === 'claude') {
    delete sticky[sid]
  } else {
    sticky[sid] = { provider: provider.toLowerCase(), at: now }
  }
  return { ...base, sticky, ...syncLegacyViews(sticky) }
}

function setSession(state, sid, onGlm, now) {
  if (!sid) return state
  const base = parseState(state)
  if (onGlm) return setSticky(base, sid, 'glm', now)
  if (base.sticky[sid]?.provider === 'glm') return setSticky(base, sid, null, now)
  return base
}

function setGemini(state, sid, on, now) {
  if (!sid) return state
  const base = parseState(state)
  if (on) return setSticky(base, sid, 'gemini', now)
  if (base.sticky[sid]?.provider === 'gemini') return setSticky(base, sid, null, now)
  return base
}

function getSessionProvider(state, cfg, sid) {
  if (!sid) return 'claude'
  const base = parseState(state)
  const p = base.sticky[sid]?.provider
  if (p && cfg?.providers?.[p]) return p
  return 'claude'
}

function routeLabel(providerName, rewrite) {
  const base = providerName === 'glm' ? 'zai' : providerName
  return rewrite ? `${base}-rewrite` : base
}

function parseRoute(route, cfg) {
  if (route === 'claude' || route === 'claude-trial') {
    return { kind: 'claude', trial: route === 'claude-trial', provider: null, rewrite: false }
  }
  const rewrite = route.endsWith('-rewrite')
  const rawName = rewrite ? route.slice(0, -8) : route
  const name = rawName === 'zai' ? 'glm' : rawName
  const provider = cfg?.providers?.[name] || null
  return { kind: 'provider', name, provider, rewrite }
}

function decide(state, cfg, model, sid, now) {
  const byModel = matchProviderByModel(cfg, model)
  if (byModel) return routeLabel(byModel, false)

  const stickyProvider = getSessionProvider(state, cfg, sid)
  if (stickyProvider !== 'claude') return routeLabel(stickyProvider, true)

  if (!cfg.failoverEnabled || !state.failoverSince) return 'claude'
  const fo = cfg.failoverProvider || 'glm'
  return now >= state.nextClaudeTry ? 'claude-trial' : routeLabel(fo, true)
}

function onLimited(state, cfg, now) {
  return { ...state, failoverSince: state.failoverSince || now, nextClaudeTry: now + cfg.probeEveryMs }
}

function onClaudeOk(state) {
  return { ...state, failoverSince: 0, nextClaudeTry: 0 }
}

// Claude Code strips its own suffixes such as [1m] before sending; a rewrite must too.
const wireModel = (model) => String(model || '').replace(/\[[^\]]*\]$/, '')

// z.ai and several gateways hide every other tool when one is named ToolSearch, so drop it and deferred placeholders.
const hiddenOnCustom = (t) => t && (t.name === 'ToolSearch' || t.defer_loading === true)

function stripCache(v) {
  if (Array.isArray(v)) v.forEach(stripCache)
  else if (v && typeof v === 'object') {
    delete v.cache_control
    Object.values(v).forEach(stripCache)
  }
}

function rewriteBody(bodyBuf, opts = {}) {
  const model = opts.model || null
  const noCache = Boolean(opts.stripCacheControl)
  const dropToolSearch = opts.stripToolSearch !== false
  const j = JSON.parse(bodyBuf.toString('utf8'))
  if (noCache) stripCache(j)
  const tools = dropToolSearch && Array.isArray(j.tools) ? j.tools.filter((t) => !hiddenOnCustom(t)) : null
  const dropTools = tools !== null && tools.length !== j.tools.length
  if (!model && !dropTools && !noCache) return bodyBuf
  if (model) j.model = wireModel(model)
  if (dropTools) j.tools = tools
  return Buffer.from(JSON.stringify(j), 'utf8')
}

function forZai(bodyBuf, model, noCache) {
  return rewriteBody(bodyBuf, { model, stripCacheControl: Boolean(noCache), stripToolSearch: true })
}

function upstreamPath(base, reqUrl) {
  return new URL(base).pathname.replace(/\/$/, '') + reqUrl
}

module.exports = {
  PRESETS,
  wireModel,
  resolveToken,
  retryWaitMs,
  parseProvider,
  parseCfg,
  isGlmModel,
  isGeminiModel,
  matchProviderByModel,
  setSticky,
  getSessionProvider,
  setGemini,
  isUsageLimit,
  emptyState,
  parseState,
  pruneSticky,
  pruneGlm,
  decide,
  parseRoute,
  setSession,
  onLimited,
  onClaudeOk,
  rewriteBody,
  forZai,
  upstreamPath,
}
