// Claude Token Ledger mod: /token-ledger, a /usage companion line, an opt-in
// status row and collector autostart. Reads summary.json (SPEC §4); never
// throws into the engine and never blocks session start.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerSummary, LedgerView } from '../types'
import { DISCLAIMER, formatCounter, formatDetails } from './format'

type $ = EngineInterface

const PANE = 'token-ledger'
const COMMAND = 'token-ledger'
const DEFAULT_PORT = 47318
const STALE_AFTER_MS = 15 * 60 * 1000
const HEALTH_TIMEOUT_MS = 800
const STATUS_EVERY_MS = 60 * 1000

const view = atom({ plugin: 'token-ledger', key: 'view' } as const, { counter: '', details: '' } as LedgerView, {
  shape: 'view-1',
})

type LedgerConfig = { port?: number; nodePath?: string }
type LastError = { at: string; step: string; message: string }

function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  return m.length > 300 ? m.slice(0, 300) + '…' : m
}

async function ledgerHome($: $): Promise<string> {
  let override: string | undefined
  let home: string | undefined
  let profile: string | undefined
  try { override = await $.env.get('TOKEN_LEDGER_HOME') } catch {}
  if (override) return override
  try { home = await $.env.get('HOME') } catch {}
  try { profile = await $.env.get('USERPROFILE') } catch {}
  return `${home || profile || '.'}/.claude-token-ledger`
}

async function readConfig($: $, home: string): Promise<LedgerConfig> {
  try {
    const parsed = JSON.parse(await $.fs.read(`${home}/config.json`))
    return parsed && typeof parsed === 'object' ? (parsed as LedgerConfig) : {}
  } catch {
    return {}
  }
}

async function now($: $): Promise<number> {
  try { return await $.clock.now() } catch { return Date.now() }
}

/** GET /healthz on the loopback collector, false after 800 ms or on any failure. */
async function collectorHealthy($: $, port: number): Promise<boolean> {
  const probe = $.http
    .fetch(`http://127.0.0.1:${port}/healthz`)
    .then(r => r.ok, () => false)
  const timeout = $.clock.sleep(HEALTH_TIMEOUT_MS).then(() => false, () => false)
  try { return await Promise.race([probe, timeout]) } catch { return false }
}

function isUsableFile(s: unknown): s is LedgerSummary {
  if (!s || typeof s !== 'object') return false
  const o = s as LedgerSummary
  return (
    o.schema === 1 &&
    (o.status === 'ok' || o.status === 'empty' || o.status === 'stale') &&
    typeof o.total === 'number' && Number.isFinite(o.total) && o.total >= 0
  )
}

/** The summary to show, with status derived per SPEC §4. Never rejects. */
async function loadSummary($: $): Promise<LedgerSummary> {
  try {
    const home = await ledgerHome($)
    let file: LedgerSummary | undefined
    try {
      const parsed: unknown = JSON.parse(await $.fs.read(`${home}/summary.json`))
      if (isUsableFile(parsed)) file = parsed
    } catch {}
    if (file) {
      try { await $.store.set('lastSummary', file) } catch {}
      const generated = Date.parse(file.generatedAt ?? '')
      const t = await now($)
      if (file.status !== 'stale' && (!Number.isFinite(generated) || t - generated > STALE_AFTER_MS)) {
        const cfg = await readConfig($, home)
        const port = typeof cfg.port === 'number' ? cfg.port : DEFAULT_PORT
        if (!(await collectorHealthy($, port))) return { ...file, status: 'stale' }
      }
      return file
    }
    let cached: unknown
    try { cached = await $.store.get('lastSummary') } catch {}
    if (isUsableFile(cached)) return { ...cached, status: 'stale' }
  } catch {}
  return { status: 'unavailable' }
}

async function lastErrorLine($: $): Promise<string | undefined> {
  try {
    const e = (await $.store.get('lastError')) as LastError | undefined
    if (e && typeof e === 'object' && e.message) {
      return `Collector autostart: last error at ${e.at} (${e.step}): ${e.message}`
    }
  } catch {}
  return undefined
}

async function buildView($: $): Promise<LedgerView> {
  const summary = await loadSummary($)
  const t = await now($)
  let details = formatDetails(summary, t)
  const err = await lastErrorLine($)
  if (err) {
    // Insert just before the closing disclaimer line.
    const cut = details.lastIndexOf(DISCLAIMER)
    details = cut >= 0 ? `${details.slice(0, cut)}${err}\n${details.slice(cut)}` : `${details}\n${err}`
  }
  return { counter: formatCounter(summary, t), details }
}

async function publish($: $, v: LedgerView): Promise<void> {
  try { await update($, view, () => v) } catch {}
}

async function cliArgv($: $, command: string): Promise<string[]> {
  const home = await ledgerHome($)
  const cfg = await readConfig($, home)
  const node = typeof cfg.nodePath === 'string' && cfg.nodePath ? cfg.nodePath : 'node'
  return [node, `${$.plugin.root}/bin/token-ledger.mjs`, command]
}

