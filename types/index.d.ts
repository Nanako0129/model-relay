export type ProviderStat = {
  status: number
  ms: number
  at: number
}

export type PanelData = {
  online: boolean
  direct: boolean
  port: number
  session: string // 'claude' or provider name
  failoverProvider: string
  failoverSince: number
  nextClaudeTry: number
  sessionsOnCustom: number
  providers: Record<string, string>
  aliases: Record<string, string>
  failoverChain: string[]
  // The router's own view of its switches; null when it is offline or too old to report them
  switches: { failover: boolean; retry: boolean; proxy: boolean; proxyReady: boolean } | null
  stats: Record<string, ProviderStat>
  lang: 'zh' | 'en'
  now: number
}

export type PanelUi = {
  open: boolean
  confirmingClaude: boolean
  confirmingProxy?: boolean
  pinging: boolean
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-relay': {
      panelUi: PanelUi
      panelData: PanelData | null
    }
  }
}
