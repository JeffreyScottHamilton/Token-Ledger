// Transcript import/sync (SPEC §6.2). Streams files chunk by chunk, keeps only allowlisted usage fields.
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fromTranscriptLine } from './normalize.mjs';

const GAP_DETAIL = {
  unsupported_format: 'transcript entries with an unrecognized shape (not counted)',
  partial_record: 'transcript usage without requestId (not counted)',
};

export function fileKey(absPath) {
  return createHash('sha256').update(resolve(absPath), 'utf8').digest('hex');
}

/** Recursively list *.jsonl files (includes <session>/subagents/). Symlinks are not followed. */
export function listJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out.sort();
}

/**
 * Stream complete lines of `file` from byte `start`. Calls onLine(text, lineStartOffset).
 * Returns { consumed } = bytes of complete lines read (including newlines) and `tail` (trailing partial line).
 */
async function streamLines(file, start, onLine) {
  let consumed = 0;
  let carry = Buffer.alloc(0);
  const stream = fs.createReadStream(file, { start });
  for await (const chunk of stream) {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let pos = 0;
    for (;;) {
      const nl = buf.indexOf(10, pos);
      if (nl === -1) break;
      const line = buf.toString('utf8', pos, nl);
      onLine(line, start + consumed);
      consumed += nl + 1 - pos;
      pos = nl + 1;
    }
    carry = pos < buf.length ? Buffer.from(buf.subarray(pos)) : Buffer.alloc(0);
    buf = null;
  }
  return { consumed, tail: carry };
}

function emptyReport() {
  return { files: 0, dateRange: { first: null, last: null }, eligible: 0, alreadyInLedger: 0, imported: 0,
    skipped: { unsupported_format: 0, partial_record: 0, malformed_json: 0 } };
}

/**
 * Core pass over transcript files.
 *  mode 'import': every file from byte 0 (gaps only counted for bytes past the stored offset, so re-imports are idempotent)
 *  mode 'sync':   from the stored offset; truncated/rotated files (size < offset) restart at 0
 *  mode 'scan':   from 0, read-only
 */
async function pass({ store, projectsDir, since, source = 'local', mode }) {
  const report = emptyReport();
  const byRid = new Map();
  const gapsNew = { unsupported_format: 0, partial_record: 0 };
  const states = [];
  const sinceMs = since ? Date.parse(since) : NaN;
  const files = listJsonl(projectsDir);
  for (const file of files) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const key = fileKey(file);
    const prev = store && mode !== 'scan' ? store.getImportState(key) : null;
    let start = 0;
    if (mode === 'sync' && prev) {
      if (st.size < prev.offset) start = 0;
      else if (st.size === prev.offset) { report.files++; continue; }
      else start = prev.offset;
    }
    const gapFrom = prev && st.size >= prev.offset ? prev.offset : 0;
    report.files++;
    const handle = (line, at, final = false) => {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch {
        report.skipped.malformed_json++;
        if (at >= gapFrom && !final) gapsNew.unsupported_format++;
        return;
      }
      const r = fromTranscriptLine(obj, { source });
      obj = null;
      if (!r) return;
      if (r.gap) {
        report.skipped[r.gap]++;
        if (at >= gapFrom) gapsNew[r.gap]++;
        return;
      }
      if (Number.isFinite(sinceMs) && r.record.ts < sinceMs) return;
      byRid.set(r.record.rid, r.record); // last line per requestId wins
    };
    let res;
    try { res = await streamLines(file, start, handle); } catch { continue; }
    // A trailing partial line is only parsed by full imports/scans (it may be a line still being written).
    if (mode !== 'sync' && res.tail.length) handle(res.tail.toString('utf8'), start + res.consumed, true);
    states.push({ key, size: st.size, offset: Math.max(start + res.consumed, prev ? Math.min(prev.offset, st.size) : 0),
      mtime: Math.trunc(st.mtimeMs) });
  }
  const records = [...byRid.values()];
  report.eligible = records.length;
  for (const r of records) {
    if (report.dateRange.first === null || r.ts < report.dateRange.first) report.dateRange.first = r.ts;
    if (report.dateRange.last === null || r.ts > report.dateRange.last) report.dateRange.last = r.ts;
  }
  if (store) for (const r of records) if (store.hasRecord(r.rid)) report.alreadyInLedger++;
  report.dateRange.first = report.dateRange.first === null ? null : new Date(report.dateRange.first).toISOString();
  report.dateRange.last = report.dateRange.last === null ? null : new Date(report.dateRange.last).toISOString();
  const gaps = Object.entries(gapsNew).filter(([, n]) => n > 0).map(([kind, count]) => ({ kind, count, detail: GAP_DETAIL[kind] }));
  return { report, records, gaps, states };
}

function commitPass(store, { records, gaps, states }, { source, outbox }) {
  const res = store.insertRecords(records, { gaps, gapSource: source, outbox });
  store.tx(() => { for (const s of states) store.setImportState(s.key, s.size, s.offset, s.mtime); });
  return res;
}

/** Read-only scan; `store` (optional) is used to count records already in the ledger. */
export async function scanTranscripts({ projectsDir, since, store = null, source = 'local' } = {}) {
  const { report } = await pass({ store, projectsDir, since, source, mode: 'scan' });
  return report;
}

/** Full import. dryRun=true writes nothing. */
export async function importTranscripts({ store, projectsDir, since, dryRun = false, source = 'local', outbox = false }) {
  if (dryRun) return scanTranscripts({ projectsDir, since, store, source });
  const p = await pass({ store, projectsDir, since, source, mode: 'import' });
  const r = commitPass(store, p, { source, outbox });
  p.report.imported = r.accepted;
  p.report.conflicts = r.conflicts;
  return p.report;
}

/** Incremental import using stored byte offsets (complete lines only). */
export async function syncTranscripts({ store, projectsDir, since, source = 'local', outbox = false }) {
  const p = await pass({ store, projectsDir, since, source, mode: 'sync' });
  const r = commitPass(store, p, { source, outbox });
  p.report.imported = r.accepted;
  p.report.conflicts = r.conflicts;
  return p.report;
}