async function runCli($: $, command: string, timeoutMs: number) {
  const argv = await cliArgv($, command)
  const env: Record<string, string> = {}
  const override = await $.env.get('TOKEN_LEDGER_HOME').catch(() => undefined)
  if (override) env.TOKEN_LEDGER_HOME = override
  return $.process.run(argv, { timeoutMs, env })
}

async function recordError($: $, step: string, err: unknown): Promise<void> {
  const at = new Date(await now($)).toISOString()
  try { await $.store.set('lastError', { at, step, message: errText(err) } satisfies LastError) } catch {}
}

/** ensure then sync; failures land in $.store.lastError, never thrown. */
async function autostart($: $): Promise<void> {
  for (const [step, timeout] of [['ensure', 15000], ['sync', 120000]] as const) {
    try {
      const r = await runCli($, step, timeout)
      if (r.exitCode !== 0) {
        await recordError($, step, `exit ${r.exitCode}: ${(r.stderr || r.stdout).trim().split('\n').pop() ?? ''}`)
        return
      }
    } catch (err) {
      await recordError($, step, err)
      return
    }
  }
  try { await $.store.delete('lastError') } catch {}
}

export const register: Register = (on, options) => {
  const showStatusRow = options.showStatusRow === true
  let isInteractive = false

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive === true
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Token Ledger: total tracked tokens (details | refresh | pane)',
        argumentHint: '[details|refresh|pane]',
      })
    } catch (err) {
      try { $.ui.log(`could not register /${COMMAND}: ${errText(err)}`, { to: 'debug' }) } catch {}
    }

    // Everything below runs on timers so session start never waits for it.
    try {
      if (!showStatusRow) $.ui.status(undefined)
      $.clock.after(1, () => {
        void (async () => {
          await autostart($)
          const v = await buildView($)
          await publish($, v)
          if (showStatusRow) $.ui.status(v.counter)
        })().catch(() => {})
      })
      if (showStatusRow) {
        $.clock.every(STATUS_EVERY_MS, () => {
          void buildView($)
            .then(v => publish($, v).then(() => $.ui.status(v.counter)))
            .catch(() => {})
        })
      }
    } catch {}

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    try {
      if (arg === '' ) {
        const v = await buildView($)
        await publish($, v)
        return { text: v.counter }
      }
      if (arg === 'details') {
        const v = await buildView($)
        await publish($, v)
        return { text: v.details }
      }
      if (arg === 'refresh') {
        let note: string
        try {
          const r = await runCli($, 'sync', 120000)
          note = r.exitCode === 0
            ? 'Synced.'
            : `token-ledger sync exited ${r.exitCode}. Run \`token-ledger sync\` in a terminal for details.`
        } catch (err) {
          note = `Could not run token-ledger sync here (${errText(err)}). Run \`token-ledger sync\` in a terminal.`
        }
        const v = await buildView($)
        await publish($, v)
        return { text: `${v.counter}\n${note}` }
      }
      if (arg === 'pane') {
        const v = await buildView($)
        await publish($, v)
        const opened = await $.ui.open({ id: PANE, title: 'Token Ledger', focus: true, closeOnEscape: true })
        if (opened.isPlaced) return { text: 'Token Ledger pane opened. Esc or the close mark closes it.' }
        return { text: `${v.details}\n(The pane could not be shown here.)` }
      }
      return { text: 'Usage: /token-ledger [details|refresh|pane]' }
    } catch {
      return { text: formatCounter({ status: 'unavailable' }, 0) }
    }
  }).catch(() => ({ text: formatCounter({ status: 'unavailable' }, 0) }))

  // /usage companion: the built-in runs untouched; the counter rides beside it.
  on('command.run', { command: 'usage' }, async ($, e, next) => {
    const r = await next(e)
    if (!isInteractive) {
      try {
        const v = await buildView($)
        return { ...r, text: (r.text ? r.text + '\n' : '') + v.counter }
      } catch {
        return r
      }
    }
    // Interactive: next() settles when the Usage panel closes. A toast raised
    // while the panel is open is clipped to its title row (verified 2.1.322),
    // so the counter is shown as the panel closes; the result is untouched.
    try {
      const v = await buildView($)
      $.ui.toast(v.counter, { timeoutMs: 10000 })
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const lines = (v.details || formatCounter({ status: 'unavailable' }, 0)).split('\n')
    return (
      <Box flexDirection="column">
        {lines.map((line, i) =>
          i === 0 ? <Text bold>{line}</Text> : <Text dimColor={line.startsWith('Counts recorded')}>{line || ' '}</Text>,
        )}
        <Box>
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          <Text dimColor> Esc closes · /token-ledger refresh to sync</Text>
        </Box>
      </Box>
    )
  })
}
