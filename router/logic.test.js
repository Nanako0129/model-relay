'use strict'
const test = require('node:test')
const assert = require('node:assert')
const L = require('./logic')

const cfg = L.parseCfg({ baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3[1m]' })
const OPUS = 'claude-opus-5-5'

test('config defaults and legacy compatibility', () => {
  assert.strictEqual(L.parseCfg({ baseUrl: 'ftp://x', token: 't', model: 'm' }), null)
  assert.strictEqual(cfg.port, 8950)
  assert.strictEqual(cfg.claudeUrl, 'https://api.anthropic.com')
  assert.strictEqual(cfg.probeEveryMs, 600000)
  assert.strictEqual(cfg.failoverProvider, 'glm')
  assert.ok(cfg.providers.glm)
})

test('multi-provider config and env:VAR token resolution', () => {
  const multi = L.parseCfg({
    port: 8955,
    failover: { enabled: true, provider: 'deepseek', probeEveryMin: 5 },
    providers: {
      glm: { token: 'env:' + 'T_VAR' }, // uses built-in glm preset
      deepseek: { token: 'ds' }, // uses built-in deepseek preset
      gemini: { token: 'gw', launch: { command: 'magpie', args: ['web'] } }, // uses built-in gemini preset
    },
  }, { T_VAR: 'resolved-val' })

  assert.strictEqual(multi.port, 8955)
  assert.strictEqual(multi.failoverProvider, 'deepseek')
  assert.strictEqual(multi.probeEveryMs, 300000)
  assert.strictEqual(multi.providers.glm.token, 'resolved-val')
  assert.strictEqual(multi.providers.gemini.stripCacheControl, true)
  assert.strictEqual(multi.providers.gemini.authHeader, 'both')
  assert.deepStrictEqual(multi.providers.gemini.launch, { command: 'magpie', args: ['web'] })

  // Model matching routes directly to the matching provider
  assert.strictEqual(L.decide(L.emptyState(), multi, 'deepseek-reasoner', 's1', 0), 'deepseek')
  assert.strictEqual(L.decide(L.emptyState(), multi, 'glm-5.3', 's1', 0), 'zai')
  assert.strictEqual(L.decide(L.emptyState(), multi, 'gemini-4-argon', 's1', 0), 'gemini')

  // Sticky session on custom provider
  const s = L.setSticky(L.emptyState(), 's1', 'deepseek', 100)
  assert.strictEqual(L.decide(s, multi, OPUS, 's1', 200), 'deepseek-rewrite')
})

test('glm models always go to the custom endpoint', () => {
  assert.strictEqual(L.decide(L.emptyState(), cfg, 'glm-5.3', 'a', 0), 'zai')
})

test('failover: new sessions trial Claude when due, otherwise failover provider', () => {
  const s = L.emptyState()
  assert.strictEqual(L.decide(s, cfg, OPUS, 'a', 0), 'claude')
  const limited = L.onLimited(s, cfg, 1000)
  assert.strictEqual(L.decide(limited, cfg, OPUS, 'a', 1000 + 599999), 'zai-rewrite')
  assert.strictEqual(L.decide(limited, cfg, OPUS, 'a', 1000 + 600000), 'claude-trial')
  assert.strictEqual(L.decide(limited, { ...cfg, failoverEnabled: false }, OPUS, 'a', 1000), 'claude')
  const again = L.onLimited(limited, cfg, 700000)
  assert.strictEqual(again.failoverSince, 1000, 'episode start kept')
  assert.strictEqual(L.onClaudeOk(again).failoverSince, 0)
})

test('a session that moved to GLM stays there after Claude recovers', () => {
  let s = L.onLimited(L.emptyState(), cfg, 1000)
  s = L.setSession(s, 'long', true, 1000)
  s = L.onClaudeOk(s)
  assert.strictEqual(L.decide(s, cfg, OPUS, 'long', 5e6), 'zai-rewrite', 'sticky session keeps GLM')
  assert.strictEqual(L.decide(s, cfg, OPUS, 'fresh', 5e6), 'claude', 'other sessions back on Claude')
  assert.strictEqual(L.decide(s, cfg, OPUS, undefined, 5e6), 'claude', 'no session id: no stickiness')
  s = L.setSession(s, 'long', false, 6e6)
  assert.strictEqual(L.decide(s, cfg, OPUS, 'long', 6e6), 'claude', 'released session returns')
  assert.deepStrictEqual(L.setSession(s, '', true, 1), s, 'empty id ignored')
})

test('sticky sessions expire after a week', () => {
  const s = L.setSession(L.setSession(L.emptyState(), 'old', true, 0), 'new', true, 8 * 24 * 3600e3)
  assert.deepStrictEqual(Object.keys(L.pruneGlm(s, 8 * 24 * 3600e3).onGlm), ['new'])
})

test('only a usage-limit 429 triggers failover', () => {
  assert.ok(L.isUsageLimit(429, { 'anthropic-ratelimit-unified-status': 'rejected' }, '{}'))
  assert.ok(L.isUsageLimit(429, {}, '{"error":{"message":"You have hit your usage limit"}}'))
  assert.ok(!L.isUsageLimit(429, {}, '{"error":{"message":"Too many requests"}}'))
  assert.ok(!L.isUsageLimit(500, { 'anthropic-ratelimit-unified-status': 'rejected' }, 'usage limit'))
})

test('model rewrite and upstream path', () => {
  const out = JSON.parse(L.forZai(Buffer.from('{"model":"claude-opus-5-5","x":1}'), 'glm-5.3[1m]').toString())
  assert.deepStrictEqual(out, { model: 'glm-5.3', x: 1 })
  const plain = Buffer.from('{"model":"glm-5.3","tools":[{"name":"Read"}]}')
  assert.strictEqual(L.forZai(plain, null), plain)
  assert.strictEqual(L.upstreamPath('https://api.z.ai/api/anthropic', '/v1/messages?beta=true'), '/api/anthropic/v1/messages?beta=true')
  assert.strictEqual(L.upstreamPath('https://api.anthropic.com', '/v1/messages'), '/v1/messages')
})

test('z.ai requests lose ToolSearch and deferred placeholders', () => {
  const tools = [{ name: 'Read' }, { name: 'ToolSearch' }, { name: 'DeferredToolPlaceholder', defer_loading: true }, { name: 'Bash' }]
  const body = Buffer.from(JSON.stringify({ model: 'glm-5.3', tools }))
  assert.deepStrictEqual(JSON.parse(L.forZai(body, null).toString()).tools, [{ name: 'Read' }, { name: 'Bash' }])
  const rw = JSON.parse(L.forZai(body, 'glm-5.3[1m]').toString())
  assert.strictEqual(rw.model, 'glm-5.3')
  assert.deepStrictEqual(rw.tools.map((t) => t.name), ['Read', 'Bash'])
})

test('state parsing tolerates junk and old files', () => {
  assert.deepStrictEqual(L.parseState(null), L.emptyState())
  const old = L.parseState({ mode: 'glm', failoverSince: 5, onGlm: { a: 1, b: 'x' } })
  assert.strictEqual(old.failoverSince, 5)
  assert.deepStrictEqual(old.onGlm, { a: 1 })
  assert.strictEqual(old.sticky.a.provider, 'glm')
  assert.ok(!('mode' in old), 'global mode no longer exists')
})

test('gemini route: model name or sticky session, off without config', () => {
  const g = L.parseCfg({ baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3[1m]', gemini: { baseUrl: 'https://x', token: 'k', model: 'gemini-4-argon-lb' } })
  assert.strictEqual(L.decide(L.emptyState(), g, 'gemini-4-argon-lb', 'a', 0), 'gemini')
  let s = L.setGemini(L.setSession(L.emptyState(), 'a', true, 1), 'a', true, 2)
  assert.strictEqual(s.onGlm.a, undefined, 'leaves GLM')
  assert.strictEqual(L.decide(s, g, OPUS, 'a', 3), 'gemini-rewrite')
  assert.strictEqual(L.decide(s, cfg, OPUS, 'a', 3), 'claude', 'no gemini config: ignored')
  s = L.setGemini(s, 'a', false, 4)
  assert.strictEqual(L.decide(s, g, OPUS, 'a', 5), 'claude')
})

test('gemini requests lose cache_control everywhere', () => {
  const b = Buffer.from(JSON.stringify({ model: 'm', system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'y', cache_control: { type: 'ephemeral' } }] }] }))
  assert.ok(!L.forZai(b, null, true).toString().includes('cache_control'))
  assert.ok(L.forZai(b, null, false).toString().includes('cache_control'))
})
