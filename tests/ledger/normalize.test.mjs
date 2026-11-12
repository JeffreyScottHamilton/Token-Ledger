import test from 'node:test';
import assert from 'node:assert/strict';
import { fromOtlpLogs, fromTranscriptLine, validateRecord, rid, sessionHash, recordTotal } from '../../plugin/lib/normalize.mjs';
import { otlpBody, CANARIES, T } from './helpers.mjs';

test('OTLP fixture → correct counts, only api_request used', () => {
  const { records, gaps, invalid } = fromOtlpLogs(otlpBody(), { source: 'laptop' });
  assert.equal(invalid, false);
  assert.equal(records.length, 2);
  const [a, b] = records;
  assert.equal(a.rid, rid('req_SYNTHETIC0000000000000001'));
  assert.match(a.rid, /^[0-9a-f]{32}$/);
  assert.deepEqual([a.input, a.output, a.cache_read, a.cache_write, a.cache_write_5m, a.cache_write_1h], [2, 4, 27394, 8094, 0, 8094]);
  assert.equal(recordTotal(a), T.otel1);
  assert.equal(a.ts, Date.parse('2026-11-10T00:33:17.684Z'));
  assert.equal(a.origin, 'otel');
  assert.equal(a.source, 'laptop');
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(a.session, sessionHash('synthetic-session-0001'));
  assert.match(a.session, /^[0-9a-f]{16}$/);
  // string intValues + event.name "claude_code.api_request"
  assert.deepEqual([b.input, b.output, b.cache_read, b.cache_write], [10, 200, 1000, 500]);
  assert.equal(recordTotal(b), T.otel2);
  // missing request_id → partial_record gap
  assert.deepEqual(gaps.map((g) => [g.kind, g.count]), [['partial_record', 1]]);
});

test('normalized output never contains prompt/tool/email/account attributes', () => {
  const out = JSON.stringify(fromOtlpLogs(otlpBody(), { source: 'laptop' }));
  for (const c of CANARIES) assert.ok(!out.includes(c), `canary leaked: ${c}`);
  const keys = Object.keys(fromOtlpLogs(otlpBody()).records[0]).sort();
  assert.deepEqual(keys, ['cache_read', 'cache_write', 'cache_write_1h', 'cache_write_5m', 'input', 'model', 'origin',
    'output', 'rid', 'session', 'source', 'ts']);
});

test('timestamp falls back to timeUnixNano; non-OTLP is invalid; bad counts are gaps', () => {
  const body = { resourceLogs: [{ scopeLogs: [{ logRecords: [
    { timeUnixNano: '1794270797684000000', body: { stringValue: 'claude_code.api_request' },
      attributes: [{ key: 'request_id', value: { stringValue: 'req_x' } }, { key: 'input_tokens', value: { doubleValue: 5 } },
        { key: 'output_tokens', value: { stringValue: '7' } }] },
    { body: { stringValue: 'claude_code.api_request' },
      attributes: [{ key: 'request_id', value: { stringValue: 'req_y' } }, { key: 'input_tokens', value: { intValue: '-3' } }] },
  ] }] }] };
  const r = fromOtlpLogs(body);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].ts, 1794270797684);
  assert.equal(r.records[0].input, 5);
  assert.equal(r.records[0].output, 7);
  assert.equal(r.records[0].model, 'unknown');
  assert.equal(r.gaps[0].kind, 'partial_record');
  assert.equal(fromOtlpLogs({ foo: 1 }).invalid, true);
});

test('validateRecord builds a new allowlisted object and rejects bad input', () => {
  const good = { rid: 'a'.repeat(32), ts: 1, source: 'x', origin: 'relay', model: 'm', session: null, input: 1, output: 2,
    cache_write: 3, cache_read: 4, cache_write_5m: null, cache_write_1h: 3, prompt: 'CANARY_PROMPT_TEXT_ab12' };
  const v = validateRecord(good);
  assert.ok(v);
  assert.equal(v.prompt, undefined);
  assert.equal(validateRecord({ ...good, rid: 'nothex' }), null);
  assert.equal(validateRecord({ ...good, input: -1 }), null);
  assert.equal(validateRecord({ ...good, input: 1e10 }), null);
  assert.equal(validateRecord({ ...good, source: 'Bad Label' }), null);
  assert.equal(validateRecord({ ...good, origin: 'other' }), null);
  assert.equal(validateRecord({ ...good, model: '../../etc' }).model, 'unknown');
});

test('fromTranscriptLine shapes', () => {
  assert.equal(fromTranscriptLine({ type: 'user' }), null);
  assert.deepEqual(fromTranscriptLine({ type: 'assistant', message: { content: [] } }), { gap: 'unsupported_format' });
  assert.deepEqual(fromTranscriptLine({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { usage: { input_tokens: 1, output_tokens: 1 } } }), { gap: 'partial_record' });
  const r = fromTranscriptLine({ type: 'assistant', requestId: 'req_1', timestamp: '2026-01-01T00:00:00Z', sessionId: 's',
    message: { model: 'claude-x', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } } } });
  assert.equal(r.record.rid, rid('req_1'));
  assert.equal(recordTotal(r.record), 10);
  assert.equal(r.record.origin, 'transcript');
});

test('5m/1h split larger than cache_write is dropped, total kept', async () => {
  const { validateRecord, fromOtlpLogs } = await import('../../plugin/lib/normalize.mjs');
  const r = validateRecord({ rid: 'a'.repeat(32), ts: 1, source: 'local', origin: 'otel', model: 'm',
    input: 1, output: 1, cache_write: 10, cache_read: 1, cache_write_5m: 500, cache_write_1h: 500 });
  assert.equal(r.cache_write, 10);
  assert.equal(r.cache_write_5m, null);
  assert.equal(r.cache_write_1h, null);
  const ok = validateRecord({ rid: 'b'.repeat(32), ts: 1, source: 'local', origin: 'otel', model: 'm',
    input: 1, output: 1, cache_write: 10, cache_read: 1, cache_write_5m: 4, cache_write_1h: 6 });
  assert.equal(ok.cache_write_5m, 4);
  assert.equal(ok.cache_write_1h, 6);
  const body = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: 'claude_code.api_request' }, attributes: [
    { key: 'request_id', value: { stringValue: 'req_split' } },
    { key: 'cache_creation_tokens', value: { intValue: 10 } },
    { key: 'cache_creation_5m_tokens', value: { intValue: 600 } },
    { key: 'cache_creation_1h_tokens', value: { intValue: 900 } },
  ] }] }] }] };
  const { records } = fromOtlpLogs(body, { source: 'local' });
  assert.equal(records[0].cache_write, 10);
  assert.equal(records[0].cache_write_5m, null);
});
