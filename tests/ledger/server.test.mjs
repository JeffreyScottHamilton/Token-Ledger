import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, requestJson } from '../../plugin/lib/server.mjs';
import { createToken } from '../../plugin/lib/tokens.mjs';
import { ledgerPaths } from '../../plugin/lib/paths.mjs';
import { tmpDir, cleanupTemps, otlpRaw, makeCert, waitFor, CANARIES, T } from './helpers.mjs';

after(cleanupTemps);
const JSONH = { 'Content-Type': 'application/json' };

test('loopback collector: ingest, summary, limits and guards', async () => {
  const home = tmpDir();
  const srv = await startServer({ home, host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    assert.deepEqual((await requestJson(base + '/healthz')).json.ok, true);
    for (let i = 0; i < 3; i++) {
      const r = await requestJson(base + '/v1/logs', { method: 'POST', raw: otlpRaw(), headers: JSONH });
      assert.equal(r.status, 200);
    }
    const s = (await requestJson(base + '/api/v1/summary')).json;
    assert.equal(s.total, T.otel1 + T.otel2);
    assert.equal(s.requests, 2);
    assert.equal(s.status, 'ok');

    const big = Buffer.alloc(1024 * 1024 + 10, 0x20);
    assert.equal((await requestJson(base + '/v1/logs', { method: 'POST', raw: big, headers: JSONH })).status, 413);
    const pb = await requestJson(base + '/v1/logs', { method: 'POST', raw: Buffer.from('x'), headers: { 'Content-Type': 'application/x-protobuf' } });
    assert.equal(pb.status, 415);
    assert.match(pb.json.message, /http\/json/);
    assert.equal((await requestJson(base + '/api/v1/summary', { headers: { Host: 'evil.example:80' } })).status, 403);
    assert.equal((await requestJson(base + '/api/v1/summary', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await requestJson(base + '/v1/logs', { method: 'POST', raw: Buffer.from('{bad'), headers: JSONH })).status, 400);
    // relay endpoint always needs an ingest token
    assert.equal((await requestJson(base + '/ingest/v1/records', { method: 'POST', body: { records: [] } })).status, 401);

    // summary.json rewritten (debounced ≤1s)
    const p = ledgerPaths(home);
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(p.summary, 'utf8')).total === T.otel1 + T.otel2; } catch { return false; } }, 3000);
    const log = fs.readFileSync(p.log, 'utf8');
    assert.match(log, /info batch accepted=2 dup=0 conflicts=0 gaps=1/);
    for (const c of CANARIES) assert.ok(!log.includes(c));
  } finally {
    await srv.close();
  }
});

test('refuses non-loopback bind without TLS', async () => {
  await assert.rejects(startServer({ home: tmpDir(), host: '0.0.0.0', port: 0 }), /non-loopback/);
});

const cert = makeCert();
test('remote (TLS) collector: token scopes, revocation, label override', { skip: !cert && 'openssl not available' }, async () => {
  const home = tmpDir();
  const srv = await startServer({ home, host: '127.0.0.1', port: 0, tlsCert: cert.cert, tlsKey: cert.key });
  const ca = fs.readFileSync(cert.cert);
  const base = `https://127.0.0.1:${srv.port}`;
  const store = srv.store;
  store.upsertSource('cloud-a', 'cloud');
  const ing = createToken(store, 'cloud-a', 'ingest');
  const rd = createToken(store, 'cloud-a', 'read');
  const post = (token) => requestJson(base + '/v1/logs', { method: 'POST', raw: otlpRaw(), headers: JSONH, token, ca });
  const sum = (token) => requestJson(base + '/api/v1/summary', { token, ca });
  try {
    let r = await post(null);
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'unauthorized' });
    assert.equal((await sum(null)).status, 401);
    assert.equal((await post(rd)).status, 401, 'read token cannot ingest');
    assert.equal((await sum(ing)).status, 401, 'ingest token cannot read');
    assert.equal((await post(ing)).status, 200);
    r = await sum(rd);
    assert.equal(r.status, 200);
    assert.equal(r.json.total, T.otel1 + T.otel2);
    const src = r.json.sources.find((s) => s.label === 'cloud-a');
    assert.equal(src.kind, 'cloud');
    assert.equal(src.total, T.otel1 + T.otel2, 'ingest token label overrides record.source');
    // relay endpoint, label override even when the record claims another source
    const rec = { rid: 'b'.repeat(32), ts: Date.now(), source: 'spoofed', origin: 'otel', model: 'm', session: null,
      input: 1, output: 1, cache_write: 0, cache_read: 0, cache_write_5m: null, cache_write_1h: null };
    r = await requestJson(base + '/ingest/v1/records', { method: 'POST', body: { records: [rec, { rid: 'bad' }] }, token: ing, ca });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.accepted, r.json.rejected], [1, 1]);
    const after1 = (await sum(rd)).json;
    assert.ok(!after1.sources.some((s) => s.label === 'spoofed'));
    store.revokeLabel('cloud-a');
    assert.equal((await post(ing)).status, 401, 'revoked ingest token');
    assert.equal((await sum(rd)).status, 401, 'revoked read token');
  } finally {
    await srv.close();
  }
});
