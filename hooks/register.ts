import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { PanelUi } from '../types'
import {
  buildPanelData,
  healthArgv,
  healthWaitArgv,
  parseCfg,
  parseHealth,
  pingArgv,
  probeArgv,
  providerReport,
  routerScript,
  routerUrl,
  sessionArgv,
  startArgv,
  statusText,
  type RelayCfg,
  type Health,
} from './logic'
import { panelTree, type PanelActions } from './panel'

const panelUi = atom(
  { plugin: 'model-relay', key: 'panelUi' } as const,
  { open: false, confirmingClaude: false, pinging: false } satisfies PanelUi,
)
const panelData = atom({ plugin: 'model-relay', key: 'panelData' } as const, null)

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

async function syncPanelData($: EngineInterface, cfg: RelayCfg, h: Health | null, lang: 'zh' | 'en'): Promise<void> {
  try {
    const ui = await read($, panelUi)
    if (!ui.open) return
    const snap = buildPanelData(h, cfg, direct, lang, Date.now())
    await update($, panelData, () => snap)
  } catch {}
}

async function setPanelNote($: EngineInterface, note: string | undefined): Promise<void> {
  try {
    await update($, panelUi, ({ confirmingClaude: _c, note: _n, ...u }) => (note ? { ...u, confirmingClaude: false, note } : { ...u, confirmingClaude: false }))
  } catch {}
}

// Keeps the router alive; when it cannot be brought back, this session talks to
// Anthropic directly until the router answers again.
async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = false
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
      await syncPanelData($, cfg, h, lang)
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
        await syncPanelData($, cfg, h2, lang)
        return
      }
    }
    if (!direct && (await $.env.get('ANTHROPIC_BASE_URL')) === routerUrl(cfg)) {
      direct = true
      await $.env.set('ANTHROPIC_BASE_URL', undefined)
    }
    await showStatus($, statusText(null, cfg, direct, null, lang))
    await syncPanelData($, cfg, null, lang)
  } finally {
    ticking = false
  }
}

