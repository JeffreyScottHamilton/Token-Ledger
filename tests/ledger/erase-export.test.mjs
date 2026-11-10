import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../plugin/lib/store.mjs';
import { createToken, hashToken } from '../../plugin/lib/tokens.mjs';
import { importTranscripts, syncTranscripts } from '../../plugin/lib/importer.mjs';
import { tmpDir, copyProjects, cleanupTemps, CANARIES } from './helpers.mjs';

after(cleanupTemps);

test('export excludes tokens; erase → empty/0; deleting transcripts keeps totals', async () => {
  const proj = copyProjects();
  const store = openStore(join(tmpDir(), 'ledger.db'));
  store.upsertSource('cloud-a', 'cloud');
  const tok = createToken(store, 'cloud-a', 'ingest');
  await importTranscripts({ store, projectsDir: proj, source: 'laptop' });
  const total = store.summary().total;
  assert.ok(total > 0);

  fs.rmSync(proj, { recursive: true, force: true });
  await syncTranscripts({ store, projectsDir: proj, source: 'laptop' });
  assert.equal(store.summary().total, total, 'transcript deletion does not reduce total');

  for (const fmt of ['json', 'csv']) {
    const out = store.exportAll(fmt);
    assert.ok(!out.includes(tok) && !out.includes(hashToken(tok)), `${fmt} export leaks token`);
    for (const c of CANARIES) assert.ok(!out.includes(c));
  }
  assert.equal(JSON.parse(store.exportAll('json')).records.length, 3);
  assert.equal(store.exportAll('csv').trim().split('\n').length, 4);

  store.erase();
  const s = store.summary();
  assert.equal(s.status, 'empty');
  assert.equal(s.total, 0);
  assert.equal(s.gaps.length, 0);
  assert.ok(store.tokenByHash(hashToken(tok)), 'tokens kept');
  assert.ok(store.getSource('cloud-a'), 'sources kept');
  store.close();
});
