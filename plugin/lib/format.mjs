// Pure, dependency-free rendering of the ledger summary (SPEC §4).
// Mirrored by the mod in TypeScript: keep this file self-contained.

export const COUNTER_PREFIX = 'Total tracked tokens · ';
export const DISCLAIMER = 'Counts recorded API usage; not a bill or plan-limit meter.';

/** en-US digit grouping without Intl so output is identical everywhere. */
export function groupDigits(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  const neg = n < 0;
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return neg ? '-' + out : out;
}

/** "3h", "12m", "5d", "40s" — relative age of an ISO timestamp. */
export function formatAge(iso, now = Date.now()) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function usable(summary) {
  return !!summary && typeof summary === 'object' && summary.status !== 'unavailable' &&
    typeof summary.total === 'number' && Number.isFinite(summary.total) && summary.total >= 0;
}

/**
 * One-line counter.
 *  ok/empty    -> "Total tracked tokens · 12,483,910"
 *  stale       -> "Total tracked tokens · 12,483,910 (stale · updated 3h ago)"
 *  unavailable -> "Total tracked tokens · unavailable"
 */
export function formatCounter(summary, now = Date.now()) {
  if (!usable(summary)) return COUNTER_PREFIX + 'unavailable';
  const base = COUNTER_PREFIX + groupDigits(summary.total);
  if (summary.status === 'stale') {
    const age = formatAge(summary.generatedAt || summary.updatedAt, now);
    return age ? `${base} (stale · updated ${age} ago)` : `${base} (stale)`;
  }
  return base;
}

function dateOrDash(iso) {
  return typeof iso === 'string' && iso ? iso : '—';
}

/** Multi-line details view. */
export function formatDetails(summary, now = Date.now()) {
  const lines = [formatCounter(summary, now)];
  if (!usable(summary)) {
    lines.push('', 'No ledger summary could be read.', DISCLAIMER);
    return lines.join('\n');
  }
  const b = summary.breakdown || {};
  const n = (v) => groupDigits(typeof v === 'number' ? v : 0);
  lines.push('');
  lines.push(`Status: ${summary.status}`);
  lines.push(`Requests: ${n(summary.requests)}`);
  lines.push(`First recorded: ${dateOrDash(summary.firstRecordedAt)}`);
  const age = formatAge(summary.updatedAt, now);
  lines.push(`Last updated: ${dateOrDash(summary.updatedAt)}${age ? ` (${age} ago)` : ''}`);
  lines.push('');
  lines.push('Breakdown:');
  lines.push(`  Uncached input  ${n(b.input)}`);
  lines.push(`  Output          ${n(b.output)}`);
  lines.push(`  Cache writes    ${n(b.cacheWrite)} (5m ${n(b.cacheWrite5m)} / 1h ${n(b.cacheWrite1h)})`);
  lines.push(`  Cache reads     ${n(b.cacheRead)}`);
  lines.push('');
  const sources = Array.isArray(summary.sources) ? summary.sources : [];
  lines.push('Sources:');
  if (!sources.length) lines.push('  (none)');
  for (const s of sources) {
    const seen = s.lastAt ? `last seen ${s.lastAt}` : 'never seen';
    lines.push(`  ${s.label} [${s.kind}] ${s.status} · ${n(s.total)} tokens · ${seen}`);
  }
  const gaps = Array.isArray(summary.gaps) ? summary.gaps : [];
  lines.push('');
  lines.push('Coverage gaps:');
  if (!gaps.length) lines.push('  (none recorded)');
  for (const g of gaps) {
    lines.push(`  ${g.source} ${g.kind} ×${n(g.count)}${g.detail ? ` — ${g.detail}` : ''}`);
  }
  lines.push('');
  lines.push(DISCLAIMER);
  return lines.join('\n');
}
