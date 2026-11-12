import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir, cleanupTemps, CLI, CANARIES } from './helpers.mjs';
import { openStore } from '../../plugin/lib/store.mjs';
import { buildAccountRow } from '../../plugin/lib/summary-file.mjs';

after(() => cleanupTemps());

const PAGE = 'https://claude.ai/artifact/AbCdEf123456';
const rec = (rid, source, n) => ({
  rid: rid.padEnd(32, '0'), ts: Date.parse('2026-11-10T01:00:00Z'), source, origin: 'otel', model: 'm', session: null,
  input: n, output: n, cache_write: n, cache_read: n, cache_write_5m: null, cache_write_1h: null,
});

test('account row counts only this device\'s own records and carries only allowlisted fields', () => {
  const home = tmpDir();
  const store = openStore(join(home, 'ledger.db'));
  try {
    store.insertRecords([rec('a1', 'laptop', 10), rec('a2', 'laptop', 5), rec('b1', 'paired-desktop', 1000)]);
    assert.equal(buildAccountRow(store, { label: 'laptop' }), null, 'no row when no page is linked');
    const row = buildAccountRow(store, { label: 'laptop', account: { url: PAGE, device: 'd-0123456789ab', label: 'Laptop' } });
    assert.equal(row.url, PAGE);
    assert.equal(row.device, 'd-0123456789ab');
    assert.equal(row.data.total, 60, 'paired-desktop records are not this device\'s');
    assert.equal(row.data.requests, 2);
    assert.deepEqual(Object.keys(row.data).sort(), ['app', 'cacheRead', 'cacheWrite', 'firstAt', 'input', 'kind', 'label',
      'lastAt', 'output', 'requests', 'total', 'updatedAt', 'v'].sort());
    assert.equal(buildAccountRow(store, { label: 'laptop', account: { url: 'https://evil.example/x', device: 'd-0123456789ab' } }), null);
  } finally { store.close(); }
});

test('account link / show / unlink through the CLI', () => {
  const home = tmpDir();
  const env = { ...process.env, TOKEN_LEDGER_HOME: home, CLAUDE_CONFIG_DIR: tmpDir() };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8', timeout: 20_000 });

  let r = run('account', 'show');
  assert.equal(r.status, 3);
  r = run('account', 'link', 'https://example.com/not-a-page');
  assert.equal(r.status, 2, 'only claude.ai artifact links are accepted');

  r = run('account', 'link', PAGE + '?x=1', '--label', `Work laptop ${CANARIES[0]}<script>`);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.account.url, PAGE, 'query string dropped');
  assert.match(cfg.account.device, /^d-[0-9a-f]{12}$/);
  assert.ok(!cfg.account.label.includes('<'), 'label sanitized');
  const device = cfg.account.device;

  r = run('account', 'link', PAGE, '--label', 'Renamed');
  assert.equal(JSON.parse(fs.readFileSync(join(home, 'config.json'), 'utf8')).account.device, device, 're-link keeps the device id');

  r = run('account', 'show', '--json');
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(r.stdout);
  assert.equal(row.device, device);
  assert.equal(row.data.label, 'Renamed');
  assert.ok(fs.existsSync(join(home, 'account-row.json')));

  r = run('account', 'unlink');
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(join(home, 'account-row.json')), 'row file removed on unlink');
  assert.equal(JSON.parse(fs.readFileSync(join(home, 'config.json'), 'utf8')).account, undefined);
});
