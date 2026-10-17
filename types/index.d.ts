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
  stats: Record<string, ProviderStat>
  lang: 'zh' | 'en'
  now: number
}

export type PanelUi = {
  open: boolean
  confirmingClaude: boolean
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
