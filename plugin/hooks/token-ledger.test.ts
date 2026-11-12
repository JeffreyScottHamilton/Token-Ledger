import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/ledger-home'
const NOW = Date.parse('2026-11-10T09:00:10.000Z')

const SUMMARY = {
  schema: 1,
  status: 'ok',
  total: 12483910,
  requests: 4210,
  breakdown: { input: 483910, output: 2000000, cacheWrite: 3000000, cacheRead: 7000000, cacheWrite5m: 2500000, cacheWrite1h: 500000 },
  firstRecordedAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-11-10T09:00:00.000Z',
  generatedAt: '2026-11-10T09:00:05.000Z',
  sources: [
    { label: 'laptop', kind: 'local', status: 'reporting', total: 10000000, requests: 4000, firstAt: '2026-10-01T12:00:00.000Z', lastAt: '2026-11-10T09:00:00.000Z' },
    { label: 'cloud-web', kind: 'cloud', status: 'silent', total: 2483910, requests: 210, firstAt: '2026-10-05T12:00:00.000Z', lastAt: '2026-11-01T09:00:00.000Z' },
  ],
  gaps: [{ source: 'cloud-web', kind: 'unconnected', count: 1, detail: 'no relay paired' }],
}

type World = {
  files?: Record<string, string>
  healthy?: boolean
  store?: Record<string, unknown>
  interactive?: boolean
  usageText?: string
  runFails?: boolean
  /** Rows on the account page: id → { version, data } */
  docs?: Record<string, { version: number; data: Record<string, unknown> }>
  pageDown?: boolean
}

