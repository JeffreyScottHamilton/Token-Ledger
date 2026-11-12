// summary.json (atomic) and the combined view used by the CLI, collector and mod.
import fs from 'node:fs';
import { writeFileAtomic, readJson, localLabel } from './paths.mjs';

export const REMOTE_FRESH_MS = 15 * 60 * 1000;

export function writeSummaryFile(file, summary) {
  writeFileAtomic(file, JSON.stringify(summary, null, 2) + '\n');
}

export function readSummaryFile(file) {
  const s = readJson(file);
  return s && typeof s === 'object' && s.schema === 1 ? s : null;
}

export function unavailableSummary(now = Date.now()) {
  return { schema: 1, status: 'unavailable', total: null, requests: null, breakdown: null, firstRecordedAt: null,
    updatedAt: null, generatedAt: new Date(now).toISOString(), sources: [], gaps: [], authority: [] };
}

/**
 * Build the summary for this node. On a paired secondary (config.relay), show the primary's combined total when a
 * remote summary is available (plus records still waiting in the outbox); stale if the primary is unreachable.
 */
export function buildSummary(store, paths, config, now = Date.now()) {
  const label = localLabel(config);
  const local = store.summary({ localLabel: label, now });
  if (!config || !config.relay) return local;
  const rs = readJson(paths.remoteSummary);
  const pending = store.outboxStats();
  if (!rs || !rs.summary || rs.summary.schema !== 1 || typeof rs.summary.total !== 'number') {
    local.gaps.push({ source: label, kind: 'unconnected', count: 1,
      detail: 'paired primary not reached yet; showing this computer only' });
    local.relay = { pending: pending.count, fetchedAt: null, reachable: false };
    return local;
  }
  const r = JSON.parse(JSON.stringify(rs.summary));
  const fresh = rs.reachable === true && now - Number(rs.fetchedAt) < REMOTE_FRESH_MS;
  r.total += pending.total;
  r.requests = (r.requests || 0) + pending.count;
  if (r.breakdown) {
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) {
      r.breakdown[k] = (r.breakdown[k] || 0) + pending[k];
    }
  }
  if (fresh) {
    r.status = r.total > 0 ? 'ok' : 'empty';
    r.generatedAt = new Date(now).toISOString();
  } else {
    r.status = 'stale';
    r.generatedAt = new Date(Number(rs.fetchedAt) || now).toISOString();
  }
  if (Array.isArray(r.sources)) {
    for (const s of r.sources) if (s.label === label) s.kind = 'local';
  }
  r.relay = { pending: pending.count, fetchedAt: new Date(Number(rs.fetchedAt)).toISOString(), reachable: !!rs.reachable };
  return r;
}

export function writeRemoteSummary(paths, data) {
  writeFileAtomic(paths.remoteSummary, JSON.stringify(data) + '\n');
}

export function removeIfExists(file) {
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

// ---------- account page row ----------

export const ACCOUNT_URL_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{6,80}$/;

/**
 * This computer's row for the private account page (config.account): its own records only, so totals that
 * arrived from paired computers are never counted twice. Allowlisted fields only.
 */
export function buildAccountRow(store, config, now = Date.now()) {
  const a = config && config.account;
  if (!a || typeof a.url !== 'string' || !ACCOUNT_URL_RE.test(a.url) || typeof a.device !== 'string') return null;
  const t = store.labelTotals(localLabel(config));
  return {
    url: a.url,
    device: a.device,
    data: {
      app: 'token-ledger', v: 1,
      label: String(a.label || localLabel(config)).slice(0, 60),
      kind: a.kind === 'cloud' ? 'cloud' : 'computer',
      total: t.total, input: t.input, output: t.output, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead,
      requests: t.requests, firstAt: t.firstAt, lastAt: t.lastAt,
      updatedAt: new Date(now).toISOString(),
    },
  };
}

/** Write account-row.json next to summary.json, or remove it when account sync is off. */
export function writeAccountRow(store, paths, config, now = Date.now()) {
  const row = buildAccountRow(store, config, now);
  if (!row) { try { fs.unlinkSync(paths.accountRow); } catch { /* none */ } return null; }
  writeFileAtomic(paths.accountRow, JSON.stringify(row, null, 2) + '\n');
  return row;
}
