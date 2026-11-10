import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { formatCounter, formatDetails, groupDigits } from '../../plugin/lib/format.mjs';
import { openStore } from '../../plugin/lib/store.mjs';
import { unavailableSummary } from '../../plugin/lib/summary-file.mjs';
import { tmpDir, cleanupTemps, REPO } from './helpers.mjs';

after(cleanupTemps);
const NOW = Date.parse('2026-11-10T12:00:00.000Z');

test('canonical counter strings', () => {
  assert.equal(formatCounter({ status: 'ok', total: 12483910 }, NOW), 'Total tracked tokens · 12,483,910');
  assert.equal(formatCounter({ status: 'empty', total: 0 }, NOW), 'Total tracked tokens · 0');
  assert.equal(formatCounter({ status: 'stale', total: 12483910, generatedAt: '2026-11-10T09:00:00.000Z' }, NOW),
    'Total tracked tokens · 12,483,910 (stale · updated 3h ago)');
  assert.equal(formatCounter({ status: 'unavailable', total: null }, NOW), 'Total tracked tokens · unavailable');
  assert.equal(formatCounter(null, NOW), 'Total tracked tokens · unavailable');
  assert.equal(formatCounter(unavailableSummary(NOW), NOW), 'Total tracked tokens · unavailable');
  assert.deepEqual([0, 7, 999, 1000, 1234567, 1e9].map(groupDigits), ['0', '7', '999', '1,000', '1,234,567', '1,000,000,000']);
});

test('confirmed zero from an empty ledger; demo records total 12,483,910', () => {
  const store = openStore(join(tmpDir(), 'ledger.db'));
  const s0 = store.summary();
  assert.equal(s0.status, 'empty');
  assert.equal(s0.total, 0);
  assert.equal(formatCounter(s0), 'Total tracked tokens · 0');
  const demo = JSON.parse(fs.readFileSync(join(REPO, 'demo', 'synthetic-records.json'), 'utf8'));
  store.insertRecords(demo.records);
  const s = store.summary({ localLabel: 'demo-laptop' });
  assert.equal(s.status, 'ok');
  assert.equal(s.requests, 200);
  assert.equal(formatCounter(s), 'Total tracked tokens · 12,483,910');
  const d = formatDetails(s);
  for (const needle of ['First recorded', 'Last updated', 'Uncached input', 'Output', 'Cache writes', 'Cache reads',
    'demo-laptop', 'demo-cloud', 'Coverage gaps', 'Counts recorded API usage; not a bill or plan-limit meter.']) {
    assert.ok(d.includes(needle), `details missing ${needle}`);
  }
  store.close();
});
