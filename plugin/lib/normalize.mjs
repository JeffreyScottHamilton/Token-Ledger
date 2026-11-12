// Normalization to the §3 allowlisted usage record. Every record is built as a NEW object
// containing only allowlisted fields; nothing from the input is copied wholesale.
import { createHash } from 'node:crypto';

export const ORIGINS = ['otel', 'transcript', 'relay', 'demo'];
export const MAX_COUNT = 1e9;
const LABEL_RE = /^[a-z0-9-]{1,40}$/;
const MODEL_RE = /^[A-Za-z0-9._:\-[\]]{1,80}$/;
const RID_RE = /^[0-9a-f]{32}$/;
const SESSION_RE = /^[0-9a-f]{16}$/;
const API_REQUEST_NAMES = new Set(['api_request', 'claude_code.api_request']);

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function rid(requestId) {
  return sha256('anthropic-request:' + requestId).slice(0, 32);
}

export function sessionHash(id) {
  return typeof id === 'string' && id ? sha256('session:' + id).slice(0, 16) : null;
}

export function isLabel(l) { return typeof l === 'string' && LABEL_RE.test(l); }

/** Lower-case and squash a free-form name into a valid label (or null). */
export function toLabel(s) {
  if (typeof s !== 'string') return null;
  const l = s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return LABEL_RE.test(l) ? l : null;
}

export function cleanModel(m) {
  return typeof m === 'string' && MODEL_RE.test(m) ? m : 'unknown';
}

/** Parse a count: finite integer 0..1e9 from number or numeric string. undefined -> missing, NaN -> invalid. */
export function toCount(v) {
  if (v === undefined || v === null) return undefined;
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d+(\.0+)?\s*$/.test(v)) n = Number(v);
  else return NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_COUNT) return NaN;
  return n;
}

const okCount = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;

export function recordTotal(r) {
  return r.input + r.output + r.cache_write + r.cache_read;
}

/**
 * The 5m/1h split is only a breakdown of cache_write. A split that adds up to more than the total
 * is inconsistent, so it is dropped (the total itself is kept).
 */
export function fixBreakdown(rec) {
  const w5 = rec.cache_write_5m ?? 0, w1 = rec.cache_write_1h ?? 0;
  if (w5 + w1 > rec.cache_write) { rec.cache_write_5m = null; rec.cache_write_1h = null; }
  return rec;
}

/**
 * Validate an incoming normalized record (e.g. from a relay). Returns a NEW allowlisted record or null.
 * `received_at` is assigned by the store at commit time.
 */
export function validateRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.rid !== 'string' || !RID_RE.test(r.rid)) return null;
  if (!Number.isInteger(r.ts) || r.ts <= 0 || r.ts > 8.64e15) return null;
  if (!isLabel(r.source)) return null;
  if (!ORIGINS.includes(r.origin)) return null;
  if (r.session !== null && r.session !== undefined && !(typeof r.session === 'string' && SESSION_RE.test(r.session))) return null;
  for (const k of ['input', 'output', 'cache_write', 'cache_read']) if (!okCount(r[k])) return null;
  for (const k of ['cache_write_5m', 'cache_write_1h']) {
    if (r[k] !== null && r[k] !== undefined && !okCount(r[k])) return null;
  }
  return fixBreakdown({
    rid: r.rid,
    ts: r.ts,
    source: r.source,
    origin: r.origin,
    model: cleanModel(r.model),
    session: r.session ?? null,
    input: r.input,
    output: r.output,
    cache_write: r.cache_write,
    cache_read: r.cache_read,
    cache_write_5m: r.cache_write_5m ?? null,
    cache_write_1h: r.cache_write_1h ?? null,
  });
}

// ---------- OTLP ----------

/** Decode an OTLP AnyValue to a JS primitive (only scalar types are needed). */
export function anyValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return v.intValue; // number or string
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  return undefined;
}

function otlpCount(v) {
  if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-9) v = Math.round(v);
  return toCount(v);
}

class GapTally {
  constructor() { this.m = new Map(); }
  add(kind, detail, n = 1) {
    const g = this.m.get(kind) || { kind, count: 0, detail };
    g.count += n;
    this.m.set(kind, g);
  }
  list() { return [...this.m.values()]; }
}

/**
 * Convert an OTLP/HTTP JSON logs body into records.
 * Returns { records, gaps:[{kind,count,detail}], invalid } — invalid=true when the body is not OTLP logs.
 */
