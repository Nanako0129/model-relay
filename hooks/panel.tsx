// Interactive AbovePrompt panel for model-relay (/provider or /provider panel).
// Pure view function: receives resolved UI elements, snapshot data, and action callbacks.
import type { EngineInterface } from 'claude-code'
import type { PanelData, PanelUi } from '../types'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

export type PanelView = PanelData & PanelUi & { columns: number }

export type PanelActions = {
  switchTo: (target: string) => void
  askClaude: (ask: boolean) => void
  ping: () => void
  probe: () => void
  close: () => void
}

const ACCENT = 'cyan'
const FRAME_CELLS = 4
const cells = (ch: string) => ((ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1)

export function fit(s: string, width: number): string {
  const text = s.replace(/\s+/g, ' ').trim()
  let used = 0
  let out = ''
  for (const ch of text) {
    const w = cells(ch)
    if (used + w > width - 1) return `${out}…`
    used += w
    out += ch
  }
  return out
}

function formatStat(st: { status: number; ms: number } | undefined, lang: 'zh' | 'en'): { text: string; color: string } | null {
  if (!st) return null
  const sec = st.ms >= 1000 ? `${(st.ms / 1000).toFixed(1)}s` : `${st.ms}ms`
  if (st.status >= 200 && st.status < 300) {
    return { text: `200 · ${sec}`, color: 'green' }
  }
  if (st.status === 0) {
    return { text: lang === 'en' ? `offline · ${sec}` : `未連線 · ${sec}`, color: 'red' }
  }
  return { text: `HTTP ${st.status} · ${sec}`, color: 'red' }
}

export function panelTree(ui: Elements, v: PanelView, act: PanelActions) {
  const { Box, Text, Button } = ui
  const inner = Math.max(32, v.columns - FRAME_CELLS)
  const en = v.lang === 'en'

  const foModel = v.providers[v.failoverProvider] ?? v.failoverProvider
  const mins = v.failoverSince ? Math.max(0, Math.round((v.nextClaudeTry - v.now) / 60000)) : 0

  const subtitle = !v.online
    ? (en
        ? (v.direct ? 'Relay offline · Temporarily connected directly to Claude' : 'Relay offline · Auto-restarting every 10s…')
        : (v.direct ? '轉發站離線・主線暫時直連 Claude' : '轉發站離線・每 10 秒自動重啟中…'))
    : v.failoverSince
      ? (en
          ? `Claude 429 limit active · Failover → ${v.failoverProvider} (${foModel}) · Retry in ~${mins}m`
          : `Claude 429 額度冷卻中・自動備援 → ${v.failoverProvider} (${foModel})・約 ${mins} 分鐘後重試`)
      : (en
          ? `Subagent (haiku) & 429 Failover → ${v.failoverProvider} (${foModel}) · Pinned chats: ${v.sessionsOnCustom}`
          : `子代理 (haiku) 與 429 備援 → ${v.failoverProvider} (${foModel})・固定中對話：${v.sessionsOnCustom}`)

  const isClaudeActive = v.session === 'claude'
  const claudeRow = (
    <Box key="route:claude">
      <Box flexGrow={1}>
        <Text>
          <Text color={isClaudeActive ? 'green' : 'gray'} bold>
            {isClaudeActive ? (en ? '● Active ' : '● 使用中') : (en ? '○ Ready  ' : '○ 待命  ')}
          </Text>{' '}
          <Text bold={isClaudeActive}>claude</Text>{' '}
          <Text dimColor>
            {en ? '· Anthropic Claude (main subscription / OAuth)' : '· Anthropic Claude（預設主線）'}
          </Text>
        </Text>
      </Box>
      {isClaudeActive
        ? <Text dimColor>{en ? 'Current' : '目前路由'}</Text>
        : v.confirmingClaude
          ? [
              <Button
                key="confirm-claude"
                label={en ? 'Confirm (rebuilds cache)' : '確定切回（重建快取）'}
                variant="primary"
                onPress={() => act.switchTo('claude')}
              />,
              <Button
                key="cancel-claude"
                label={en ? 'Cancel' : '取消'}
                onPress={() => act.askClaude(false)}
              />,
            ]
          : (
            <Button
              key="btn:claude"
              label={en ? 'Switch [1]' : '切換 [1]'}
              hotkey="1"
              onPress={() => act.askClaude(true)}
            />
          )}
    </Box>
  )

  const providerEntries = Object.entries(v.providers)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Box>
        <Box flexGrow={1}>
          <Text color={ACCENT} bold>model-relay</Text>
          <Text dimColor>
            {en ? ` · Model Router & 429 Failover (127.0.0.1:${v.port})` : `・模型路由與自動備援 (127.0.0.1:${v.port})`}
          </Text>
        </Box>
        <Button
          key="ping"
          label={v.pinging ? (en ? 'Pinging…' : '測速中…') : (en ? 'Ping [p]' : '測速 [p]')}
          hotkey="p"
          onPress={act.ping}
        />
        {v.failoverSince > 0
          ? (
            <Button
              key="probe"
              label={en ? 'Retry Claude [r]' : '重試 Claude [r]'}
              hotkey="r"
              onPress={act.probe}
            />
          )
          : null}
        <Button
          key="close"
          label={en ? 'Close' : '關閉'}
          role="dismiss"
          dimColor
          onPress={act.close}
        />
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{fit(subtitle, inner)}</Text>
      </Box>

      {v.note ? (
        <Box marginBottom={1}>
          <Text color="yellow">{fit(v.note, inner)}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        {claudeRow}
        {providerEntries.map(([name, model], idx) => {
          const active = v.session === name
          const isFo = name === v.failoverProvider
          const st = formatStat(v.stats[name], v.lang)
          const hk = String(idx + 2)
          return (
            <Box key={`route:${name}`}>
              <Box flexGrow={1}>
                <Text>
                  <Text color={active ? 'green' : 'gray'} bold>
                    {active ? (en ? '● Pinned ' : '● 固定中') : (en ? '○ Ready  ' : '○ 待命  ')}
                  </Text>{' '}
                  <Text bold={active}>{name.padEnd(8)}</Text>{' '}
                  <Text color={active ? ACCENT : undefined}>{model}</Text>
                  {isFo ? <Text color="magenta">{en ? ' [429 failover]' : ' [預設 429 備援]'}</Text> : null}
                  {st ? <Text color={st.color}>{` · ${st.text}`}</Text> : null}
                </Text>
              </Box>
              {active
                ? <Text dimColor>{en ? 'Pinned' : '目前固定'}</Text>
                : (
                  <Button
                    key={`btn:${name}`}
                    label={en ? `Use [${hk}]` : `切換 [${hk}]`}
                    hotkey={hk}
                    variant="primary"
                    onPress={() => act.switchTo(name)}
                  />
                )}
            </Box>
          )
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {fit(
            en
              ? 'Tip: Click a button or press ctrl+x tab then 1-9 / p · Sticky sessions stay on backup provider to preserve prompt cache'
              : '提示：直接點按鈕，或按 ctrl+x tab 後按數字鍵 1–9 / p 測速・固定對話不會自動切回 Claude 以免重建長快取',
            inner,
          )}
        </Text>
      </Box>
    </Box>
  )
}
