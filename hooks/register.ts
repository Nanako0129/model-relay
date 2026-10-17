import type { EngineInterface, Register } from 'claude-code'
import {
  healthArgv,
  healthWaitArgv,
  parseCfg,
  parseHealth,
  providerReport,
  routerScript,
  routerUrl,
  sessionArgv,
  startArgv,
  statusText,
  type RelayCfg,
  type Health,
} from './logic'

let ticking = false
let shownStatus = ''
let lastStart = 0
let direct = false // this session bypasses a dead router and talks to Anthropic itself

async function isWindows($: EngineInterface): Promise<boolean> {
  const os = await $.env.get('OS')
  const up = await $.env.get('USERPROFILE')
  return Boolean((os && /windows/i.test(os)) || up)
}

async function detectLang($: EngineInterface): Promise<'zh' | 'en'> {
  try {
    const s = await $.settings.read()
    const lang = String((s as Record<string, unknown>)?.language ?? '')
    if (/zh|繁體|中文|traditional/i.test(lang)) return 'zh'
    if (/en|english/i.test(lang)) return 'en'
  } catch {}
  return 'zh'
}

async function configDir($: EngineInterface): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return (dir || `${home}/.claude`).replace(/\\/g, '/')
}

async function readCfg($: EngineInterface): Promise<RelayCfg | null> {
  const base = await configDir($)
  for (const name of ['model-relay.json', 'custom-agent.json']) {
    try {
      const parsed = parseCfg(JSON.parse(await $.fs.read(`${base}/${name}`)))
      if (parsed) return parsed
    } catch {}
  }
  return null
}

async function health($: EngineInterface, cfg: RelayCfg): Promise<Health | null> {
  try {
    const win = await isWindows($)
    const r = await $.process.run(healthArgv(cfg, await $.session.id(), win), { timeoutMs: 5000 })
    return r.exitCode === 0 ? parseHealth(r.stdout) : null
  } catch {
    return null
  }
}

async function showStatus($: EngineInterface, text: string): Promise<void> {
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

// Keeps the router alive; when it cannot be brought back, this session talks to
// Anthropic directly until the router answers again.
async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const cfg = await readCfg($)
    if (!cfg) return
    const lang = await detectLang($)
    const h = await health($, cfg)
    if (h) {
      if (direct) {
        direct = false
        await $.env.set('ANTHROPIC_BASE_URL', routerUrl(cfg))
        $.ui.toast(lang === 'en' ? 'Relay recovered; routing through local relay' : '轉發站恢復，主線重新經由轉發站')
      }
      await showStatus($, statusText(h, cfg, false, null, lang))
      return
    }
    if (Date.now() - lastStart > 15000) {
      lastStart = Date.now()
      const win = await isWindows($)
      await $.process.run(startArgv(cfg, routerScript($.plugin.root), await configDir($), win), { timeoutMs: 15000 }).catch(() => undefined)
      const up = await $.process.run(healthWaitArgv(cfg, await $.session.id(), win), { timeoutMs: 20000 }).catch(() => null)
      const h2 = up && up.exitCode === 0 ? parseHealth(up.stdout) : null
      if (h2) {
        await showStatus($, statusText(h2, cfg, false, null, lang))
        return
      }
    }
    if (!direct && (await $.env.get('ANTHROPIC_BASE_URL')) === routerUrl(cfg)) {
      direct = true
      await $.env.set('ANTHROPIC_BASE_URL', undefined)
    }
    await showStatus($, statusText(null, cfg, direct, null, lang))
  } finally {
    ticking = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const cfg = await readCfg($)
    const keys = cfg ? Object.keys(cfg.providers) : ['glm', 'gemini']
    await $.command.register({
      name: 'provider',
      description: '切換或查看這個對話的模型路由（Claude / 自訂 Provider）',
      argumentHint: `[${[...keys, 'claude'].join('|')}]`,
    })
    await tick($)
    $.clock.every(10000, () => {
      void tick($).catch(() => {})
    })
    return next(e)
  })

  on('command.run', { command: 'provider' }, async ($, e) => {
    const cfg = await readCfg($)
    const lang = await detectLang($)
    if (!cfg) {
      return {
        text: lang === 'en'
          ? 'model-relay.json (or custom-agent.json) is missing or invalid.'
          : 'model-relay.json（或 custom-agent.json）不存在或格式錯誤。',
      }
    }
    const arg = e.args.trim().toLowerCase()
    const win = await isWindows($)
    const h0 = await health($, cfg)
    const activeProviders = h0?.providers && Object.keys(h0.providers).length > 0 ? h0.providers : cfg.providers
    if (arg === 'claude' || activeProviders[arg]) {
      const r = await $.process.run(sessionArgv(cfg, await $.session.id(), arg, win), { timeoutMs: 8000 }).catch(() => null)
      if (!r || r.exitCode !== 0 || !r.stdout.includes('"ok":true')) {
        return { text: lang === 'en' ? 'Relay did not respond; no change.' : '轉發站沒有回應，沒有改變。' }
      }
      const h = await health($, cfg)
      if (h) await showStatus($, statusText(h, cfg, false, null, lang))
      const done = arg === 'claude'
        ? (lang === 'en' ? 'Switched this session back to Claude; next request will rebuild cache.' : '這個對話切回 Claude；下一個請求會重建整段快取。')
        : (lang === 'en' ? `Pinned this session to ${activeProviders[arg]}. ` : `這個對話之後都用 ${activeProviders[arg]}。`)
      const otherNote = lang === 'en' ? 'Other sessions are unaffected.\n\n' : '其他對話不受影響。\n\n'
      return { text: `${done}${otherNote}${providerReport(h, cfg, Date.now(), null, lang)}` }
    }
    if (arg !== '' && arg !== 'status') {
      const opts = [...Object.keys(activeProviders), 'claude'].map((k) => `/provider ${k}`).join('、')
      return { text: lang === 'en' ? `Usage: /provider (status), ${opts}` : `用法：/provider（看狀態）、${opts}` }
    }
    return { text: providerReport(h0, cfg, Date.now(), null, lang) }
  }).catch(() => ({ text: '/provider 執行失敗，設定未變更。' }))
}