function panelActions($: EngineInterface): PanelActions {
  const run = (work: () => Promise<string | undefined>) => {
    void work()
      .catch((err) => String(err))
      .then(async (note) => {
        const cfg = await readCfg($)
        if (cfg) {
          const lang = await detectLang($)
          const h = await health($, cfg)
          if (h) await showStatus($, statusText(h, cfg, false, null, lang))
          await syncPanelData($, cfg, h, lang)
        }
        await setPanelNote($, note)
      })
  }
  return {
    switchTo: (target) =>
      run(async () => {
        const cfg = await readCfg($)
        const lang = await detectLang($)
        if (!cfg) return lang === 'en' ? 'Config missing.' : '設定檔不存在。'
        const win = await isWindows($)
        const r = await $.process.run(sessionArgv(cfg, await $.session.id(), target, win), { timeoutMs: 8000 }).catch(() => null)
        if (!r || r.exitCode !== 0 || !r.stdout.includes('"ok":true')) {
          return lang === 'en' ? 'Relay did not respond.' : '轉發站沒有回應。'
        }
        const h = await health($, cfg)
        const active = h?.providers ?? cfg.providers
        if (target === 'claude') {
          return lang === 'en'
            ? 'Switched this session back to Claude (next turn rebuilds cache).'
            : '已切回 Claude（下一輪會重建整段快取）。'
        }
        return lang === 'en'
          ? `Pinned this session to ${active[target] ?? target} (other windows unaffected).`
          : `這個對話已固定改用 ${active[target] ?? target}（其他視窗不受影響）。`
      }),
    askClaude: (ask) => {
      void update($, panelUi, ({ note: _n, ...u }) => ({ ...u, confirmingClaude: ask }))
    },
    ping: () =>
      run(async () => {
        const ui = await read($, panelUi)
        if (ui.pinging) return undefined
        const cfg = await readCfg($)
        const lang = await detectLang($)
        if (!cfg) return undefined
        await update($, panelUi, (u) => ({ ...u, pinging: true }))
        try {
          const win = await isWindows($)
          const r = await $.process.run(pingArgv(cfg, '', win), { timeoutMs: 12000 }).catch(() => null)
          if (!r || r.exitCode !== 0) {
            return lang === 'en' ? 'Ping failed: relay unreachable.' : '測速失敗：轉發站未回應。'
          }
          return lang === 'en' ? 'Upstream latency updated.' : '已完成上游連線測速。'
        } finally {
          await update($, panelUi, (u) => ({ ...u, pinging: false }))
        }
      }),
    probe: () =>
      run(async () => {
        const cfg = await readCfg($)
        const lang = await detectLang($)
        if (!cfg) return undefined
        const win = await isWindows($)
        await $.process.run(probeArgv(cfg, win), { timeoutMs: 5000 }).catch(() => null)
        return lang === 'en' ? 'Cooldown reset; next new session will try Claude.' : '已重置冷卻計時，下一個新對話將嘗試使用 Claude。'
      }),
    close: () => {
      void update($, panelUi, (u) => ({ ...u, open: false, confirmingClaude: false }))
    },
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const cfg = await readCfg($)
    const keys = cfg ? Object.keys(cfg.providers) : ['glm', 'gemini']
    await $.command.register({
      name: 'provider',
      description: '切換這個對話的模型路由或開關互動控制面板（Claude / 自訂 Provider）',
      argumentHint: `[${[...keys, 'claude', 'panel', 'ping'].join('|')}]`,
    })
    await tick($)
    $.clock.every(10000, () => {
      void tick($).catch(() => {})
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const ui = await read($, panelUi)
      const data = ui.open && !e.props.hasSurvey ? await read($, panelData) : null
      return data
        ? panelTree($.ui.resolve(e), { ...data, ...ui, columns: e.props.bodyColumns }, panelActions($))
        : next(e)
    } catch {
      return next(e)
    }
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

    if (arg === 'panel') {
      const nextOpen = !(await read($, panelUi)).open
      const h = await health($, cfg)
      if (nextOpen) {
        await update($, panelData, () => buildPanelData(h, cfg, direct, lang, Date.now()))
      }
      await update($, panelUi, (u) => ({ ...u, open: nextOpen, confirmingClaude: false }))
      return {
        text: nextOpen
          ? (lang === 'en'
              ? 'model-relay panel opened above prompt (click buttons or press ctrl+x tab; run /provider panel again to close).'
              : '已在輸入框上方開啟 model-relay 控制面板：直接點按鈕，或按 ctrl+x tab 用鍵盤操作；再打一次 /provider panel 關閉。')
          : (lang === 'en' ? 'model-relay panel closed.' : '已關閉 model-relay 控制面板。'),
      }
    }

    if (arg === 'ping') {
      await $.process.run(pingArgv(cfg, '', win), { timeoutMs: 12000 }).catch(() => null)
      const h = await health($, cfg)
      await syncPanelData($, cfg, h, lang)
      return { text: providerReport(h, cfg, Date.now(), null, lang) }
    }

    if (arg === 'probe') {
      await $.process.run(probeArgv(cfg, win), { timeoutMs: 5000 }).catch(() => null)
      const h = await health($, cfg)
      await syncPanelData($, cfg, h, lang)
      return {
        text: (lang === 'en' ? 'Reset 429 cooldown timer.\n\n' : '已重置 429 冷卻計時。\n\n') + providerReport(h, cfg, Date.now(), null, lang),
      }
    }

    const h0 = await health($, cfg)
    const activeProviders = h0?.providers && Object.keys(h0.providers).length > 0 ? h0.providers : cfg.providers
    if (arg === 'claude' || activeProviders[arg]) {
      const r = await $.process.run(sessionArgv(cfg, await $.session.id(), arg, win), { timeoutMs: 8000 }).catch(() => null)
      if (!r || r.exitCode !== 0 || !r.stdout.includes('"ok":true')) {
        return { text: lang === 'en' ? 'Relay did not respond; no change.' : '轉發站沒有回應，沒有改變。' }
      }
      const h = await health($, cfg)
      if (h) await showStatus($, statusText(h, cfg, false, null, lang))
      await syncPanelData($, cfg, h, lang)
      const done = arg === 'claude'
        ? (lang === 'en' ? 'Switched this session back to Claude; next request will rebuild cache.' : '這個對話切回 Claude；下一個請求會重建整段快取。')
        : (lang === 'en' ? `Pinned this session to ${activeProviders[arg]}. ` : `這個對話之後都用 ${activeProviders[arg]}。`)
      const otherNote = lang === 'en' ? 'Other sessions are unaffected.\n\n' : '其他對話不受影響。\n\n'
      return { text: `${done}${otherNote}${providerReport(h, cfg, Date.now(), null, lang)}` }
    }
    if (arg !== '' && arg !== 'status') {
      const opts = [...Object.keys(activeProviders), 'claude', 'panel', 'ping'].map((k) => `/provider ${k}`).join('、')
      return { text: lang === 'en' ? `Usage: /provider (status & panel), ${opts}` : `用法：/provider（看狀態並開啟面板）、${opts}` }
    }
    // Bare `/provider` opens the interactive panel above prompt AND returns the status summary
    if (arg === '') {
      await update($, panelData, () => buildPanelData(h0, cfg, direct, lang, Date.now()))
      await update($, panelUi, (u) => ({ ...u, open: true, confirmingClaude: false }))
    }
    return { text: providerReport(h0, cfg, Date.now(), null, lang) }
  }).catch(() => ({ text: '/provider 執行失敗，設定未變更。' }))
}
