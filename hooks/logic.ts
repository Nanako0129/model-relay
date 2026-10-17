export interface RelayCfg {
  providers: Record<string, string> // provider name -> model id
  failoverProvider: string
  model: string // primary failover model (for backward compatibility)
  gemini: string | null // optional gemini model (for backward compatibility)
  port: number
  nodePath: string
}

export type AgentCfg = RelayCfg

const PRESET_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  zai: { baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3[1m]' },
  glm: { baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3[1m]' },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat' },
  kimi: { baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k2' },
  minimax: { baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M1' },
  openrouter: { baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-4' },
  gemini: { baseUrl: 'http://127.0.0.1:3425', model: 'gemini-4-argon' },
  magpie: { baseUrl: 'http://127.0.0.1:3425', model: 'gemini-4-argon' },
}

export function parseCfg(raw: unknown): RelayCfg | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)

  const providers: Record<string, string> = {}

  if (typeof r.providers === 'object' && r.providers !== null) {
    for (const [k, v] of Object.entries(r.providers as Record<string, unknown>)) {
      const key = k.trim().toLowerCase()
      if (!key || key === 'claude' || typeof v !== 'object' || v === null) continue
      const pv = v as Record<string, unknown>
      const presetKey = (str(pv.preset) ?? key).toLowerCase()
      const preset = PRESET_DEFAULTS[presetKey]
      const url = str(pv.baseUrl ?? pv.url ?? preset?.baseUrl)
      const token = str(pv.token)
      const model = str(pv.model ?? preset?.model)
      if (url && /^https?:\/\//.test(url) && token && model) {
        providers[key] = model
      }
    }
  }

  // Legacy top-level compatibility
  if (!providers.glm) {
    const baseUrl = str(r.baseUrl)
    const token = str(r.token)
    const model = str(r.model)
    if (baseUrl && /^https?:\/\//.test(baseUrl) && token && model) {
      providers.glm = model
    }
  }
  if (!providers.gemini && typeof r.gemini === 'object' && r.gemini !== null) {
    const gm = str((r.gemini as Record<string, unknown>).model)
    if (gm) providers.gemini = gm
  }

  const names = Object.keys(providers)
  if (names.length === 0) return null

  const foObj = typeof r.failover === 'object' && r.failover !== null ? (r.failover as Record<string, unknown>) : null
  const preferredFo = str(foObj?.provider ?? r.failoverProvider)?.toLowerCase()
  const failoverProvider = preferredFo && providers[preferredFo] ? preferredFo : (providers.glm ? 'glm' : names[0]!)
  const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port > 1024 && r.port < 65536 ? r.port : 8950

  return {
    providers,
    failoverProvider,
    model: providers[failoverProvider]!,
    gemini: providers.gemini ?? null,
    port,
    nodePath: str(r.nodePath) ?? 'node',
  }
}

// ---- local router ----

export function curlBin(isWin = true): string {
  return isWin ? 'C:/Windows/System32/curl.exe' : 'curl'
}

export const CURL = 'C:/Windows/System32/curl.exe'

export const routerUrl = (cfg: RelayCfg) => `http://127.0.0.1:${cfg.port}`

const healthUrl = (cfg: RelayCfg, sid: string) => `${routerUrl(cfg)}/__health?sid=${encodeURIComponent(sid)}`

export function healthArgv(cfg: RelayCfg, sid: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '2', healthUrl(cfg, sid)]
}

export function healthWaitArgv(cfg: RelayCfg, sid: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '2', '--retry', '6', '--retry-connrefused', '--retry-delay', '1', healthUrl(cfg, sid)]
}

export function sessionArgv(cfg: RelayCfg, sid: string, on: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '3', '-X', 'POST', '-H', 'content-type: application/json', '-d', JSON.stringify({ sid, on }), `${routerUrl(cfg)}/__session`]
}

export function routerScript(pluginRoot: string): string {
  return pluginRoot.replace(/[\\/]\.claude-plugin[\\/]?$/, '').replace(/\\/g, '/') + '/router/router.js'
}

// Detaches the router process on both Windows and POSIX platforms.
export function startArgv(cfg: RelayCfg, script: string, configDir: string, isWin = true): string[] {
  if (isWin) {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    return [
      'powershell.exe',
      '-NoProfile',
      '-Command',
      `Start-Process -WindowStyle Hidden -FilePath ${q(cfg.nodePath)} -ArgumentList @(${q(`"${script}"`)}, ${q(`"${configDir}"`)})`,
    ]
  }
  const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return ['sh', '-c', `nohup ${shQuote(cfg.nodePath)} ${shQuote(script)} ${shQuote(configDir)} >/dev/null 2>&1 &`]
}

export interface Health {
  session: string // 'claude' or a configured provider key
  failoverSince: number
  nextClaudeTry: number
  providers?: Record<string, string>
  failoverProvider?: string
}

