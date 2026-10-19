'use strict'
// Config migration, the failover chain and the retry switch: pure logic plus one end-to-end chain test.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const L = require('./logic')

const OPUS = 'claude-opus-5-5'

// The shape of a config file that grew over time: providers AND the same data again at the top level
const LEGACY = {
  port: 8950,
  nodePath: 'node',
  failover: { enabled: true, provider: 'glm', cooldownMs: 600000 },
  providers: {
    glm: { baseUrl: 'https://api.z.ai/api/anthropic', token: 'tok-glm', model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
    gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'tok-gem', model: 'gemini-4-argon', stripCacheControl: true, authHeader: 'both', retry: { attempts: 0 } },
  },
  baseUrl: 'https://api.z.ai/api/anthropic',
  token: 'tok-glm',
  model: 'glm-5.3[1m]',
  failoverEnabled: true,
  probeEveryMin: 10,
  gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'tok-gem', model: 'gemini-4-argon' },
}

// What the router will actually do with a config, without functions or regex objects, to compare two files
const effective = (raw) => {
  const c = L.parseCfg(raw)
  const providers = Object.fromEntries(Object.entries(c.providers).map(([k, p]) => [k, { ...p, matchRegexes: p.matchRegexes.map(String) }]))
  return { ...c, providers }
}

test('migrating a legacy file changes the layout but not what the router does', () => {
  const { config, notes } = L.migrateConfig(LEGACY)
  assert.deepStrictEqual(effective(config), effective(LEGACY))
  for (const gone of ['baseUrl', 'token', 'model', 'gemini', 'failoverEnabled', 'probeEveryMin']) assert.ok(!(gone in config), gone)
  assert.deepStrictEqual(config.failover, { enabled: true, chain: ['glm'], cooldownMs: 600000 })
  assert.ok(notes.length >= 3)
  assert.strictEqual(config.providers.gemini.token, 'tok-gem', 'secrets are copied through untouched')
})

test('migrating twice changes nothing more, and an already clean file reports no notes', () => {
  const once = L.migrateConfig(LEGACY).config
  const twice = L.migrateConfig(once)
  assert.deepStrictEqual(twice.config, once)
  assert.deepStrictEqual(twice.notes, [])
})

