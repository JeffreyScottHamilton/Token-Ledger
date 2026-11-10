import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../plugin/lib/store.mjs';
import { importTranscripts, scanTranscripts, syncTranscripts } from '../../plugin/lib/importer.mjs';
import { rid } from '../../plugin/lib/normalize.mjs';
import { copyProjects, tmpDir, cleanupTemps, CANARIES, T, PROJECTS } from './helpers.mjs';

after(cleanupTemps);

test('scan: repeated requestId → 1 record, subagent counted, malformed line → skipped', async () => {
  const rep = await scanTranscripts({ projectsDir: PROJECTS });
  assert.equal(rep.files, 2);
  assert.equal(rep.eligible, 3);
  assert.equal(rep.alreadyInLedger, 0);
  assert.deepEqual(rep.skipped, { unsupported_format: 1, partial_record: 1, malformed_json: 1 });
  assert.equal(rep.dateRange.first, '2026-11-10T00:33:17.684Z');
  assert.equal(rep.dateRange.last, '2026-11-10T00:45:00.000Z');
});

test('import: records, gaps, and no content canary in DB bytes', async () => {
  const home = tmpDir();
  const store = openStore(join(home, 'ledger.db'));
  const rep = await importTranscripts({ store, projectsDir: PROJECTS, source: 'laptop' });
  assert.equal(rep.imported, 3);
  const s = store.summary({ localLabel: 'laptop' });
  assert.equal(s.total, T.otel1 + T.tr3 + T.sub4);
  assert.equal(s.requests, 3);
  assert.ok(store.hasRecord(rid('req_SYNTHETIC0000000000000004')), 'subagent record present');
  const kinds = Object.fromEntries(s.gaps.map((g) => [g.kind, g.count]));
  assert.equal(kinds.partial_record, 1);
  assert.equal(kinds.unsupported_format, 2); // unknown shape + malformed JSON
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.close();
  for (const f of fs.readdirSync(home)) {
    const bytes = fs.readFileSync(join(home, f)).toString('latin1');
    for (const c of CANARIES) assert.ok(!bytes.includes(c), `canary ${c} in ${f}`);
  }
});

test('sync: incremental by byte offset, partial trailing line waits, truncation re-handled', async () => {
  const proj = copyProjects();
  const home = tmpDir();
  const store = openStore(join(home, 'ledger.db'));
  let r = await syncTranscripts({ store, projectsDir: proj });
  assert.equal(r.imported, 3);
  r = await syncTranscripts({ store, projectsDir: proj });
  assert.equal(r.imported, 0);
  const f = join(proj, '-home-synthetic-project', 'synthetic-session-0001.jsonl');
  const line = JSON.stringify({ type: 'assistant', requestId: 'req_NEW1', timestamp: '2026-11-10T01:00:00Z',
    message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } });
  fs.appendFileSync(f, line.slice(0, 20)); // incomplete line
  r = await syncTranscripts({ store, projectsDir: proj });
  assert.equal(r.imported, 0);
  fs.appendFileSync(f, line.slice(20) + '\n');
  r = await syncTranscripts({ store, projectsDir: proj });
  assert.equal(r.imported, 1);
  // rotate: file replaced by a shorter one
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', requestId: 'req_NEW2', timestamp: '2026-11-10T02:00:00Z',
    message: { model: 'm', usage: { input_tokens: 2, output_tokens: 2 } } }) + '\n');
  r = await syncTranscripts({ store, projectsDir: proj });
  assert.equal(r.imported, 1);
  const gapsBefore = JSON.stringify(store.summary().gaps);
  await importTranscripts({ store, projectsDir: proj });
  assert.equal(JSON.stringify(store.summary().gaps), gapsBefore, 're-import does not re-count gaps');
  store.close();
});
