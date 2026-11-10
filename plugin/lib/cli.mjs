// CLI dispatcher (SPEC §7). Heavy modules (node:sqlite) are imported lazily so `ensure` stays fast.
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  VERSION, dataHome, ledgerPaths, ensureHome, readConfig, readJson, localLabel, collectorPort, projectsDir,
  claudeConfigDir, writeFileAtomic,
} from './paths.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(LIB_DIR, '..');
export const CLI_PATH = join(PLUGIN_ROOT, 'bin', 'token-ledger.mjs');
const INSTALLER_COMMANDS = new Set(['install', 'uninstall', 'upgrade', 'doctor', 'verify', 'statusline']);
const BOOL_FLAGS = new Set(['json', 'details', 'dry-run', 'yes', 'no-local', 'help', 'keep-data', 'erase-data', 'quiet']);

export const HELP = `Claude Token Ledger ${VERSION}

Usage: token-ledger <command> [options]

Collector
  serve [--host H --port P --tls-cert F --tls-key F] [--local-port P | --no-local]
                                     run the collector in the foreground
  start | stop | status              manage the detached collector
  ensure                             start the collector if it is not running (fast)

Ledger
  summary [--json] [--details]       print the total tracked tokens
  import --dry-run | --yes [--since ISO] [--projects DIR] [--json]
                                     import usage from Claude Code transcripts
  sync [--projects DIR]              incremental transcript import
  export [--format json|csv] [--out FILE]
  erase --yes                        delete ledger data (records, gaps, outbox); keeps config and tokens

Sources and pairing
  source list | revoke <label> | add <label> --kind remote|cloud
                                     revoked sources stop reporting; their past records stay counted
  pair create <label> --url https://host:port [--kind remote|cloud] [--ca FILE]
                                     on the primary: prints a one-time pairing code (THE CODE IS A SECRET)
  pair join <code>                   on another computer: relay its usage to the primary

Setup (installer)
  install [--yes] | upgrade | uninstall [--keep-data|--erase-data] | doctor | verify
  statusline wrap | unwrap | render

Demo
  demo load --yes                    load synthetic records (use a separate TOKEN_LEDGER_HOME)

Environment: TOKEN_LEDGER_HOME (default ~/.claude-token-ledger), TOKEN_LEDGER_PORT (default 47318),
CLAUDE_CONFIG_DIR (default ~/.claude).
Exit codes: 0 ok, 1 error, 2 usage, 3 not installed/unavailable.
Counts recorded API usage; not a bill or plan-limit meter.
`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(name)) flags[name] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else if (a === '-h') flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

// ---------- process helpers ----------

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function healthCheck(port, timeoutMs = 300) {
  return new Promise((resolveP) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolveP(res.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString()).ok === true); } catch { resolveP(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolveP(false); });
    req.on('error', () => resolveP(false));
  });
}

export async function runningCollector(paths) {
  const pf = readJson(paths.pid);
  if (!pf || !pidAlive(pf.pid)) return null;
  return (await healthCheck(pf.port, 300)) ? pf : null;
}