test('the original single-GLM layout still works and migrates into providers.glm', () => {
  const old = { baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3[1m]', gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'g', model: 'gemini-4-argon' } }
  const c = L.parseCfg(old)
  assert.deepStrictEqual(Object.keys(c.providers).sort(), ['gemini', 'glm'])
  assert.strictEqual(c.providers.gemini.stripCacheControl, true, 'the old gemini block keeps its old defaults')
  assert.deepStrictEqual(effective(L.migrateConfig(old).config), effective(old))
  assert.strictEqual(L.parseCfg(null), null)
  assert.strictEqual(L.parseCfg({}), null)
})

test('failover.cooldownMs is honoured (the legacy probeEveryMin still works)', () => {
  const base = { providers: { glm: { baseUrl: 'https://x.example', token: 't', model: 'm' } } }
  assert.strictEqual(L.parseCfg({ ...base, failover: { cooldownMs: 120000 } }).cooldownMs, 120000)
  assert.strictEqual(L.parseCfg({ ...base, failover: { probeEveryMin: 5 } }).cooldownMs, 300000)
  assert.strictEqual(L.parseCfg({ ...base }).cooldownMs, 600000)
  assert.strictEqual(L.parseCfg({ ...base, failover: { cooldownMs: 1 } }).cooldownMs, 60000, 'never hammers Claude faster than once a minute')
})

const two = () => L.parseCfg({
  providers: {
    glm: { baseUrl: 'https://a.example', token: 't', model: 'glm-5.3' },
    gemini: { baseUrl: 'https://b.example', token: 't', model: 'gemini-4' },
    kimi: { baseUrl: 'https://c.example', token: 't', model: 'kimi-k2', fallback: false },
    deepseek: { baseUrl: 'https://d.example', token: 't', model: 'deepseek-chat', fallback: ['gemini', 'nope', 'deepseek'] },
  },
  failover: { chain: ['gemini', 'ghost', 'glm', 'gemini'] },
})

test('the failover chain keeps order, drops unknown names and duplicates, and leads with its first link', () => {
  const c = two()
  assert.deepStrictEqual(c.failoverChain, ['gemini', 'glm'])
  assert.strictEqual(c.failoverProvider, 'gemini')
  assert.deepStrictEqual(L.parseCfg({ providers: { x: { baseUrl: 'https://x.example', token: 't', model: 'm' } }, failover: { chain: ['ghost'] } }).failoverChain, ['x'], 'an empty chain falls back to a configured provider')
})

test('a failing provider hands over to the next link, never back to one already tried', () => {
  const c = two()
  assert.strictEqual(L.nextFallback(c, 'gemini', []).name, 'glm')
  assert.strictEqual(L.nextFallback(c, 'glm', []).name, 'gemini')
  assert.strictEqual(L.nextFallback(c, 'glm', ['gemini']), null, 'everyone has been tried')
  assert.strictEqual(L.nextFallback(c, 'gemini', ['glm']), null)
  assert.strictEqual(L.nextFallback(c, 'kimi', []), null, 'fallback: false means nobody takes over')
  assert.strictEqual(L.nextFallback(c, 'deepseek', []).name, 'gemini', 'its own list wins over the chain; unknown and self are ignored')
  assert.strictEqual(L.nextFallback(c, 'unknown', []).name, 'gemini', 'a provider outside the chain hands to the first link')
})

test('the retry switch turns retrying off everywhere without touching the other settings', () => {
  const raw = { providers: { glm: { baseUrl: 'https://a.example', token: 't', model: 'm', retry: { attempts: 9 } }, b: { baseUrl: 'https://b.example', token: 't', model: 'n' } } }
  assert.strictEqual(L.parseCfg(raw).retry.enabled, true)
  assert.ok(L.parseCfg(raw).providers.glm.retryCfg)
  const off = L.parseCfg({ ...raw, retry: { enabled: false, attempts: 7 } })
  assert.strictEqual(off.retry.enabled, false)
  assert.strictEqual(off.retry.attempts, 7, 'the other retry settings are kept for when it is switched back on')
  assert.strictEqual(off.providers.glm.retryCfg, null)
  assert.strictEqual(off.providers.b.retryCfg, null)
  assert.strictEqual(L.parseCfg({ providers: { glm: { baseUrl: 'https://a.example', token: 't', model: 'm', retry: { enabled: false } } } }).providers.glm.retryCfg, null, 'one provider can opt out')
})

test('decide() follows the first link of the chain while Claude is out', () => {
  const c = two()
  const limited = L.onLimited(L.emptyState(), c, 1000)
  assert.strictEqual(L.decide(limited, c, OPUS, 's', 2000), 'gemini-rewrite')
})

// ---------- end to end: the first link is down, the second answers ----------

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startRouter(t, { chain, retryFailover, fallbackOff = false }) {
  const hits = { first: 0, second: 0, claude: 0 }
  const mk = (key, status) => http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      hits[key] += 1
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ from: key }))
    })
  })
  const first = mk('first', 503)
  const second = mk('second', 200)
  const claude = mk('claude', 429)
  const [p1, p2, pc] = [await listen(first), await listen(second), await listen(claude)]
  const probe = net.createServer()
  const port = await listen(probe)
  await new Promise((r) => probe.close(r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-chain-'))
  const file = path.join(dir, 'model-relay.json')
  fs.writeFileSync(file, JSON.stringify({
    port,
    claudeUrl: `http://127.0.0.1:${pc}`,
    failover: { enabled: true, chain },
    retry: { attempts: 1, delayMs: 10, maxDelayMs: 10, failover: retryFailover },
    providers: {
      one: { baseUrl: `http://127.0.0.1:${p1}`, token: 'a', model: 'one-model', ...(fallbackOff ? { fallback: false } : {}) },
      two: { baseUrl: `http://127.0.0.1:${p2}`, token: 'b', model: 'two-model' },
    },
  }))
  const child = spawn(process.execPath, [path.join(__dirname, 'router.js'), dir], { stdio: 'ignore' })
  t.after(() => {
    child.kill()
    for (const s of [first, second, claude]) s.close()
  })
  for (let i = 0; i < 60; i++) {
    const up = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/__health`, (r) => { r.resume(); resolve(true) }).on('error', () => resolve(false)))
    if (up) break
    await sleep(100)
  }
  return { port, hits, file }
}

function ask(port, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages: [] })
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-length': Buffer.byteLength(body), 'x-claude-code-session-id': 'sid-1' } }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('end to end: a provider that keeps failing hands the request to the next link in the chain', async (t) => {
  const { port, hits } = await startRouter(t, { chain: ['one', 'two'], retryFailover: true })
  const r = await ask(port, 'one-model')
  assert.strictEqual(r.status, 200, r.body)
  assert.strictEqual(JSON.parse(r.body).from, 'second')
  assert.strictEqual(hits.first, 2, 'one try plus one retry before giving up')
  assert.strictEqual(hits.second, 1)
})

test('end to end: without the fallthrough switch the failure is returned as before', async (t) => {
  const { port, hits } = await startRouter(t, { chain: ['one', 'two'], retryFailover: false })
  const r = await ask(port, 'one-model')
  assert.strictEqual(r.status, 503)
  assert.strictEqual(hits.second, 0)
})

test('end to end: fallback: false on a provider keeps the failure with that provider', async (t) => {
  const { port, hits } = await startRouter(t, { chain: ['one', 'two'], retryFailover: true, fallbackOff: true })
  const r = await ask(port, 'one-model')
  assert.strictEqual(r.status, 503)
  assert.strictEqual(hits.second, 0)
})

test('end to end: a config file caught half written does not fail requests', async (t) => {
  const { port, hits, file } = await startRouter(t, { chain: ['one', 'two'], retryFailover: true })
  assert.strictEqual((await ask(port, 'two-model')).status, 200)
  fs.writeFileSync(file, '{"port": 89') // an editor in the middle of saving
  const r = await ask(port, 'two-model')
  assert.strictEqual(r.status, 200, r.body)
  assert.strictEqual(hits.second, 2)
})
