// Decide how Token Ledger receives live data (SPEC §6.1, §8). Pure functions: no I/O except managed-settings reads.
import fs from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PORT = 47318;

export function ourEnv(port = DEFAULT_PORT) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
    OTEL_LOGS_EXPORT_INTERVAL: '5000',
  };
}

/** Variables whose presence in managed settings means the organization decides telemetry. */
const AUTHORITY_RE = /^(OTEL_EXPORTER_OTLP_|OTEL_LOGS_EXPORTER$|CLAUDE_CODE_ENABLE_TELEMETRY$)/;

/** System managed-settings directory (Claude Code docs, "Deploy managed settings"). Overridable for tests. */
export function managedSettingsDir(env = process.env, platform = process.platform) {
  if (env.TOKEN_LEDGER_MANAGED_SETTINGS_DIR) return env.TOKEN_LEDGER_MANAGED_SETTINGS_DIR;
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/** Read managed-settings.json and managed-settings.d/*.json; return { files, envKeys, statusLine }. Never throws. */
export function readManagedSettings(env = process.env, platform = process.platform) {
  const dir = managedSettingsDir(env, platform);
  const files = [];
  const main = join(dir, 'managed-settings.json');
  if (fs.existsSync(main)) files.push(main);
  try {
    for (const f of fs.readdirSync(join(dir, 'managed-settings.d')).sort()) if (f.endsWith('.json')) files.push(join(dir, 'managed-settings.d', f));
  } catch { /* no drop-in dir */ }
  const envKeys = new Set();
  let unreadable = 0;
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (d && d.env && typeof d.env === 'object') for (const k of Object.keys(d.env)) envKeys.add(k);
    } catch { unreadable++; }
  }
  const pinned = [...envKeys].filter((k) => AUTHORITY_RE.test(k)).sort();
  return { dir, files, pinned, unreadable };
}

function normProto(p) {
  if (typeof p !== 'string' || !p) return null;
  return p.trim().toLowerCase();
}

function logsEndpointOf(env) {
  if (typeof env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === 'string' && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) return env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string' && env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '') + '/v1/logs';
  }
  return null;
}

function isOurEndpoint(url) {
  try {
    const u = new URL(url);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.pathname === '/v1/logs' &&
      /^\d+$/.test(u.port || '');
  } catch { return false; }
}

/**
 * Plan the settings env change.
 * @param settingsEnv  current `env` object of user settings.json (may be undefined)
 * @param manifestEnv  keys recorded by an earlier install: { KEY: { value, prior } }
 * @param managed      result of readManagedSettings()
 * @param settings     whole settings object (for otelHeadersHelper)
 * Returns { mode: 'otel'|'transcript', reason, set: {KEY: value}, forward: {...}|null, notes: [] }
 */
export function planTelemetry({ settingsEnv = {}, manifestEnv = {}, managed = { pinned: [] }, settings = {}, port = DEFAULT_PORT }) {
  const want = ourEnv(port);
  const env = settingsEnv && typeof settingsEnv === 'object' ? settingsEnv : {};
  const notes = [];
  const ours = (k) => manifestEnv[k] && env[k] === manifestEnv[k].value;

  if (managed.pinned && managed.pinned.length) {
    return {
      mode: 'transcript', set: {}, forward: null,
      reason: `Your organization's managed settings set ${managed.pinned.join(', ')}. Token Ledger does not override them; ` +
        'it counts usage from transcript sync instead (reported as an authority gap).',
      notes,
    };
  }

  const tel = env.CLAUDE_CODE_ENABLE_TELEMETRY;
  if (tel !== undefined && !ours('CLAUDE_CODE_ENABLE_TELEMETRY') && /^(0|false|no|off)$/i.test(String(tel))) {
    return {
      mode: 'transcript', set: {}, forward: null,
      reason: 'CLAUDE_CODE_ENABLE_TELEMETRY is turned off in your settings. Token Ledger respects that and uses transcript sync.',
      notes,
    };
  }

  // Existing logs exporter that is not ours?
  const exporter = env.OTEL_LOGS_EXPORTER;
  const endpoint = logsEndpointOf(env);
  const exporterIsOurs = ours('OTEL_LOGS_EXPORTER') || (exporter === 'otlp' && endpoint && isOurEndpoint(endpoint));
  let forward = null;
  if (exporter !== undefined && !exporterIsOurs && String(exporter).trim() !== '' && String(exporter).trim() !== 'none') {
    const kinds = String(exporter).split(',').map((s) => s.trim());
    if (!kinds.includes('otlp')) {
      return {
        mode: 'transcript', set: {}, forward: null,
        reason: `You already export logs with OTEL_LOGS_EXPORTER=${exporter}. Live OTel was left to your existing setup; Token Ledger uses transcript sync.`,
        notes,
      };
    }
    const proto = normProto(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL) || normProto(env.OTEL_EXPORTER_OTLP_PROTOCOL);
    if (proto !== 'http/json') {
      return {
        mode: 'transcript', set: {}, forward: null,
        reason: `Your existing logs exporter uses protocol ${proto || '(unset)'}; Token Ledger can only forward http/json. ` +
          'Live OTel left to your existing collector; Token Ledger uses transcript sync.',
        notes,
      };
    }
    if (!endpoint) {
      return { mode: 'transcript', set: {}, forward: null, reason: 'Your logs exporter has no endpoint set; it was left untouched. Token Ledger uses transcript sync.', notes };
    }
    if (typeof settings.otelHeadersHelper === 'string' && settings.otelHeadersHelper) {
      return {
        mode: 'transcript', set: {}, forward: null,
        reason: 'Your logs exporter authenticates through otelHeadersHelper, whose headers Token Ledger cannot forward. ' +
          'Live OTel left to your existing collector; Token Ledger uses transcript sync.',
        notes,
      };
    }
    forward = { logsEndpoint: endpoint, protocol: 'http/json' };
    const hdr = env.OTEL_EXPORTER_OTLP_LOGS_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS || null;
    if (hdr) {
      forward.headers = parseOtelHeaders(hdr);
      notes.push('Copied the logs-exporter header names/values into config.json (0600) so forwarding still authenticates.');
    }
    notes.push(`Your existing logs endpoint is kept as a forward target: every OTLP body the collector commits is sent on to ${redactUrl(endpoint)}.`);
  }

  const set = {};
  for (const [k, v] of Object.entries(want)) if (env[k] !== v) set[k] = v;
  return { mode: 'otel', set, forward, reason: forward ? 'Live OTel → local collector (fan-out to your existing logs endpoint).' : 'Live OTel → local collector.', notes };
}

export function parseOtelHeaders(s) {
  const out = {};
  for (const part of String(s).split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = decodeURIComponent(part.slice(0, i).trim());
    const v = decodeURIComponent(part.slice(i + 1).trim());
    if (/^[A-Za-z0-9-]{1,80}$/.test(k)) out[k] = v;
  }
  return out;
}

export function redactUrl(u) {
  try { const x = new URL(u); x.username = ''; x.password = ''; x.search = ''; return x.toString(); } catch { return '(invalid URL)'; }
}