export function parseHealth(stdout: string): Health | null {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>
    if (j.ok !== true) return null
    const num = (v: unknown) => (typeof v === 'number' ? v : 0)
    const session = typeof j.session === 'string' && j.session.length > 0 ? j.session.toLowerCase() : 'claude'
    let providers: Record<string, string> | undefined
    if (typeof j.providers === 'object' && j.providers !== null) {
      const pMap: Record<string, string> = {}
      for (const [k, v] of Object.entries(j.providers as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) pMap[k.toLowerCase()] = v
      }
      if (Object.keys(pMap).length > 0) providers = pMap
    }
    const failoverProvider = typeof j.failoverProvider === 'string' && j.failoverProvider.length > 0
      ? j.failoverProvider.toLowerCase()
      : undefined
    return {
      session,
      failoverSince: num(j.failoverSince),
      nextClaudeTry: num(j.nextClaudeTry),
      ...(providers ? { providers } : {}),
      ...(failoverProvider ? { failoverProvider } : {}),
    }
  } catch {
    return null
  }
}

export function resolveModelsMap(
  modelOrCfg: string | RelayCfg,
  gemini: string | null = null,
  h: Health | null = null,
): { providers: Record<string, string>; failoverProvider: string; failoverModel: string } {
  if (typeof modelOrCfg === 'string') {
    const providers: Record<string, string> = { glm: modelOrCfg }
    if (gemini) providers.gemini = gemini
    return { providers, failoverProvider: 'glm', failoverModel: modelOrCfg }
  }
  const activeProviders = h?.providers && Object.keys(h.providers).length > 0 ? h.providers : modelOrCfg.providers
  const foKey = h?.failoverProvider && activeProviders[h.failoverProvider]
    ? h.failoverProvider
    : modelOrCfg.failoverProvider
  const failoverModel = activeProviders[foKey] ?? modelOrCfg.model
  return { providers: activeProviders, failoverProvider: foKey, failoverModel }
}

export function statusText(h: Health | null, modelOrCfg: string | RelayCfg, direct: boolean, gemini: string | null = null, lang: 'zh' | 'en' = 'zh'): string {
  const { providers, failoverModel } = resolveModelsMap(modelOrCfg, gemini, h)
  if (!h) {
    if (lang === 'en') return direct ? 'Relay offline: connected directly to Claude' : 'Relay offline, restarting…'
    return direct ? '轉發站離線：主線暫時直連 Claude，subagent 的 GLM 無法使用' : '轉發站離線，正在重啟…'
  }
  if (h.session !== 'claude' && providers[h.session]) {
    const m = providers[h.session]!
    return lang === 'en' ? `Main: ${m} (pinned for this session)` : `主線：${m}（這個對話固定用它）`
  }
  if (h.failoverSince) {
    return lang === 'en' ? `Claude limit reached: routing to ${failoverModel}` : `Claude 額度用完：下一個請求起改用 ${failoverModel}`
  }
  return lang === 'en' ? 'Main: Claude' : '主線：Claude'
}

export function providerReport(h: Health | null, modelOrCfg: string | RelayCfg, now: number, gemini: string | null = null, lang: 'zh' | 'en' = 'zh'): string {
  const { providers, failoverProvider, failoverModel } = resolveModelsMap(modelOrCfg, gemini, h)
  if (!h) {
    return lang === 'en'
      ? 'Relay is not responding; auto-restarting every 10s.'
      : '轉發站沒有回應；每 10 秒會自動重啟，稍後再試。'
  }
  let head = statusText(h, modelOrCfg, false, gemini, lang)
  if (h.failoverSince) {
    const mins = Math.max(0, Math.round((h.nextClaudeTry - now) / 60000))
    head += lang === 'en'
      ? ` (retrying Claude in ~${mins}m; only new sessions switch back)`
      : `（約 ${mins} 分鐘後再試 Claude，恢復後只有新對話回到 Claude）`
  }
  const activeSession = h.session || 'claude'
  const claudeMark = activeSession === 'claude' ? '●' : '○'
  const lines: string[] = [
    head,
    lang === 'en'
      ? `Subagent (haiku) & 429 Failover -> ${failoverProvider} (${failoverModel})`
      : `子代理（haiku）與 429 備援 → ${failoverProvider} (${failoverModel})`,
    '',
    lang === 'en' ? 'Available routes:' : '可用切換指令：',
    lang === 'en'
      ? `  ${claudeMark} /provider claude   Switch back to Claude (rebuilds prompt cache on long chats)`
      : `  ${claudeMark} /provider claude   這個對話切回 Claude（長對話會重建一次快取，很耗額度）`,
  ]
  for (const [k, m] of Object.entries(providers)) {
    const mark = activeSession === k ? '●' : '○'
    const tag = k === failoverProvider ? (lang === 'en' ? ' [failover]' : ' [預設 429 備援]') : ''
    lines.push(
      lang === 'en'
        ? `  ${mark} /provider ${k.padEnd(8)} Pin this session to ${m}${tag}`
        : `  ${mark} /provider ${k.padEnd(8)} 這個對話固定改用 ${m}${tag}`,
    )
  }
  return lines.join('\n')
}
