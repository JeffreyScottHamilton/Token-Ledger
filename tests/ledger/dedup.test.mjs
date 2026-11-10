import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openStore } from '../../plugin/lib/store.mjs';
import { fromOtlpLogs } from '../../plugin/lib/normalize.mjs';
import { importTranscripts } from '../../plugin/lib/importer.mjs';
import { tmpDir, cleanupTemps, otlpBody, PROJECTS, T } from './helpers.mjs';

after(cleanupTemps);

test('dedup across replays, imports, sources and restarts', async () => {
  const home = tmpDir();
  const db = join(home, 'ledger.db');
  let store = openStore(db);
  const results = [];
  for (let i = 0; i < 3; i++) results.push(store.insertRecords(fromOtlpLogs(otlpBody(), { source: 'laptop' }).records));
  assert.deepEqual(results.map((r) => r.accepted), [2, 0, 0]);
  assert.deepEqual(results.map((r) => r.duplicates), [0, 2, 2]);
  assert.equal(store.summary().requests, 2);

  // transcript overlaps OTel for req ...0001
  const r1 = await importTranscripts({ store, projectsDir: PROJECTS, source: 'laptop' });
  assert.equal(r1.alreadyInLedger, 1);
  assert.equal(r1.imported, 2);
  const expected = T.otel1 + T.otel2 + T.tr3 + T.sub4;
  assert.equal(store.summary().total, expected);
  const r2 = await importTranscripts({ store, projectsDir: PROJECTS, source: 'laptop' });
  assert.equal(r2.imported, 0);
  assert.equal(store.summary().total, expected);

  // conflicting counts for an existing rid keep the first and bump diagnostics
  const c = fromOtlpLogs(otlpBody()).records[0];
  const r3 = store.insertRecords([{ ...c, input: c.input + 1 }]);
  assert.equal(r3.conflicts, 1);
  assert.equal(store.diagnostics().conflicts, '1');
  assert.equal(store.summary().total, expected);

  store.close();
  store = openStore(db);
  assert.equal(store.summary().total, expected);
  assert.equal(store.summary().requests, 4);
  store.close();
});