function spawnDetached(env) {
  const child = spawn(process.execPath, [CLI_PATH, 'serve'], {
    detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  child.unref();
  return child.pid;
}

// ---------- lazy modules ----------
const lazy = {
  store: () => import('./store.mjs'),
  summary: () => import('./summary-file.mjs'),
  format: () => import('./format.mjs'),
};

async function openExistingStore(paths) {
  const { openStore } = await lazy.store();
  return openStore(paths.db, { create: false });
}

async function openStoreRW(paths) {
  const { openStore } = await lazy.store();
  ensureHome(paths.home);
  return openStore(paths.db);
}

async function refreshSummaryFile(store, paths) {
  const { buildSummary, writeSummaryFile } = await lazy.summary();
  const s = buildSummary(store, paths, readConfig(paths));
  writeSummaryFile(paths.summary, s);
  return s;
}

// ---------- commands ----------

async function cmdServe(ctx, flags) {
  const { createCollector, isLoopbackHost } = await import('./server.mjs');
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  const port = flags.port !== undefined ? Number(flags.port) : ctx.port;
  const tlsCert = typeof flags['tls-cert'] === 'string' ? flags['tls-cert'] : undefined;
  const tlsKey = typeof flags['tls-key'] === 'string' ? flags['tls-key'] : undefined;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('serve: bad --port');
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) throw new UsageError('serve: --tls-cert and --tls-key go together');
  if (!tlsCert && !isLoopbackHost(host)) {
    ctx.err('serve: refusing to bind a non-loopback address without --tls-cert and --tls-key');
    return 1;
  }
  const remote = !!tlsCert;
  const localPort = flags['local-port'] !== undefined ? Number(flags['local-port']) : ctx.port;
  const collector = createCollector({ home: ctx.home, logToStderr: !flags.quiet && process.stderr.isTTY });
  let loopbackPort = null;
  try {
    if (!remote || !flags['no-local']) {
      const l = await collector.listen({ host: remote ? '127.0.0.1' : host, port: remote ? localPort : port });
      loopbackPort = l.port;
    }
    if (remote) {
      const l = await collector.listen({ host, port, tlsCert, tlsKey });
      ctx.out(`collector (remote, TLS) listening on ${host}:${l.port}`);
    }
  } catch (e) {
    await collector.close();
    if (e.code === 'EADDRINUSE' && (await healthCheck(remote ? localPort : port, 500))) {
      ctx.out('collector already running');
      return 0;
    }
    ctx.err(`serve: ${e.code === 'EADDRINUSE' ? 'port already in use' : e.message}`);
    return 1;
  }
  if (loopbackPort !== null) {
    writeFileAtomic(ctx.paths.pid, JSON.stringify({ pid: process.pid, port: loopbackPort, startedAt: new Date().toISOString(), version: VERSION }) + '\n');
    ctx.out(`collector listening on 127.0.0.1:${loopbackPort}`);
  }
  await new Promise((resolveP) => {
    const stop = () => resolveP();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    if (process.platform === 'win32') process.once('SIGBREAK', stop);
  });
  await collector.close();
  const pf = readJson(ctx.paths.pid);
  if (pf && pf.pid === process.pid) { try { fs.unlinkSync(ctx.paths.pid); } catch { /* ignore */ } }
  return 0;
}

async function waitHealthy(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await healthCheck(port, 300)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function cmdStart(ctx, { wait }) {
  const running = await runningCollector(ctx.paths);
  if (running) { ctx.out(`collector running (pid ${running.pid}, port ${running.port})`); return 0; }
  if (await healthCheck(ctx.port, 300)) { ctx.out(`collector already answering on port ${ctx.port}`); return 0; }
  ensureHome(ctx.paths.home);
  const pid = spawnDetached(ctx.env);
  if (!wait) { ctx.quiet || ctx.out(`collector starting (pid ${pid})`); return 0; }
  if (await waitHealthy(ctx.port, 5000)) { ctx.out(`collector started (port ${ctx.port})`); return 0; }
  ctx.err('collector did not become healthy; see collector.log');
  return 1;
}

async function cmdStop(ctx) {
  const pf = readJson(ctx.paths.pid);
  if (!pf || !pidAlive(pf.pid)) {
    try { fs.unlinkSync(ctx.paths.pid); } catch { /* none */ }
    ctx.out('collector not running');
    return 0;
  }
  try { process.kill(pf.pid, 'SIGTERM'); } catch { /* gone */ }
  const until = Date.now() + 5000;
  while (Date.now() < until && pidAlive(pf.pid)) await new Promise((r) => setTimeout(r, 50));
  if (pidAlive(pf.pid)) { try { process.kill(pf.pid, 'SIGKILL'); } catch { /* ignore */ } }
  try { fs.unlinkSync(ctx.paths.pid); } catch { /* removed by collector */ }
  ctx.out('collector stopped');
  return 0;
}

async function cmdStatus(ctx, flags) {
  const pf = await runningCollector(ctx.paths);
  const st = { running: !!pf, pid: pf ? pf.pid : null, port: pf ? pf.port : ctx.port, version: VERSION, home: ctx.paths.home };
  if (flags.json) ctx.out(JSON.stringify(st, null, 2));
  else ctx.out(pf ? `collector running (pid ${pf.pid}, port ${pf.port})` : 'collector not running');
  return pf ? 0 : 3;
}

export async function loadSummary(paths) {
  const { buildSummary, readSummaryFile } = await lazy.summary();
  let store;
  try {
    store = await openExistingStore(paths);
    return buildSummary(store, paths, readConfig(paths));
  } catch {
    const s = readSummaryFile(paths.summary);
    if (s && typeof s.total === 'number') { s.status = 'stale'; return s; }
    return null;
  } finally {
    store?.close();
  }
}

async function cmdSummary(ctx, flags) {
  const { formatCounter, formatDetails } = await lazy.format();
  const { unavailableSummary } = await lazy.summary();
  const s = (await loadSummary(ctx.paths)) || unavailableSummary();
  if (flags.json) ctx.out(JSON.stringify(s, null, 2));
  else ctx.out(flags.details ? formatDetails(s) : formatCounter(s));
  return s.status === 'unavailable' ? 3 : 0;
}

function printImportReport(ctx, rep, flags, dry) {
  if (flags.json) { ctx.out(JSON.stringify(rep, null, 2)); return; }
  ctx.out(`${dry ? 'Dry run (nothing written)' : 'Import complete'}`);
  ctx.out(`  files scanned:      ${rep.files}`);
  ctx.out(`  date range:         ${rep.dateRange.first ?? '—'} → ${rep.dateRange.last ?? '—'}`);
  ctx.out(`  eligible requests:  ${rep.eligible}`);
  ctx.out(`  already in ledger:  ${rep.alreadyInLedger}`);
  if (!dry) ctx.out(`  imported:           ${rep.imported}`);
  ctx.out(`  skipped:            unsupported_format=${rep.skipped.unsupported_format} partial_record=${rep.skipped.partial_record} malformed_json=${rep.skipped.malformed_json}`);
}

async function cmdImport(ctx, flags) {
  if (!!flags['dry-run'] === !!flags.yes) throw new UsageError('import: pass exactly one of --dry-run or --yes');
  if (flags.since !== undefined && !Number.isFinite(Date.parse(flags.since))) throw new UsageError('import: --since must be an ISO date');
  const { importTranscripts } = await import('./importer.mjs');
  const cfg = readConfig(ctx.paths);
  const dir = ctx.projectsDir(flags);
  if (flags['dry-run']) {
    let store = null;
    try { store = await openExistingStore(ctx.paths); } catch { store = null; }
    try {
      const rep = await importTranscripts({ store, projectsDir: dir, since: flags.since, dryRun: true, source: localLabel(cfg) });
      printImportReport(ctx, rep, flags, true);
    } finally { store?.close(); }
    return 0;
  }
  const store = await openStoreRW(ctx.paths);
  try {
    const rep = await importTranscripts({ store, projectsDir: dir, since: flags.since, source: localLabel(cfg), outbox: !!cfg.relay });
    await refreshSummaryFile(store, ctx.paths);
    printImportReport(ctx, rep, flags, false);
  } finally { store.close(); }
  return 0;
}

async function cmdSync(ctx, flags) {
  const { syncTranscripts } = await import('./importer.mjs');
  const cfg = readConfig(ctx.paths);
  const store = await openStoreRW(ctx.paths);
  try {
    const rep = await syncTranscripts({ store, projectsDir: ctx.projectsDir(flags), source: localLabel(cfg), outbox: !!cfg.relay });
    await refreshSummaryFile(store, ctx.paths);
    if (flags.json) ctx.out(JSON.stringify(rep, null, 2));
    else if (!flags.quiet) ctx.out(`sync: files=${rep.files} imported=${rep.imported}`);
  } finally { store.close(); }
  return 0;
}

async function cmdExport(ctx, flags) {
  const format = typeof flags.format === 'string' ? flags.format : 'json';
  if (format !== 'json' && format !== 'csv') throw new UsageError('export: --format json|csv');
  let store;
  try { store = await openExistingStore(ctx.paths); } catch { ctx.err('no ledger found'); return 3; }
  try {
    const data = store.exportAll(format);
    if (typeof flags.out === 'string') {
      fs.writeFileSync(flags.out, data, { mode: 0o600 });
      ctx.out(`exported to ${flags.out}`);
    } else process.stdout.write(data);
  } finally { store.close(); }
  return 0;
}

async function cmdErase(ctx, flags) {
  if (!flags.yes) throw new UsageError('erase: this deletes all recorded usage; re-run with --yes');
  const store = await openStoreRW(ctx.paths);
  try {
    store.erase();
    try { fs.unlinkSync(ctx.paths.remoteSummary); } catch { /* none */ }
    await refreshSummaryFile(store, ctx.paths);
  } finally { store.close(); }
  ctx.out('ledger erased (config, sources and tokens kept)');
  return 0;
}

async function cmdSource(ctx, pos, flags) {
  const sub = pos[0];
  const { isLabel } = await import('./normalize.mjs');
  if (sub === 'list') {
    let store;
    try { store = await openExistingStore(ctx.paths); } catch { ctx.out('no sources (ledger not created yet)'); return 0; }
    try {
      const s = store.summary({ localLabel: localLabel(readConfig(ctx.paths)) });
      const tok = store.tokenCounts();
      const rows = s.sources.map((x) => {
        const t = tok.filter((r) => r.label === x.label);
        const active = (scope) => Number(t.find((r) => r.scope === scope)?.active || 0);
        return { label: x.label, kind: x.kind, status: x.status, total: x.total, lastAt: x.lastAt,
          activeTokens: { ingest: active('ingest'), read: active('read') } };
      });
      if (flags.json) ctx.out(JSON.stringify(rows, null, 2));
      else if (!rows.length) ctx.out('no sources');
      else for (const r of rows) {
        ctx.out(`${r.label}\t${r.kind}\t${r.status}\t${r.total}\ttokens ingest=${r.activeTokens.ingest} read=${r.activeTokens.read}`);
      }
    } finally { store.close(); }
    return 0;
  }
  if (sub === 'revoke') {
    const label = pos[1];
    if (!isLabel(label)) throw new UsageError('source revoke <label>');
    const store = await openStoreRW(ctx.paths);
    try {
      const r = store.revokeLabel(label);
      await refreshSummaryFile(store, ctx.paths);
      ctx.out(`revoked ${label}: ${r.tokens} token(s). Records already received stay counted.`);
    } finally { store.close(); }
    return 0;
  }
  if (sub === 'add') {
    const label = pos[1];
    const kind = flags.kind;
    if (!isLabel(label) || (kind !== 'remote' && kind !== 'cloud')) throw new UsageError('source add <label> --kind remote|cloud');
    const { createToken } = await import('./tokens.mjs');
    const store = await openStoreRW(ctx.paths);
    try {
      store.upsertSource(label, kind);
      const i = createToken(store, label, 'ingest', kind);
      const r = createToken(store, label, 'read', kind);
      ctx.out(`source ${label} (${kind}) added. These tokens are shown once and are SECRETS:`);
      ctx.out(`ingest token: ${i}`);
      ctx.out(`read token:   ${r}`);
    } finally { store.close(); }
    return 0;
  }
  throw new UsageError('source list | revoke <label> | add <label> --kind remote|cloud');
}

async function cmdPair(ctx, pos, flags) {
  const { createPair, joinPair } = await import('./pair.mjs');
  if (pos[0] === 'create') {
    const store = await openStoreRW(ctx.paths);
    try {
      const code = createPair(store, pos[1], { url: flags.url, kind: flags.kind || 'remote', caFile: flags.ca });
      ctx.out(code);
      ctx.err('This pairing code is a SECRET (it contains ingest and read tokens). Paste it only into');
      ctx.err(`\`token-ledger pair join <code>\` on the other computer. Revoke with: token-ledger source revoke ${pos[1]}`);
    } finally { store.close(); }
    return 0;
  }
  if (pos[0] === 'join') {
    if (!pos[1]) throw new UsageError('pair join <code>');
    const store = await openStoreRW(ctx.paths);
    try {
      const r = joinPair(ctx.paths, pos[1], store);
      ctx.out(`paired as "${r.label}" with ${r.url}; ${r.queued} existing record(s) queued for relay.`);
      ctx.out('Restart the collector (token-ledger stop && token-ledger start) to begin relaying.');
    } finally { store.close(); }
    return 0;
  }
  throw new UsageError('pair create <label> --url https://host:port | pair join <code>');
}

async function cmdDemo(ctx, pos, flags) {
  if (pos[0] !== 'load') throw new UsageError('demo load --yes');
  ctx.err('WARNING: demo data is synthetic. Load it into a separate TOKEN_LEDGER_HOME, e.g.');
  ctx.err('  TOKEN_LEDGER_HOME=/tmp/tl-demo token-ledger demo load --yes');
  ctx.err(`Current TOKEN_LEDGER_HOME: ${ctx.paths.home}`);
  if (!flags.yes) { ctx.err('Re-run with --yes to load into the current TOKEN_LEDGER_HOME.'); return 2; }
  const file = typeof flags.file === 'string' ? flags.file : fileURLToPath(new URL('../../demo/synthetic-records.json', import.meta.url));
  const data = readJson(file);
  if (!data || !Array.isArray(data.records)) { ctx.err('demo: synthetic-records.json not found'); return 1; }
  const { validateRecord } = await import('./normalize.mjs');
  const recs = data.records.map((r) => validateRecord({ ...r, origin: 'demo' })).filter(Boolean);
  const store = await openStoreRW(ctx.paths);
  try {
    for (const s of data.sources || []) store.upsertSource(s.label, s.kind);
    const r = store.insertRecords(recs, { outbox: false });
    const s = await refreshSummaryFile(store, ctx.paths);
    const { formatCounter } = await lazy.format();
    ctx.out(`demo: loaded ${r.accepted} record(s) (${r.duplicates} already present)`);
    ctx.out(formatCounter(s));
  } finally { store.close(); }
  return 0;
}

async function cmdInstaller(ctx, command, args) {
  let mod;
  try {
    mod = await import('./install/index.mjs');
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('install')) {
      ctx.err('installer module not available');
      return 3;
    }
    throw e;
  }
  if (typeof mod.run !== 'function') { ctx.err('installer module not available'); return 3; }
  const code = await mod.run(command, args, ctx);
  return Number.isInteger(code) ? code : 0;
}

export async function main(argv, env = process.env) {
  const home = dataHome(env);
  const paths = ledgerPaths(home);
  const ctx = {
    version: VERSION, home, paths, env, port: collectorPort(env),
    pluginRoot: PLUGIN_ROOT, cliPath: CLI_PATH, claudeConfigDir: claudeConfigDir(env),
    projectsDir: (flags = {}) => (typeof flags.projects === 'string' ? resolve(flags.projects) : projectsDir(env)),
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    lib: { loadSummary: () => loadSummary(paths), runningCollector: () => runningCollector(paths), healthCheck },
  };
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') { ctx.out(HELP); return 0; }
  if (command === '--version' || command === 'version') { ctx.out(VERSION); return 0; }
  if (INSTALLER_COMMANDS.has(command)) return cmdInstaller(ctx, command, rest);
  const { pos, flags } = parseArgs(rest);
  if (flags.help) { ctx.out(HELP); return 0; }
  if (flags.port !== undefined && command !== 'serve') {
    const p = Number(flags.port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new UsageError('bad --port');
    ctx.port = p;
    ctx.env = { ...env, TOKEN_LEDGER_PORT: String(p) };
  }
  try {
    switch (command) {
      case 'serve': return await cmdServe(ctx, flags);
      case 'start': return await cmdStart(ctx, { wait: true });
      case 'ensure': {
        if (await runningCollector(paths)) return 0;
        ctx.quiet = true;
        return await cmdStart(ctx, { wait: false });
      }
      case 'stop': return await cmdStop(ctx);
      case 'status': return await cmdStatus(ctx, flags);
      case 'summary': return await cmdSummary(ctx, flags);
      case 'import': return await cmdImport(ctx, flags);
      case 'sync': return await cmdSync(ctx, flags);
      case 'export': return await cmdExport(ctx, flags);
      case 'erase': return await cmdErase(ctx, flags);
      case 'source': return await cmdSource(ctx, pos, flags);
      case 'pair': return await cmdPair(ctx, pos, flags);
      case 'demo': return await cmdDemo(ctx, pos, flags);
      default:
        ctx.err(`unknown command: ${command}\n`);
        ctx.err(HELP);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) { ctx.err(`usage: token-ledger ${e.message}`); return 2; }
    ctx.err(`token-ledger: ${e.message}`);
    return 1;
  }
}