export function fromOtlpLogs(body, { source = 'local', now = Date.now() } = {}) {
  const records = [];
  const gaps = new GapTally();
  if (!body || typeof body !== 'object' || !Array.isArray(body.resourceLogs)) {
    return { records, gaps: [], invalid: true };
  }
  for (const rl of body.resourceLogs) {
    const scopeLogs = rl && Array.isArray(rl.scopeLogs) ? rl.scopeLogs : [];
    for (const sl of scopeLogs) {
      const logRecords = sl && Array.isArray(sl.logRecords) ? sl.logRecords : [];
      for (const lr of logRecords) {
        if (!lr || typeof lr !== 'object') continue;
        // Pick only the attributes we need; never keep the rest.
        const want = {};
        if (Array.isArray(lr.attributes)) {
          for (const a of lr.attributes) {
            if (!a || typeof a.key !== 'string') continue;
            switch (a.key) {
              case 'event.name': case 'event.timestamp': case 'request_id': case 'model': case 'session.id':
              case 'input_tokens': case 'output_tokens': case 'cache_read_tokens': case 'cache_creation_tokens':
              case 'cache_creation_5m_tokens': case 'cache_creation_1h_tokens':
                want[a.key] = anyValue(a.value);
                break;
              default: break;
            }
          }
        }
        const bodyName = lr.body && typeof lr.body === 'object' ? lr.body.stringValue : undefined;
        const isApi = API_REQUEST_NAMES.has(want['event.name']) || bodyName === 'claude_code.api_request';
        if (!isApi) continue;
        const reqId = want.request_id;
        if (typeof reqId !== 'string' || !reqId) {
          gaps.add('partial_record', 'api_request event without request_id (not counted)');
          continue;
        }
        const c = {
          input: otlpCount(want.input_tokens),
          output: otlpCount(want.output_tokens),
          cache_write: otlpCount(want.cache_creation_tokens),
          cache_read: otlpCount(want.cache_read_tokens),
          w5: otlpCount(want.cache_creation_5m_tokens),
          w1: otlpCount(want.cache_creation_1h_tokens),
        };
        const core = [c.input, c.output, c.cache_write, c.cache_read];
        if (core.some((x) => Number.isNaN(x)) || core.every((x) => x === undefined)) {
          gaps.add('partial_record', 'api_request event with missing or invalid token counts');
          continue;
        }
        let ts = NaN;
        if (typeof want['event.timestamp'] === 'string') ts = Date.parse(want['event.timestamp']);
        if (!Number.isFinite(ts) && lr.timeUnixNano != null) {
          try { ts = Number(BigInt(String(lr.timeUnixNano)) / 1000000n); } catch { ts = NaN; }
          if (ts <= 0) ts = NaN;
        }
        if (!Number.isFinite(ts)) ts = now;
        records.push(fixBreakdown({
          rid: rid(reqId),
          ts: Math.trunc(ts),
          source,
          origin: 'otel',
          model: cleanModel(want.model),
          session: sessionHash(want['session.id']),
          input: c.input ?? 0,
          output: c.output ?? 0,
          cache_write: c.cache_write ?? 0,
          cache_read: c.cache_read ?? 0,
          cache_write_5m: Number.isNaN(c.w5) ? null : (c.w5 ?? null),
          cache_write_1h: Number.isNaN(c.w1) ? null : (c.w1 ?? null),
        }));
      }
    }
  }
  return { records, gaps: gaps.list(), invalid: false };
}

// ---------- Transcripts ----------

/**
 * Convert one parsed transcript line.
 * Returns null (not a usage line), { record } or { gap: 'partial_record'|'unsupported_format' }.
 */
export function fromTranscriptLine(obj, { source = 'local' } = {}) {
  if (!obj || typeof obj !== 'object' || obj.type !== 'assistant') return null;
  const msg = obj.message;
  if (!msg || typeof msg !== 'object') return { gap: 'unsupported_format' };
  if (msg.model === '<synthetic>') return null; // locally generated, no API call
  const u = msg.usage;
  if (!u || typeof u !== 'object') return { gap: 'unsupported_format' };
  const reqId = obj.requestId;
  if (typeof reqId !== 'string' || !reqId) return { gap: 'partial_record' };
  const input = toCount(u.input_tokens);
  const output = toCount(u.output_tokens);
  const cw = toCount(u.cache_creation_input_tokens);
  const cr = toCount(u.cache_read_input_tokens);
  const core = [input, output, cw, cr];
  if (core.some((x) => Number.isNaN(x)) || input === undefined || output === undefined) {
    return { gap: 'unsupported_format' };
  }
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
  const w5 = toCount(cc.ephemeral_5m_input_tokens);
  const w1 = toCount(cc.ephemeral_1h_input_tokens);
  let ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return { gap: 'unsupported_format' };
  return {
    record: fixBreakdown({
      rid: rid(reqId),
      ts: Math.trunc(ts),
      source,
      origin: 'transcript',
      model: cleanModel(msg.model),
      session: sessionHash(obj.sessionId),
      input,
      output,
      cache_write: cw ?? 0,
      cache_read: cr ?? 0,
      cache_write_5m: Number.isNaN(w5) ? null : (w5 ?? null),
      cache_write_1h: Number.isNaN(w1) ? null : (w1 ?? null),
    }),
  };
}
