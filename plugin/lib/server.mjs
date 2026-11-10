// Collector (SPEC §5): OTLP/HTTP JSON logs in, SQLite ledger, summary.json out, optional relay + forward.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ledgerPaths, ensureHome, readConfig, readJson, localLabel, collectorPort, VERSION, IS_WIN } from './paths.mjs';
import { openStore } from './store.mjs';
import { fromOtlpLogs, validateRecord } from './normalize.mjs';
import { verifyToken, bearer } from './tokens.mjs';
import { buildSummary, writeSummaryFile, writeRemoteSummary } from './summary-file.mjs';

export const BODY_CAP = 1024 * 1024;
export const MAX_RECORDS = 5000;
const RELAY_BATCH = 500;
const MAX_BACKOFF_MS = 60_000;

export function isLoopbackHost(h) {
  if (typeof h !== 'string') return false;
  const x = h.replace(/^\[|\]$/g, '').toLowerCase();
  return x === 'localhost' || x === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(x);
}

/** Host header (DNS-rebinding guard): must name a loopback host. */
function hostHeaderOk(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  let h = hostHeader.trim();
  if (h.startsWith('[')) h = h.slice(0, h.indexOf(']') + 1);
  else h = h.replace(/:\d+$/, '');
  return isLoopbackHost(h);
}

function send(res, status, obj, extra = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length']);
    if (Number.isFinite(cl) && cl > cap) return reject(new HttpError(413, { error: 'payload_too_large', limit: cap }));
    const chunks = [];
    let size = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > cap) {
        done = true;
        chunks.length = 0;
        req.pause();
        return reject(new HttpError(413, { error: 'payload_too_large', limit: cap }));
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function decode(buf, encoding) {
  const enc = String(encoding || 'identity').toLowerCase().trim();
  if (enc === 'identity' || enc === '') return buf;
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf, { maxOutputLength: BODY_CAP });
    if (enc === 'deflate') return zlib.inflateSync(buf, { maxOutputLength: BODY_CAP });
  } catch (e) {
    if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) {
      throw new HttpError(413, { error: 'payload_too_large', limit: BODY_CAP });
    }
    throw new HttpError(400, { error: 'bad_encoding' });
  }
  throw new HttpError(415, { error: 'unsupported_encoding' });
}

function checkJsonType(req) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/json') return;
  if (ct.includes('protobuf')) {
    throw new HttpError(415, { error: 'unsupported_media_type',
      message: 'OTLP protobuf is not supported; set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json' });
  }
  throw new HttpError(415, { error: 'unsupported_media_type', message: 'Content-Type must be application/json' });
}

