import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, requestJson } from '../../plugin/lib/server.mjs';
import { createPair, joinPair } from '../../plugin/lib/pair.mjs';
import { openStore } from '../../plugin/lib/store.mjs';
import { ledgerPaths } from '../../plugin/lib/paths.mjs';
import { fromOtlpLogs } from '../../plugin/lib/normalize.mjs';
import { tmpDir, cleanupTemps, otlpRaw, otlpBody, makeCert, waitFor, T } from './helpers.mjs';

after(cleanupTemps);
const cert = makeCert();
const JSONH = { 'Content-Type': 'application/json' };

function otlpWith(requestId, n) {
  const b = otlpBody();
  const lr = b.resourceLogs[0].scopeLogs[0].logRecords[0];
  for (const a of lr.attributes) {
    if (a.key === 'request_id') a.value = { stringValue: requestId };
    if (a.key === 'input_tokens') a.value = { intValue: n };
  }
  b.resourceLogs[0].scopeLogs[0].logRecords = [lr];
  return Buffer.from(JSON.stringify(b));
}

test('secondary relays to primary over HTTPS; survives primary outage without loss or dup',
  { skip: !cert && 'openssl not available', timeout: 30_000 }, async () => {
    const pHome = tmpDir();
    let primary = await startServer({ home: pHome, host: '127.0.0.1', port: 0, tlsCert: cert.cert, tlsKey: cert.key });
    const pPort = primary.port;
    // primary has its own local record
    const own = fromOtlpLogs(otlpBody(), { source: 'local' }).records[1];
    primary.store.insertRecords([own]);
    const code = createPair(primary.store, 'laptop-2', { url: `https://127.0.0.1:${pPort}`, caFile: cert.cert });
    assert.match(code, /^tlpair1\./);

    const sHome = tmpDir();
    const sPaths = ledgerPaths(sHome);
    // a record that existed before pairing is backfilled
    const pre = openStore(sPaths.db);
    pre.insertRecords([fromOtlpLogs(otlpBody(), { source: 'laptop-2' }).records[0]]);
    const j = joinPair(sPaths, code, pre);
    assert.equal(j.queued, 1);
    pre.close();

    const secondary = await startServer({ home: sHome, host: '127.0.0.1', port: 0, relayIntervalMs: 100, remoteSummaryIntervalMs: 200 });
    const sBase = `http://127.0.0.1:${secondary.port}`;
    try {
      const r = await requestJson(sBase + '/v1/logs', { method: 'POST', raw: otlpWith('req_RELAY_1', 100), headers: JSONH });
      assert.equal(r.status, 200);
      await waitFor(() => secondary.store.outboxStats().count === 0);
      const pSum = () => primary.store.summary();
      const tA = 35494 - 2 + 100;
      assert.equal(pSum().total, T.otel1 + T.otel2 + tA);
      assert.equal(pSum().sources.find((s) => s.label === 'laptop-2').total, T.otel1 + tA);

      // combined view on the secondary
      // The combined view comes from the primary's summary, refreshed on a timer: wait for it to catch up.
      const sv = await waitFor(async () => {
        await secondary.relayNow();
        const j = (await requestJson(sBase + '/api/v1/summary')).json;
        return j.total === T.otel1 + T.otel2 + tA ? j : null;
      }, 10_000, 100);
      assert.equal(sv.total, T.otel1 + T.otel2 + tA);
      assert.equal(sv.status, 'ok');
      assert.equal(sv.sources.find((s) => s.label === 'laptop-2').kind, 'local');

      // primary goes down
      await primary.close();
      await requestJson(sBase + '/v1/logs', { method: 'POST', raw: otlpWith('req_RELAY_2', 200), headers: JSONH });
      await requestJson(sBase + '/v1/logs', { method: 'POST', raw: otlpWith('req_RELAY_2', 200), headers: JSONH });
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(secondary.store.outboxStats().count, 1, 'held in outbox while primary is down');
      await secondary.relayNow();
      const down = (await requestJson(sBase + '/api/v1/summary')).json;
      assert.equal(down.status, 'stale', 'remote summary marked stale when unreachable');

      // primary back on the same port
      primary = await startServer({ home: pHome, host: '127.0.0.1', port: pPort, tlsCert: cert.cert, tlsKey: cert.key });
      await waitFor(async () => { await secondary.relayNow(); return secondary.store.outboxStats().count === 0; }, 15_000, 200);
      const tB = 35494 - 2 + 200;
      assert.equal(primary.store.summary().total, T.otel1 + T.otel2 + tA + tB);
      assert.equal(primary.store.summary().requests, 4);
      const back = await waitFor(async () => {
        await secondary.relayNow();
        const j = (await requestJson(sBase + '/api/v1/summary')).json;
        return j.status === 'ok' && j.total === T.otel1 + T.otel2 + tA + tB ? j : null;
      }, 10_000, 100);
      assert.equal(back.status, 'ok');
      assert.equal(back.total, T.otel1 + T.otel2 + tA + tB);
    } finally {
      await secondary.close();
      await primary.close();
    }
  });
