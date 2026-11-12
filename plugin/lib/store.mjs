// SQLite ledger (node:sqlite). Only §3 allowlisted fields are ever written to `records`/`outbox`.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { ensureHome, IS_WIN } from './paths.mjs';
import { recordTotal } from './normalize.mjs';

const FIELDS = ['rid', 'ts', 'source', 'origin', 'model', 'session', 'input', 'output', 'cache_write', 'cache_read',
  'cache_write_5m', 'cache_write_1h', 'received_at'];
export const RECORD_FIELDS = FIELDS;
const REPORTING_WINDOW_MS = 24 * 3600 * 1000;

const MIGRATIONS = [
  // v1
  `CREATE TABLE records (
     rid TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL, origin TEXT NOT NULL, model TEXT NOT NULL,
     session TEXT, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_write INTEGER NOT NULL,
     cache_read INTEGER NOT NULL, cache_write_5m INTEGER, cache_write_1h INTEGER, received_at INTEGER NOT NULL);
   CREATE INDEX records_source ON records(source);
   CREATE TABLE tokens (hash TEXT PRIMARY KEY, label TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('ingest','read')),
     kind TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER);
   CREATE INDEX tokens_label ON tokens(label);
   CREATE TABLE sources (label TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
   CREATE TABLE gaps (source TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, detail TEXT, last_at INTEGER,
     PRIMARY KEY (source, kind));
   CREATE TABLE diagnostics (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE import_state (file_key TEXT PRIMARY KEY, size INTEGER NOT NULL, offset INTEGER NOT NULL, mtime INTEGER);
   CREATE TABLE outbox (rid TEXT PRIMARY KEY, record TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);`,
];

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

