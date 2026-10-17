import { test } from 'claude-code/testing'
import {
  buildPanelData,
  healthArgv,
  pingArgv,
  probeArgv,
  sessionArgv,
  parseCfg,
  parseHealth,
  providerReport,
  routerScript,
  routerUrl,
  startArgv,
  statusText,
} from './logic'
import { fit } from './panel'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('assert failed: ' + msg)
}

const base = { baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3[1m]' }

test('parseCfg validates both legacy and multi-provider formats', () => {
  assert(parseCfg(null) === null, 'null rejected')
  assert(parseCfg({ ...base, token: '' }) === null, 'empty token rejected')
  assert(parseCfg({ ...base, baseUrl: 'ftp://x' }) === null, 'non-http rejected')
  const cfg = parseCfg(base)!
  assert(cfg.port === 8950 && cfg.nodePath === 'node' && cfg.providers.glm === 'glm-5.3[1m]', 'defaults')
  assert(parseCfg({ ...base, port: 80 })!.port === 8950, 'privileged port refused')

  const multi = parseCfg({
    port: 8960,
    failover: { provider: 'deepseek' },
    providers: {
      glm: { token: 't' },
      deepseek: { token: 'env:DS_KEY' },
    },
  })!
  assert(multi.failoverProvider === 'deepseek' && multi.providers.deepseek === 'deepseek-chat' && multi.providers.glm === 'glm-5.3[1m]', 'multi-provider with built-in presets parsed')
})

test('router control commands on Windows and POSIX', () => {
  const cfg = parseCfg({ ...base, port: 9001 })!
  assert(routerUrl(cfg) === 'http://127.0.0.1:9001', 'url')
  assert(healthArgv(cfg, 'a b').at(-1) === 'http://127.0.0.1:9001/__health?sid=a%20b', 'health carries the session')
  const m = sessionArgv(cfg, 's1', 'glm')
  assert(m.includes('{"sid":"s1","on":"glm"}') && m.at(-1) === 'http://127.0.0.1:9001/__session', 'per-session switch')
  assert(pingArgv(cfg, 'glm').at(-1) === 'http://127.0.0.1:9001/__ping', 'ping endpoint')
  assert(probeArgv(cfg).at(-1) === 'http://127.0.0.1:9001/__probe', 'probe endpoint')
  assert(routerScript('C:\\x\\claude-relay') === 'C:/x/claude-relay/router/router.js', 'script from root')
  assert(routerScript('C:/x/claude-relay/.claude-plugin') === 'C:/x/claude-relay/router/router.js', 'script from manifest dir')
  const sWin = startArgv({ ...cfg, nodePath: 'C:/n o/node.exe' }, 'C:/r.js', "C:/it's", true)
  assert(sWin[0] === 'powershell.exe' && (sWin[3] ?? '').includes("'C:/n o/node.exe'") && (sWin[3] ?? '').includes("it''s"), 'quoted start win')
  const sPosix = startArgv({ ...cfg, nodePath: '/usr/local/bin/node' }, '/opt/r.js', '/home/u/.claude', false)
  assert(sPosix[0] === 'sh' && (sPosix[2] ?? '').includes('nohup'), 'posix nohup start')
})

test('health, panel data, and status texts (zh and en)', () => {
  assert(parseHealth('nope') === null && parseHealth('{"ok":false}') === null, 'bad health')
  const h = parseHealth('{"ok":true,"session":"claude","failoverSince":5,"nextClaudeTry":600005,"sessionsOnCustom":3,"stats":{"glm":{"status":200,"ms":1200,"at":10}}}')!
  assert(h.session === 'claude' && h.failoverSince === 5 && h.sessionsOnCustom === 3 && h.stats?.glm?.ms === 1200, 'parsed with stats')
  assert(statusText(h, 'glm', false).includes('額度用完'), 'failover status')
  assert(statusText({ ...h, failoverSince: 0 }, 'glm', false) === '主線：Claude', 'normal')
  assert(statusText({ ...h, session: 'glm', failoverSince: 0 }, 'glm', false).includes('固定'), 'sticky session')
  assert(statusText({ ...h, session: 'glm', failoverSince: 0 }, 'glm', false, null, 'en').includes('pinned'), 'sticky session en')
  assert(parseHealth('{"ok":true,"mode":"glm"}')!.session === 'claude', 'old router answer reads as claude')
  assert(statusText(null, 'glm', true).includes('直連'), 'router down, direct')
  const rep = providerReport(h, 'glm', 5)
  assert(rep.includes('10 分鐘後') && rep.includes('● /provider claude') && rep.includes('○ /provider glm') && rep.includes('200 · 1200ms'), 'structured provider report with latency')
  const cfg = parseCfg(base)!
  const pd = buildPanelData(h, cfg, false, 'zh', 5)
  assert(pd.online && pd.sessionsOnCustom === 3 && pd.stats.glm?.status === 200, 'panel snapshot built')
  assert(fit('1234567890', 6) === '12345…', 'fit truncates long text')
})
