// The mod's TypeScript mirror (plugin/hooks/format.ts) must render exactly what
// the ledger's plugin/lib/format.mjs renders. Node >= 22.18 strips the types.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ledger from '../../plugin/lib/format.mjs';

// Node 22.13-22.17 needs --experimental-strip-types; skip there, never fail.
const canStrip = Boolean(process.features.typescript);
const mod = canStrip ? await import('../../plugin/hooks/format.ts') : null;
const skip = canStrip ? false : 'this Node cannot import .ts (needs >= 22.18)';

const NOW = Date.parse('2026-11-10T09:00:10.000Z');
const base = {
  schema: 1, status: 'ok', total: 12483910, requests: 4210,
  breakdown: { input: 483910, output: 2000000, cacheWrite: 3000000, cacheRead: 7000000, cacheWrite5m: 2500000, cacheWrite1h: 500000 },
  firstRecordedAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z', generatedAt: '2026-11-10T09:00:05.000Z',
  sources: [
    { label: 'laptop', kind: 'local', status: 'reporting', total: 10000000, requests: 4000, firstAt: 'a', lastAt: '2026-11-10T09:00:00.000Z' },
    { label: 'cloud-web', kind: 'cloud', status: 'never', total: 0, requests: 0 },
  ],
  gaps: [{ source: 'laptop', kind: 'partial_record', count: 3, detail: 'no request id' }, { source: 'x', kind: 'unconnected', count: 1234 }],
};
const table = [
  base,
  { ...base, status: 'empty', total: 0, requests: 0, sources: [], gaps: [], firstRecordedAt: null, updatedAt: null },
  { ...base, status: 'stale', generatedAt: '2026-11-10T06:00:00.000Z' },
  { ...base, status: 'stale', generatedAt: '2026-11-01T06:00:00.000Z' },
  { ...base, status: 'stale', generatedAt: '2026-11-10T08:48:00.000Z' },
  { ...base, status: 'stale', generatedAt: undefined, updatedAt: 'garbage' },
  { ...base, total: 999 }, { ...base, total: 1000 }, { ...base, total: 1e15 }, { ...base, total: 12.9 },
  { ...base, breakdown: undefined, sources: undefined, gaps: undefined },
  { status: 'unavailable' }, { ...base, status: 'unavailable' }, { ...base, total: -1 }, { ...base, total: NaN },
  { ...base, total: '5' }, null, undefined, {},
];

test('format.ts mirrors format.mjs', { skip }, () => {
  assert.equal(mod.COUNTER_PREFIX, ledger.COUNTER_PREFIX);
  assert.equal(mod.DISCLAIMER, ledger.DISCLAIMER);
  for (const [i, s] of table.entries()) {
    assert.equal(mod.formatCounter(s, NOW), ledger.formatCounter(s, NOW), `counter row ${i}`);
    assert.equal(mod.formatDetails(s, NOW), ledger.formatDetails(s, NOW), `details row ${i}`);
  }
  for (const n of [0, 1, 999, 1000, 12483910, -1234567, 1e21, NaN, Infinity, '7', null]) {
    assert.equal(mod.groupDigits(n), ledger.groupDigits(n), `groupDigits ${String(n)}`);
  }
});

test('counter strings are the SPEC §4 strings', { skip }, () => {
  assert.equal(mod.formatCounter(base, NOW), 'Total tracked tokens · 12,483,910');
  assert.equal(mod.formatCounter(table[2], NOW), 'Total tracked tokens · 12,483,910 (stale · updated 3h ago)');
  assert.equal(mod.formatCounter(null, NOW), 'Total tracked tokens · unavailable');
});