export function openStore(dbPath, { create = true } = {}) {
  if (!create && !fs.existsSync(dbPath)) {
    const e = new Error('ledger not found');
    e.code = 'ENOLEDGER';
    throw e;
  }
  ensureHome(dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  if (!IS_WIN) { try { fs.chmodSync(dbPath, 0o600); } catch { /* ignore */ } }
  return new Store(db, dbPath);
}

export class Store {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA secure_delete = ON');
    this.migrate();
    this.st = {
      insert: db.prepare(`INSERT INTO records (${FIELDS.join(',')}) VALUES (${FIELDS.map(() => '?').join(',')})
        ON CONFLICT(rid) DO NOTHING`),
      existing: db.prepare('SELECT input, output, cache_write, cache_read FROM records WHERE rid = ?'),
      hasRid: db.prepare('SELECT 1 AS x FROM records WHERE rid = ?'),
      outbox: db.prepare('INSERT INTO outbox (rid, record) VALUES (?, ?) ON CONFLICT(rid) DO NOTHING'),
      gap: db.prepare(`INSERT INTO gaps (source, kind, count, detail, last_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source, kind) DO UPDATE SET count = count + excluded.count,
        detail = COALESCE(excluded.detail, detail), last_at = excluded.last_at`),
      diag: db.prepare(`INSERT INTO diagnostics (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)`),
    };
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }

  /**
   * Insert records in ONE transaction. Options: gaps [{kind,count,detail}] + gapSource recorded in the same
   * transaction; outbox=true enqueues accepted records for relay.
   */
  insertRecords(records, { gaps = [], gapSource = 'local', outbox = false, now = Date.now() } = {}) {
    let accepted = 0, duplicates = 0, conflicts = 0;
    const acceptedRecords = [];
    this.tx(() => {
      for (const r of records) {
        const row = [r.rid, r.ts, r.source, r.origin, r.model, r.session ?? null, r.input, r.output, r.cache_write,
          r.cache_read, r.cache_write_5m ?? null, r.cache_write_1h ?? null, now];
        const res = this.st.insert.run(...row);
        if (res.changes === 1) {
          accepted++;
          acceptedRecords.push(r);
          if (outbox) this.st.outbox.run(r.rid, JSON.stringify(pick(r)));
        } else {
          const e = this.st.existing.get(r.rid);
          if (e && (e.input !== r.input || e.output !== r.output || e.cache_write !== r.cache_write ||
              e.cache_read !== r.cache_read)) conflicts++;
          else duplicates++;
        }
      }
      if (conflicts) this.st.diag.run('conflicts', String(conflicts));
      for (const g of gaps) if (g.count > 0) this.st.gap.run(gapSource, g.kind, g.count, g.detail ?? null, now);
    });
    return { accepted, duplicates, conflicts, acceptedRecords };
  }

  addGaps(source, gaps, now = Date.now()) {
    if (!gaps.length) return;
    this.tx(() => { for (const g of gaps) if (g.count > 0) this.st.gap.run(source, g.kind, g.count, g.detail ?? null, now); });
  }

  hasRecord(rid) { return !!this.st.hasRid.get(rid); }

  bumpDiag(key, n = 1) { this.st.diag.run(key, String(n)); }

  diagnostics() {
    const out = {};
    for (const r of this.db.prepare('SELECT key, value FROM diagnostics').all()) out[r.key] = r.value;
    return out;
  }

  // ---- sources / tokens ----
  upsertSource(label, kind, now = Date.now()) {
    this.db.prepare(`INSERT INTO sources (label, kind, created_at) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET kind = excluded.kind, revoked_at = NULL`).run(label, kind, now);
  }
  listSources() { return this.db.prepare('SELECT label, kind, created_at, revoked_at FROM sources ORDER BY label').all(); }
  getSource(label) { return this.db.prepare('SELECT label, kind, created_at, revoked_at FROM sources WHERE label = ?').get(label); }
  insertToken(hash, label, scope, kind, now = Date.now()) {
    this.db.prepare('INSERT INTO tokens (hash, label, scope, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash, label, scope, kind ?? null, now);
  }
  tokenByHash(hash) {
    return this.db.prepare('SELECT hash, label, scope, kind, revoked_at FROM tokens WHERE hash = ?').get(hash);
  }
  tokenCounts() {
    return this.db.prepare(`SELECT label, scope, COUNT(*) AS n, SUM(revoked_at IS NULL) AS active FROM tokens
      GROUP BY label, scope`).all();
  }
  revokeLabel(label, now = Date.now()) {
    return this.tx(() => {
      const t = this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL').run(now, label);
      const s = this.db.prepare('UPDATE sources SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL').run(now, label);
      return { tokens: Number(t.changes), source: Number(s.changes) };
    });
  }

  // ---- import state ----
  getImportState(key) { return this.db.prepare('SELECT size, offset, mtime FROM import_state WHERE file_key = ?').get(key); }
  setImportState(key, size, offset, mtime) {
    this.db.prepare(`INSERT INTO import_state (file_key, size, offset, mtime) VALUES (?, ?, ?, ?)
      ON CONFLICT(file_key) DO UPDATE SET size = excluded.size, offset = excluded.offset, mtime = excluded.mtime`)
      .run(key, size, offset, mtime);
  }

  // ---- outbox ----
  outboxBatch(limit = 500) {
    return this.db.prepare('SELECT rid, record, attempts FROM outbox ORDER BY rowid LIMIT ?').all(limit);
  }
  outboxDelete(rids) {
    if (!rids.length) return;
    const st = this.db.prepare('DELETE FROM outbox WHERE rid = ?');
    this.tx(() => { for (const r of rids) st.run(r); });
  }
  outboxAttempt(rids) {
    const st = this.db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE rid = ?');
    this.tx(() => { for (const r of rids) st.run(r); });
  }
  outboxStats() {
    const rows = this.db.prepare('SELECT record FROM outbox').all();
    const s = { count: 0, total: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    for (const { record } of rows) {
      try {
        const r = JSON.parse(record);
        s.count++; s.total += recordTotal(r);
        s.input += r.input; s.output += r.output; s.cacheWrite += r.cache_write; s.cacheRead += r.cache_read;
        s.cacheWrite5m += r.cache_write_5m || 0; s.cacheWrite1h += r.cache_write_1h || 0;
      } catch { /* ignore */ }
    }
    return s;
  }
  /** Enqueue every stored record for relay (used when pairing an existing ledger). */
  backfillOutbox() {
    const rows = this.db.prepare(`SELECT ${FIELDS.join(',')} FROM records`).all();
    this.tx(() => { for (const r of rows) this.st.outbox.run(r.rid, JSON.stringify(pick(r))); });
    return rows.length;
  }

  /** Totals of one source label only (this computer's own records), for the account page row. */
  labelTotals(label) {
    const a = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(input),0) AS i, COALESCE(SUM(output),0) AS o,
      COALESCE(SUM(cache_write),0) AS cw, COALESCE(SUM(cache_read),0) AS cr, MIN(ts) AS first, MAX(received_at) AS updated
      FROM records WHERE source = ?`).get(label);
    const input = Number(a.i), output = Number(a.o), cacheWrite = Number(a.cw), cacheRead = Number(a.cr);
    return { requests: Number(a.n), input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead,
      firstAt: a.first == null ? null : new Date(Number(a.first)).toISOString(),
      lastAt: a.updated == null ? null : new Date(Number(a.updated)).toISOString() };
  }

  // ---- summary (SPEC §4), SQL aggregates only ----
  summary({ localLabel = 'local', now = Date.now() } = {}) {
    const a = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(input),0) AS i, COALESCE(SUM(output),0) AS o,
      COALESCE(SUM(cache_write),0) AS cw, COALESCE(SUM(cache_read),0) AS cr,
      COALESCE(SUM(cache_write_5m),0) AS w5, COALESCE(SUM(cache_write_1h),0) AS w1,
      MIN(ts) AS first, MAX(received_at) AS updated FROM records`).get();
    const per = this.db.prepare(`SELECT source, COUNT(*) AS n, SUM(input + output + cache_write + cache_read) AS total,
      MIN(ts) AS firstAt, MAX(ts) AS lastAt, MAX(received_at) AS lastRecv FROM records GROUP BY source`).all();
    const srcRows = this.listSources();
    const meta = new Map(srcRows.map((s) => [s.label, s]));
    const labels = new Set([...per.map((p) => p.source), ...srcRows.map((s) => s.label)]);
    const perMap = new Map(per.map((p) => [p.source, p]));
    const sources = [...labels].sort().map((label) => {
      const p = perMap.get(label);
      const m = meta.get(label);
      const kind = m ? m.kind : (label === localLabel ? 'local' : 'remote');
      let status = 'never';
      if (m && m.revoked_at) status = 'revoked';
      else if (p) status = now - Number(p.lastRecv) <= REPORTING_WINDOW_MS ? 'reporting' : 'silent';
      return {
        label, kind, status,
        total: p ? Number(p.total) : 0,
        requests: p ? Number(p.n) : 0,
        firstAt: p ? iso(p.firstAt) : null,
        lastAt: p ? iso(p.lastAt) : null,
      };
    });
    const gaps = this.db.prepare('SELECT source, kind, count, detail FROM gaps ORDER BY source, kind').all()
      .map((g) => ({ source: g.source, kind: g.kind, count: Number(g.count), detail: g.detail || '' }));
    const authority = [{ scope: localLabel, authoritative: 'otel+transcript (request_id match)' }];
    for (const s of sources) if (s.kind !== 'local') authority.push({ scope: s.label, authoritative: 'relay (ingest token)' });
    const n = Number(a.n);
    const breakdown = { input: Number(a.i), output: Number(a.o), cacheWrite: Number(a.cw), cacheRead: Number(a.cr),
      cacheWrite5m: Number(a.w5), cacheWrite1h: Number(a.w1) };
    return {
      schema: 1,
      status: n === 0 ? 'empty' : 'ok',
      total: breakdown.input + breakdown.output + breakdown.cacheWrite + breakdown.cacheRead,
      requests: n,
      breakdown,
      firstRecordedAt: iso(a.first),
      updatedAt: iso(a.updated),
      generatedAt: iso(now),
      sources,
      gaps,
      authority,
    };
  }

  // ---- export / erase ----
  exportAll(format = 'json') {
    const rows = this.db.prepare(`SELECT ${FIELDS.join(',')} FROM records ORDER BY ts, rid`).all();
    if (format === 'csv') {
      const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      return [FIELDS.join(','), ...rows.map((r) => FIELDS.map((f) => esc(r[f])).join(','))].join('\n') + '\n';
    }
    if (format !== 'json') throw new Error(`unknown export format: ${format}`);
    return JSON.stringify({ schema: 1, exportedAt: new Date().toISOString(),
      records: rows.map((r) => { const o = {}; for (const f of FIELDS) o[f] = r[f]; return o; }) }, null, 2) + '\n';
  }

  /** Delete ledger data; keeps tokens, sources and config. */
  erase() {
    this.tx(() => {
      for (const t of ['records', 'gaps', 'import_state', 'outbox', 'diagnostics']) this.db.exec(`DELETE FROM ${t}`);
    });
    try { this.db.exec('VACUUM'); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  }
}

function pick(r) {
  const o = {};
  for (const f of FIELDS) if (f !== 'received_at') o[f] = r[f] ?? null;
  return o;
}