/** Stands in for the engine beneath the plugin. Returns what the plugin did. */
async function boot($: any, on: On, w: World = {}) {
  const seen = { toasts: [] as string[], statuses: [] as (string | undefined)[], runs: [] as string[][], opened: [] as string[],
    tools: [] as Record<string, unknown>[], contexts: [] as (readonly string[] | undefined)[] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, w.store ?? {})
  mock.env(on, { TOKEN_LEDGER_HOME: HOME, HOME: '/home/u' })
  const files = w.files ?? {}
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT ' + e.path)
    return { value: text }
  })
  on('http.fetch', (_$, e) => {
    if (!w.healthy) throw new Error('ECONNREFUSED ' + e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  on('process.run', (_$, e) => {
    seen.runs.push([...e.argv])
    if (w.runFails) throw new Error('spawn node ENOENT')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', (_$, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('ui.toast', (_$, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.open', (_$, e) => { seen.opened.push(e.id); return { value: { isPlaced: true } } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // ArtifactData as Claude Code 2.1.322 answers it: list gives ids and versions, values only in the text.
  const docs = w.docs ?? {}
  on('tool.call', { tool: 'ArtifactData' }, (_$, e: any) => {
    seen.tools.push({ ...e })
    if (w.pageDown) throw new Error('network')
    if (e.action === 'list') {
      const ids = Object.keys(docs)
      return {
        result: { db_read: { op: 'list', collection: 'devices', docs: ids.map(id => ({ id, data: {}, version: docs[id]!.version })) } },
        text: `${ids.length} documents\n=== BEGIN ARTIFACT DB x ===\n` +
          ids.map(id => JSON.stringify({ id, data: docs[id]!.data, version: docs[id]!.version })).join('\n') + '\n=== END ARTIFACT DB x ===',
      } as any
    }
    if (e.action === 'set') return { result: {}, text: `Database set committed: "devices"/"${e.doc_id}".` } as any
    return { result: {}, text: 'ok' } as any
  })
  on('prompt.submit', (_$, e) => { seen.contexts.push(e.context); return { text: e.text, context: e.context } })
  // The built-in /usage, as core answers it.
  on('command.run', { command: 'usage' }, () => ({ text: w.usageText }))
  const interactive = w.interactive ?? false
  await $.session.start({ cwd: '/', surface: interactive ? 'terminal' : null, isInteractive: interactive })
  return { ...seen, clock }
}

// The kit stamps origin and presentation as a session does.
const run = ($: any, c: { command: string; args: string }): Promise<{ text?: string }> => $.command.run(c)

const file = (s: object) => ({ [`${HOME}/summary.json`]: JSON.stringify(s) })

test('ok: one line, grouped digits, middle dot', async ($, on) => {
  await boot($, on, { files: file(SUMMARY) })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · 12,483,910')
  expect(r.text?.includes('\n')).toBe(false)
})

test('empty: confirmed zero renders 0', async ($, on) => {
  await boot($, on, { files: file({ ...SUMMARY, status: 'empty', total: 0, sources: [], gaps: [] }) })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · 0')
})

test('stale: old generatedAt and failed health check', async ($, on) => {
  await boot($, on, { files: file({ ...SUMMARY, generatedAt: '2026-11-10T06:00:00.000Z' }), healthy: false })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · 12,483,910 (stale · updated 3h ago)')
})

test('old generatedAt but collector healthy stays ok', async ($, on) => {
  await boot($, on, { files: file({ ...SUMMARY, generatedAt: '2026-11-10T06:00:00.000Z' }), healthy: true })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · 12,483,910')
})

test('unreadable file falls back to the cached summary as stale', async ($, on) => {
  await boot($, on, { store: { lastSummary: { ...SUMMARY, generatedAt: '2026-11-10T07:00:00.000Z' } } })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · 12,483,910 (stale · updated 2h ago)')
})

test('nothing readable: unavailable, never 0', async ($, on) => {
  await boot($, on, { files: { [`${HOME}/summary.json`]: '{not json' } })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · unavailable')
})

test('wrong schema is not trusted', async ($, on) => {
  await boot($, on, { files: file({ ...SUMMARY, schema: 2 }) })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · unavailable')
})

test('details lists sources, breakdown, gaps, last error and the disclaimer', async ($, on) => {
  await boot($, on, {
    files: file(SUMMARY),
    store: { lastError: { at: '2026-11-10T08:00:00.000Z', step: 'ensure', message: 'spawn node ENOENT' } },
  })
  const r = await run($, { command: 'token-ledger', args: 'details' })
  const text = r.text ?? ''
  const lines = text.split('\n')
  expect(lines[0]).toBe('Total tracked tokens · 12,483,910')
  expect(text).toContain('First recorded: 2026-10-01T12:00:00.000Z')
  expect(text).toContain('Last updated: 2026-11-10T09:00:00.000Z (10s ago)')
  expect(text).toContain('  Uncached input  483,910')
  expect(text).toContain('  Output          2,000,000')
  expect(text).toContain('  Cache writes    3,000,000 (5m 2,500,000 / 1h 500,000)')
  expect(text).toContain('  Cache reads     7,000,000')
  expect(text).toContain('  laptop [local] reporting · 10,000,000 tokens · last seen 2026-11-10T09:00:00.000Z')
  expect(text).toContain('  cloud-web [cloud] silent · 2,483,910 tokens · last seen 2026-11-01T09:00:00.000Z')
  expect(text).toContain('  cloud-web unconnected ×1 — no relay paired')
  expect(text).toContain('Collector autostart: last error at 2026-11-10T08:00:00.000Z (ensure): spawn node ENOENT')
  expect(lines[lines.length - 1]).toBe('Counts recorded API usage; not a bill or plan-limit meter.')
})

test('headless /usage: built-in text kept, counter appended', async ($, on) => {
  await boot($, on, { files: file(SUMMARY), usageText: 'Total cost: $0.00' })
  const r = await run($, { command: 'usage', args: '' })
  expect(r.text).toBe('Total cost: $0.00\nTotal tracked tokens · 12,483,910')
})

test('interactive /usage: result unchanged, counter as a toast', async ($, on) => {
  const seen = await boot($, on, { files: file(SUMMARY), interactive: true, usageText: undefined })
  const r = await run($, { command: 'usage', args: '' })
  expect(r.text).toBe(undefined)
  expect(seen.toasts).toEqual(['Total tracked tokens · 12,483,910'])
})

test('refresh runs token-ledger sync through node, then re-reads', async ($, on) => {
  const seen = await boot($, on, { files: file(SUMMARY) })
  const r = await run($, { command: 'token-ledger', args: 'refresh' })
  expect(r.text).toBe('Total tracked tokens · 12,483,910\nSynced.')
  const last = seen.runs[seen.runs.length - 1] ?? []
  expect(last[0]).toBe('node')
  expect(last[1]?.endsWith('/bin/token-ledger.mjs')).toBe(true)
  expect(last[2]).toBe('sync')
})

test('pane opens and draws counter and details on every pane surface', async ($, on) => {
  const seen = await boot($, on, { files: file(SUMMARY), interactive: true })
  const r = await run($, { command: 'token-ledger', args: 'pane' })
  expect(r.text).toContain('Token Ledger pane opened')
  expect(seen.opened).toEqual(['token-ledger'])
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({
      plugin: 'token-ledger',
      surface,
      component: 'Pane',
      requestId: 'token-ledger',
      props: { title: 'Token Ledger', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^Total tracked tokens/ }))?.text).toBe('Total tracked tokens · 12,483,910')
    expect(await ui.find({ type: 'Text', text: /laptop \[local\]/ })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.unmount()
  }
})

test('autostart runs ensure then sync off the start path', async ($, on) => {
  const seen = await boot($, on, { files: file(SUMMARY) })
  expect(seen.runs.length).toBe(0)
  await seen.clock.advance(5)
  const steps = seen.runs.map(a => a[2])
  expect(steps).toEqual(['ensure', 'sync'])
})

test('status row off by default: cleared, never set', async ($, on) => {
  const seen = await boot($, on, { files: file(SUMMARY), interactive: true })
  await seen.clock.advance(61_000)
  expect(seen.statuses.every(s => s === undefined)).toBe(true)
})

test('status row on: counter shown and refreshed every 60 s', { options: { showStatusRow: true } }, async ($, on) => {
  const seen = await boot($, on, { files: file(SUMMARY), interactive: true })
  await seen.clock.advance(5)
  expect(seen.statuses).toEqual(['Total tracked tokens · 12,483,910'])
  await seen.clock.advance(60_000)
  expect(seen.statuses.length).toBe(2)
})

test('autostart failure is recorded and shown in details, start not blocked', async ($, on) => {
  const seen = await boot($, on, { files: file(SUMMARY), runFails: true })
  await seen.clock.advance(5)
  const r = await run($, { command: 'token-ledger', args: 'details' })
  expect(r.text).toContain('Collector autostart: last error at')
  expect(r.text).toContain('(ensure): ')
})

// ---------- account page sync ----------

const PAGE = 'https://claude.ai/artifact/AbCdEf123456'
const DEVICE = 'd-0123456789ab'
const ROW = { url: PAGE, device: DEVICE, data: { app: 'token-ledger', v: 1, label: 'Laptop', kind: 'computer', total: 1000, updatedAt: '2026-11-10T09:00:00.000Z' } }
const OTHER = { app: 'token-ledger', v: 1, label: 'Desktop', kind: 'computer', total: 500, updatedAt: '2026-11-10T08:00:00.000Z' }
const linked = (s: object) => ({ ...file(s), [`${HOME}/account-row.json`]: JSON.stringify(ROW) })
const submit = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } })

test('account: counter adds other devices from the page, own row replaced by the live total', async ($, on) => {
  await boot($, on, { files: linked(SUMMARY), docs: { [DEVICE]: { version: 3, data: ROW.data }, 'd-ffffffffffff': { version: 1, data: OTHER } } })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · 12,484,410')
  const d = await run($, { command: 'token-ledger', args: 'details' })
  expect(d.text).toContain('Desktop [computer] · 500 tokens')
  expect(d.text).toContain(`Account page: ${PAGE}`)
})

test('account: page unreachable shows this computer only, never fails', async ($, on) => {
  await boot($, on, { files: linked(SUMMARY), pageDown: true })
  const r = await run($, { command: 'token-ledger', args: '' })
  expect(r.text).toBe('Total tracked tokens · 12,483,910')
  const d = await run($, { command: 'token-ledger', args: 'details' })
  expect(d.text).toContain('could not be read')
})

test('account: daily sync rides on the next message once, and the committed write marks the day done', async ($, on) => {
  const seen = await boot($, on, { files: linked(SUMMARY), interactive: true, docs: { [DEVICE]: { version: 3, data: ROW.data } } })
  await seen.clock.advance(5)
  await submit($, 'hello')
  const ctx = seen.contexts.at(-1) ?? []
  expect(ctx.length).toBe(1)
  expect(ctx[0]).toContain('"doc_id":"d-0123456789ab"')
  expect(ctx[0]).toContain('"if_version":3')
  // Claude makes the write; the hook sees it commit.
  await $.tool.call({ tool: 'ArtifactData', action: 'set', url: PAGE, collection: 'devices', doc_id: DEVICE, data: ROW.data, if_version: 3 } as any)
  await submit($, 'next message')
  expect(seen.contexts.at(-1) ?? []).toEqual([])
  const a = await run($, { command: 'token-ledger', args: 'account' })
  expect(a.text).toContain('Last synced: ')
  expect(a.text).not.toContain('not yet')
})

test('account: synced within 20 hours asks nothing', async ($, on) => {
  const seen = await boot($, on, { files: linked(SUMMARY), interactive: true, store: { accountSyncedAt: NOW - 3_600_000 } })
  await seen.clock.advance(5)
  await submit($, 'hello')
  expect(seen.contexts.at(-1) ?? []).toEqual([])
})

test('account: not linked asks nothing and never calls ArtifactData', async ($, on) => {
  const seen = await boot($, on, { files: file(SUMMARY), interactive: true })
  await seen.clock.advance(5)
  await submit($, 'hello')
  expect(seen.contexts.at(-1) ?? []).toEqual([])
  expect(seen.tools.length).toBe(0)
})

test('account: gives up after two messages if Claude does not make the write', async ($, on) => {
  const seen = await boot($, on, { files: linked(SUMMARY), interactive: true, docs: {} })
  await seen.clock.advance(5)
  await submit($, 'one')
  await submit($, 'two')
  await submit($, 'three')
  const counts = seen.contexts.map(c => (c ?? []).length)
  expect(counts.slice(-3)).toEqual([1, 1, 0])
})

test('account: a manual sync write also marks the day done', async ($, on) => {
  const seen = await boot($, on, { files: linked(SUMMARY), interactive: true, store: { accountSyncedAt: NOW - 3_600_000 } })
  await seen.clock.advance(5)
  await $.tool.call({ tool: 'ArtifactData', action: 'set', url: PAGE, collection: 'devices', doc_id: DEVICE, data: ROW.data } as any)
  const a = await run($, { command: 'token-ledger', args: 'account' })
  expect(a.text).toContain('Last synced: 0s ago')
})