/** Minimal JSON HTTP(S) client used by relay and forwarder. */
export function requestJson(urlStr, { method = 'GET', body, token, ca, headers = {}, timeoutMs = 10_000, raw } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return reject(new Error('unsupported protocol'));
    const payload = raw !== undefined ? raw : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { Accept: 'application/json', ...headers };
    if (payload) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = payload.length; }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = mod.request(u, { method, headers: h, ca: ca || undefined, timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 4 * BODY_CAP) chunks.push(c); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

/**
 * Create the collector core. Call listen() one or more times (loopback HTTP and/or TLS remote listener).
 * Options: home, relayIntervalMs, remoteSummaryIntervalMs, logToStderr.
 */
export function createCollector({ home, relayIntervalMs = 2000, remoteSummaryIntervalMs = 30_000, logToStderr = false } = {}) {
  const paths = ledgerPaths(home);
  ensureHome(paths.home);
  const store = openStore(paths.db);
  const listeners = [];
  let closed = false;

  // ---- logging (counts only; never bodies, headers, tokens, addresses) ----
  function log(level, msg) {
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    try {
      try { if (fs.statSync(paths.log).size > 5 * 1024 * 1024) fs.renameSync(paths.log, paths.log + '.1'); } catch { /* none */ }
      fs.appendFileSync(paths.log, line, { mode: 0o600 });
    } catch { /* ignore */ }
    if (logToStderr) process.stderr.write(line);
  }

  // ---- config (cached ≤1s) ----
  let cfgCache = null, cfgAt = 0;
  function config() {
    if (!cfgCache || Date.now() - cfgAt > 1000) { cfgCache = readConfig(paths); cfgAt = Date.now(); }
    return cfgCache;
  }

  // ---- summary.json, debounced ≤1/s ----
  let lastWrite = 0, sumTimer = null;
  function writeSummaryNow() {
    if (sumTimer) { clearTimeout(sumTimer); sumTimer = null; }
    lastWrite = Date.now();
    try { writeSummaryFile(paths.summary, buildSummary(store, paths, config())); } catch (e) { log('error', `summary write failed code=${e.code || 'unknown'}`); }
  }
  function scheduleSummary() {
    if (sumTimer || closed) return;
    const delay = Math.max(0, lastWrite + 1000 - Date.now());
    sumTimer = setTimeout(() => { sumTimer = null; writeSummaryNow(); }, delay);
  }

  // ---- forwarder (fan-out to a pre-existing logs exporter) ----
  function forward(raw, encoding) {
    const fwd = config().forward;
    if (!fwd || typeof fwd.logsEndpoint !== 'string') return;
    const headers = { 'Content-Type': 'application/json' };
    if (fwd.headers && typeof fwd.headers === 'object') for (const [k, v] of Object.entries(fwd.headers)) if (typeof v === 'string') headers[k] = v;
    if (encoding) headers['Content-Encoding'] = encoding;
    requestJson(fwd.logsEndpoint, { method: 'POST', raw, headers, timeoutMs: 5000 })
      .then((r) => { if (r.status < 200 || r.status >= 300) { store.bumpDiag('forward_failures'); log('warn', `forward failed status=${r.status}`); } })
      .catch(() => { try { store.bumpDiag('forward_failures'); } catch { /* closed */ } log('warn', 'forward failed status=network'); });
  }

  // ---- relay (secondary → primary) ----
  let relayBusy = false, backoff = 0, nextRelayAt = 0, lastRemoteFetch = 0;
  function relayCa(relay) {
    if (!relay.caFile) return undefined;
    try { return fs.readFileSync(relay.caFile); } catch { return undefined; }
  }
  async function fetchRemoteSummary(relay) {
    const prev = readJson(paths.remoteSummary) || {};
    lastRemoteFetch = Date.now();
    try {
      const r = await requestJson(relay.url.replace(/\/+$/, '') + '/api/v1/summary',
        { token: relay.readToken, ca: relayCa(relay), timeoutMs: 5000 });
      if (r.status === 200 && r.json && r.json.schema === 1) {
        writeRemoteSummary(paths, { fetchedAt: Date.now(), reachable: true, summary: r.json });
      } else {
        writeRemoteSummary(paths, { ...prev, reachable: false, lastStatus: r.status });
        log('warn', `remote summary failed status=${r.status}`);
      }
    } catch {
      writeRemoteSummary(paths, { ...prev, reachable: false, lastStatus: 'network' });
    }
    scheduleSummary();
  }
  async function relayTick(force = false) {
    if (relayBusy || closed) return;
    const relay = config().relay;
    if (!relay || typeof relay.url !== 'string') return;
    if (!force && Date.now() < nextRelayAt) return;
    relayBusy = true;
    let sent = 0;
    try {
      for (;;) {
        const batch = store.outboxBatch(RELAY_BATCH);
        if (!batch.length) break;
        const rids = batch.map((b) => b.rid);
        let r;
        try {
          r = await requestJson(relay.url.replace(/\/+$/, '') + '/ingest/v1/records', {
            method: 'POST', body: { records: batch.map((b) => JSON.parse(b.record)) }, token: relay.ingestToken,
            ca: relayCa(relay), timeoutMs: 10_000 });
        } catch { r = { status: 'network' }; }
        if (closed) return;
        if (typeof r.status === 'number' && r.status >= 200 && r.status < 300) {
          store.outboxDelete(rids);
          sent += rids.length;
        } else {
          store.outboxAttempt(rids);
          backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : relayIntervalMs);
          nextRelayAt = Date.now() + backoff;
          log('warn', `relay failed status=${r.status} pending=${batch.length} retry_ms=${backoff}`);
          break;
        }
      }
      if (sent) { backoff = 0; nextRelayAt = 0; log('info', `relay sent=${sent}`); }
      if (sent || Date.now() - lastRemoteFetch >= remoteSummaryIntervalMs) await fetchRemoteSummary(relay);
    } finally {
      relayBusy = false;
    }
  }
  const relayTimer = setInterval(() => { relayTick().catch(() => {}); }, relayIntervalMs);
  relayTimer.unref();

  // ---- ingest ----
  function commit(records, gaps, label) {
    if (records.length > MAX_RECORDS) throw new HttpError(413, { error: 'too_many_records', limit: MAX_RECORDS });
    const r = store.insertRecords(records, { gaps, gapSource: label, outbox: !!config().relay });
    const gapCount = gaps.reduce((a, g) => a + g.count, 0);
    log('info', `batch accepted=${r.accepted} dup=${r.duplicates} conflicts=${r.conflicts} gaps=${gapCount}`);
    scheduleSummary();
    if (r.accepted && config().relay) setImmediate(() => relayTick(true).catch(() => {}));
    return { ...r, gapCount };
  }

  async function handle(req, res, mode) {
    const url = new URL(req.url || '/', 'http://collector');
    const path = url.pathname;
    if (req.headers.origin !== undefined) return send(res, 403, { error: 'forbidden' });
    if (mode.loopback && !hostHeaderOk(req.headers.host)) return send(res, 403, { error: 'forbidden' });

    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, version: VERSION });

    if (req.method === 'GET' && path === '/api/v1/summary') {
      if (!mode.loopback && !verifyToken(store, bearer(req), 'read')) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, buildSummary(store, paths, config()));
    }

    if (req.method === 'POST' && (path === '/v1/logs' || path === '/ingest/v1/records')) {
      let label;
      if (path === '/ingest/v1/records' || !mode.loopback) {
        label = verifyToken(store, bearer(req), 'ingest');
        if (!label) return send(res, 401, { error: 'unauthorized' });
      } else {
        label = localLabel(config());
      }
      checkJsonType(req);
      const raw = await readBody(req, BODY_CAP);
      const encoding = req.headers['content-encoding'];
      const buf = decode(raw, encoding);
      let body;
      try { body = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, { error: 'invalid_json' }); }

      if (path === '/v1/logs') {
        const { records, gaps, invalid } = fromOtlpLogs(body, { source: label });
        if (invalid) throw new HttpError(400, { error: 'not_otlp_logs' });
        commit(records, gaps, label);
        send(res, 200, { partialSuccess: {} });
        forward(raw, encoding);
        return;
      }
      const list = Array.isArray(body) ? body : body && Array.isArray(body.records) ? body.records : null;
      if (!list) throw new HttpError(400, { error: 'expected_records' });
      if (list.length > MAX_RECORDS) throw new HttpError(413, { error: 'too_many_records', limit: MAX_RECORDS });
      const records = [];
      let rejected = 0;
      for (const item of list) {
        const v = validateRecord(item && typeof item === 'object' ? { ...item, source: label, origin: 'relay' } : null);
        if (v) records.push(v); else rejected++;
      }
      const gaps = rejected ? [{ kind: 'partial_record', count: rejected, detail: 'relayed record failed validation (not counted)' }] : [];
      const r = commit(records, gaps, label);
      return send(res, 200, { accepted: r.accepted, duplicates: r.duplicates, conflicts: r.conflicts, rejected });
    }
    return send(res, 404, { error: 'not_found' });
  }

  function onRequest(mode) {
    return (req, res) => {
      handle(req, res, mode).catch((e) => {
        if (e instanceof HttpError) {
          if (e.status === 413) {
            log('warn', 'request rejected status=413');
            res.on('finish', () => setTimeout(() => req.destroy(), 50));
            return send(res, 413, e.body, { Connection: 'close' });
          }
          return send(res, e.status, e.body);
        }
        log('error', `request failed code=${(e && e.code) || 'internal'}`);
        send(res, 500, { error: 'internal' });
      });
    };
  }

  async function listen({ host = '127.0.0.1', port = collectorPort(), tlsCert, tlsKey } = {}) {
    const tls = !!(tlsCert && tlsKey);
    if (!tls && !isLoopbackHost(host)) {
      throw Object.assign(new Error('refusing to bind a non-loopback address without --tls-cert and --tls-key'), { code: 'ENOTLS' });
    }
    const mode = { loopback: !tls };
    const server = tls
      ? https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, onRequest(mode))
      : http.createServer(onRequest(mode));
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    listeners.push(server);
    const actual = server.address().port;
    log('info', `listening mode=${tls ? 'remote-tls' : 'loopback'} port=${actual}`);
    return { server, port: actual, host, remote: tls };
  }

  async function close() {
    if (closed) return;
    clearInterval(relayTimer);
    writeSummaryNow();
    closed = true;
    await Promise.all(listeners.map((s) => new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); })));
    store.close();
    log('info', 'stopped');
  }

  writeSummaryNow();
  return { paths, store, listen, close, relayNow: () => relayTick(true), writeSummaryNow, log, isWindows: IS_WIN };
}

/** Convenience: collector with a single listener. */
export async function startServer({ home, host, port, tlsCert, tlsKey, ...rest } = {}) {
  const c = createCollector({ home, ...rest });
  try {
    const l = await c.listen({ host, port, tlsCert, tlsKey });
    return { ...c, port: l.port, host: l.host, remote: l.remote };
  } catch (e) {
    await c.close();
    throw e;
  }
}
