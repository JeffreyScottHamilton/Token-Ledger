// Contract of the claude-token-ledger mod: the summary it reads (SPEC §4) and
// the $.state values its pane draws from.

export type LedgerStatus = 'ok' | 'empty' | 'stale' | 'unavailable'

export type LedgerBreakdown = {
  input?: number
  output?: number
  cacheWrite?: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

export type LedgerSource = {
  label: string
  kind: string
  status: string
  total?: number
  requests?: number
  firstAt?: string
  lastAt?: string
}

export type LedgerGap = {
  source: string
  kind: string
  count?: number
  detail?: string
}

export type LedgerSummary = {
  schema?: number
  status: LedgerStatus
  total?: number
  requests?: number
  breakdown?: LedgerBreakdown
  firstRecordedAt?: string
  updatedAt?: string
  generatedAt?: string
  sources?: LedgerSource[]
  gaps?: LedgerGap[]
  authority?: { scope: string; authoritative: string }[]
}

/** What the "Token Ledger" pane draws: the counter line and the details text. */
export type LedgerView = { counter: string; details: string }

declare module 'claude-code' {
  interface PluginState {
    'token-ledger': { view: Shaped<LedgerView> }
  }
}
