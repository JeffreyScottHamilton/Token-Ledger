// Claude Token Ledger installer (SPEC §8). Zero dependencies, Node >= 22.13, Windows/macOS/Linux.
// Entry: run(command, args, ctx) for install | uninstall | upgrade | doctor | verify | statusline.
// Ledger operations are performed by spawning the ledger CLI (process.execPath cliPath <cmd>) to keep boundaries narrow.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings, writeSettings, writeAtomic, sameJson } from './settings.mjs';
import { ourEnv, planTelemetry, readManagedSettings, redactUrl, DEFAULT_PORT } from './telemetry.mjs';

export const MIN_NODE = [22, 13, 0];
export const MIN_CLAUDE = [2, 1, 300];
export const PLUGIN_ID = 'token-ledger@token-ledger';
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = resolve(HERE, '..', '..', 'bin', 'token-ledger.mjs');
const RESTART_NOTE = 'Restart Claude Code (exit and reopen) so telemetry settings take effect; plugin reload: /reload-plugins';

// ---------------------------------------------------------------- small utilities

export function parseVersion(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function versionAtLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < 3; i++) { if (v[i] > min[i]) return true; if (v[i] < min[i]) return false; }
  return true;
}
const vstr = (v) => (v ? v.join('.') : 'unknown');

function parseArgs(args) {
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const k = a.slice(2);
      if (['label', 'timeout', 'prompt'].includes(k) && i + 1 < args.length) { flags[k] = args[++i]; continue; }
      flags[k] = true;
    } else if (a === '-y') flags.yes = true; else pos.push(a);
  }
  return { flags, pos };
}

export function sanitizeLabel(s) {
  const l = String(s || '').toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 40).replace(/-+$/, '');
  return l || 'local';
}

function readJsonFile(f, fb = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJsonIfChanged(f, obj, mode = 0o600) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  let cur = null; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* none */ }
  if (cur === text) return false;
  writeAtomic(f, text, mode);
  if (process.platform !== 'win32') { try { fs.chmodSync(f, mode); } catch { /* ignore */ } }
  return true;
}

function makeContext(ctx = {}) {
  const env = ctx.env || process.env;
  const dataDir = resolve((ctx.paths && ctx.paths.home) || ctx.dataDir || ctx.home ||
    (env.TOKEN_LEDGER_HOME ? env.TOKEN_LEDGER_HOME : join(os.homedir(), '.claude-token-ledger')));
  const claudeDir = resolve(ctx.claudeConfigDir || (env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(os.homedir(), '.claude')));
  const c = {
    env, dataDir, claudeDir,
    cliPath: resolve(ctx.cliPath || DEFAULT_CLI),
    version: ctx.version || readJsonFile(resolve(HERE, '..', '..', '.claude-plugin', 'plugin.json'), {}).version || '0.0.0',
    settingsFile: join(claudeDir, 'settings.json'),
    manifestFile: join(dataDir, 'install-manifest.json'),
    configFile: join(dataDir, 'config.json'),
    summaryFile: join(dataDir, 'summary.json'),
    backups: join(dataDir, 'backups'),
    defaultPort: envPort(env),
    out: ctx.out || ((s) => process.stdout.write(s + '\n')),
    err: ctx.err || ((s) => process.stderr.write(s + '\n')),
  };
  return c;
}

function envPort(env) {
  const p = Number(env.TOKEN_LEDGER_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { try { fs.chmodSync(d, 0o700); } catch { /* ignore */ } }
}

/** Spawn the ledger CLI synchronously. */
function cli(c, args, { timeout = 60_000, port } = {}) {
  const env = { ...c.env, TOKEN_LEDGER_HOME: c.dataDir };
  if (port) env.TOKEN_LEDGER_PORT = String(port);
  const r = spawnSync(process.execPath, ['--no-warnings', c.cliPath, ...args], { env, encoding: 'utf8', timeout, windowsHide: true });
  return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

function claudeCommand(env, args) {
  const bin = env.TOKEN_LEDGER_CLAUDE_BIN || 'claude';
  if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, args: [bin, ...args], shell: false };
  // On Windows `claude` is usually claude.cmd/.exe resolved through PATHEXT, which needs a shell.
  if (process.platform === 'win32') return { cmd: [bin, ...args.map(winQuote)].join(' '), args: [], shell: true };
  return { cmd: bin, args, shell: false };
}
function winQuote(a) { return /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a; }

export function claudeVersion(env = process.env) {
  const { cmd, args, shell } = claudeCommand(env, ['--version']);
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 20_000, shell, windowsHide: true });
  if (r.error || r.status !== 0) return { found: false, version: null, raw: '' };
  return { found: true, version: parseVersion(r.stdout), raw: (r.stdout || '').trim() };
}

function nodeHint(platform = process.platform) {
  if (platform === 'win32') return 'Install Node.js 22 LTS or newer:  winget install OpenJS.NodeJS.LTS   (then open a new terminal)';
  if (platform === 'darwin') return 'Install Node.js 22 or newer:  brew install node   (or use nvm: nvm install --lts)';
  return 'Install Node.js 22.13 or newer: nvm install --lts, or your package manager (e.g. NodeSource apt repo for Node 22: apt-get install -y nodejs)';
}

function httpGetJson(port, path, timeoutMs = 1500) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (d) => { b += d; });
      r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(b) }); } catch { res({ status: r.statusCode, body: null }); } });
    });
    req.on('timeout', () => { req.destroy(); res(null); });
    req.on('error', () => res(null));
  });
}

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(question + ' [y/N] ', r));
  rl.close();
  return /^y(es)?$/i.test(String(a).trim());
}

function summaryJson(c) {
  const r = cli(c, ['summary', '--json'], { timeout: 20_000 });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// ---------------------------------------------------------------- install / upgrade

function checkNode(c) {
  const v = parseVersion(process.versions.node);
  if (!versionAtLeast(v, MIN_NODE)) {
    c.err(`Node.js ${vstr(v)} is too old. Token Ledger needs Node.js ${MIN_NODE.join('.')} or newer (built-in node:sqlite).`);
    c.err(nodeHint());
    return false;
  }
  return true;
}

function checkClaude(c, flags) {
  if (flags['skip-claude-check']) return { ok: true, line: 'Claude Code: check skipped' };
  const cv = claudeVersion(c.env);
  if (!cv.found) {
    return { ok: true, warn: true, line: 'Claude Code: `claude` was not found on PATH. Install or update Claude Code (2.1.300 or newer) before using live telemetry.' };
  }
  if (!cv.version) return { ok: true, warn: true, line: `Claude Code: could not read a version from "${cv.raw}"` };
  if (!versionAtLeast(cv.version, MIN_CLAUDE)) {
    return {
      ok: false,
      line: `Claude Code ${vstr(cv.version)} is too old. Token Ledger needs ${MIN_CLAUDE.join('.')} or newer ` +
        '(OpenTelemetry cache 5m/1h attributes and mod support). Update with `claude update` (or your package manager), then run setup again.',
    };
  }
  return { ok: true, line: `Claude Code: ${vstr(cv.version)}`, version: cv.version };
}

/**
 * Compute and (if confirmed) apply the install. Shared by install and upgrade.
 * Returns an exit code.
 */
async function doInstall(c, flags, { upgrade = false } = {}) {
  if (!checkNode(c)) return 1;
  c.out(`Claude Token Ledger ${c.version} — ${upgrade ? 'upgrade' : 'setup'}`);
  c.out(`System: ${process.platform} ${process.arch}, Node.js ${process.versions.node}`);
  const cc = checkClaude(c, flags);
  c.out(cc.line);
  if (!cc.ok) return 1;

  let st;
  try { st = readSettings(c.settingsFile); } catch (e) { c.err(e.message); return 1; }
  const manifest = readJsonFile(c.manifestFile, null) || { schema: 1, env: {} };
  manifest.env = manifest.env || {};
  const config = readJsonFile(c.configFile, {}) || {};
  const prevVersion = config.installedVersion || null;
  const port = Number.isInteger(config.port) ? config.port : c.defaultPort;
  const managed = readManagedSettings(c.env);
  const plan = planTelemetry({ settingsEnv: st.data.env, manifestEnv: manifest.env, managed, settings: st.data, port });

  // New settings object: same keys and order; env keys appended at the end of env (env appended if absent).
  const next = structuredClone(st.data);
  const keys = Object.keys(plan.set);
  if (keys.length) {
    if (!next.env || typeof next.env !== 'object' || Array.isArray(next.env)) {
      if (next.env === undefined && manifest.createdEnv === undefined) manifest.createdEnv = true;
      next.env = {};
    }
    for (const k of keys) {
      if (!manifest.env[k]) {
        const had = Object.prototype.hasOwnProperty.call(next.env, k);
        manifest.env[k] = had ? { value: plan.set[k], hadPrior: true, prior: next.env[k] } : { value: plan.set[k], hadPrior: false };
      } else manifest.env[k].value = plan.set[k];
      next.env[k] = plan.set[k];
    }
  }
  const settingsChange = !sameJson(next, st.data);

  c.out(`Claude config: ${c.claudeDir}`);
  c.out(`Ledger data:   ${c.dataDir}`);
  c.out(`Live data:     ${plan.mode === 'otel' ? plan.reason : 'transcript sync — ' + plan.reason}`);
  for (const n of plan.notes) c.out(`  note: ${n}`);
  if (managed.files.length && !managed.pinned.length) c.out(`Managed settings found (${managed.files.length} file(s)); they do not pin telemetry.`);
  if (st.data.statusLine) c.out('Status line:   you already have one; it was left unchanged. (Optional: `token-ledger statusline wrap` adds the counter after it.)');
  if (settingsChange) {
    c.out(`Settings:      will add to ${c.settingsFile} → env: ${keys.join(', ')}`);
    for (const k of keys) if (manifest.env[k].hadPrior) c.out(`  replaces your ${k} (previous value saved and restored on uninstall)`);
  } else c.out('Settings:      already up to date (no change).');

  if (settingsChange && !flags.yes) {
    const ok = await ask('Apply these changes?');
    if (!ok) { c.out('Nothing changed. Re-run with --yes to apply.'); return 2; }
  }

  ensureDir(c.dataDir);
  ensureDir(c.backups);
  if (settingsChange) {
    if (!manifest.backup) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `settings.${ts}.json`;
      manifest.settingsExisted = st.exists;
      if (st.exists) fs.writeFileSync(join(c.backups, name), st.raw, { mode: 0o600 });
      manifest.backup = st.exists ? join('backups', name) : null;
    }
    manifest.settingsFile = c.settingsFile;
    writeSettings(c.settingsFile, next, st.format);
    c.out('Settings updated (backup saved).');
  }
  manifest.schema = 1;
  manifest.plugin = PLUGIN_ID;
  manifest.telemetry = { mode: plan.mode };
  writeJsonIfChanged(c.manifestFile, manifest);

  // config.json: keep every existing key; fill ours.
  const cfg = structuredClone(config);
  cfg.nodePath = process.execPath;
  if (!Number.isInteger(cfg.port)) cfg.port = c.defaultPort;
  const label = typeof flags.label === 'string' ? sanitizeLabel(flags.label) : null;
  if (label) { cfg.sourceLabel = label; cfg.label = label; }
  if (!cfg.sourceLabel) cfg.sourceLabel = sanitizeLabel(os.hostname());
  if (!cfg.label) cfg.label = cfg.sourceLabel;
  if (plan.forward) cfg.forward = { ...(cfg.forward || {}), ...plan.forward };
  cfg.telemetry = { mode: plan.mode, reason: plan.mode === 'otel' ? null : plan.reason, managedPinned: managed.pinned };
  cfg.installedVersion = c.version;
  writeJsonIfChanged(c.configFile, cfg);

  if (upgrade && prevVersion && prevVersion !== c.version && !flags['no-start']) {
    c.out(`Upgrading collector ${prevVersion} → ${c.version} (restart).`);
    cli(c, ['stop'], { port: cfg.port });
  }
  if (!flags['no-start']) {
    const r = cli(c, ['ensure'], { port: cfg.port });
    const h = await waitHealth(cfg.port, 5000);
    // First sync records the setup time as the catch-up baseline; earlier history stays opt-in (import).
    cli(c, ['sync', '--quiet'], { port: cfg.port, timeout: 60_000 });
    if (h) c.out(`Collector:     running on 127.0.0.1:${cfg.port} (version ${h.version || '?'})`);
    else { c.err(`Collector did not answer on 127.0.0.1:${cfg.port}. ${r.stderr.trim()} See ${join(c.dataDir, 'collector.log')}.`); return 1; }
  }

  if (!upgrade && !flags['no-import']) {
    c.out('');
    c.out('Historical import (dry run, nothing written):');
    const d = cli(c, ['import', '--dry-run'], { timeout: 300_000 });
    c.out(indent(d.stdout.trim() || d.stderr.trim()));
    if (flags.import || flags.yes) {
      const r = cli(c, ['import', '--yes'], { timeout: 600_000 });
      c.out(indent(r.stdout.trim() || r.stderr.trim()));
    } else c.out('  To import it: token-ledger import --yes');
  }

  c.out('');
  c.out('Next steps:');
  c.out(`  1. ${RESTART_NOTE}`);
  c.out('  2. Check it works: token-ledger verify --live');
  c.out('  3. See your total: /token-ledger   ·   details: /token-ledger details   ·   it also appears beside /usage');
  return 0;
}

function indent(s) { return s.split(/\r?\n/).map((l) => '  ' + l).join('\n'); }

async function waitHealth(port, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await httpGetJson(port, '/healthz', 800);
    if (r && r.status === 200 && r.body && r.body.ok) return r.body;
    if (Date.now() > until) return null;
    await new Promise((x) => setTimeout(x, 150));
  }
}

// ---------------------------------------------------------------- uninstall

/** Remove our keys from a settings object per manifest. Returns { next, kept: [keys left because user changed them] }. */
export function removeOurKeys(data, manifest) {
  const next = structuredClone(data);
  const kept = [];
  const recs = (manifest && manifest.env) || {};
  if (next.env && typeof next.env === 'object') {
    for (const [k, rec] of Object.entries(recs)) {
      if (!Object.prototype.hasOwnProperty.call(next.env, k)) continue;
      if (next.env[k] !== rec.value) { kept.push(k); continue; }
      if (rec.hadPrior) next.env[k] = rec.prior; else delete next.env[k];
    }
    if (manifest.createdEnv && Object.keys(next.env).length === 0) delete next.env;
  }
  return { next, kept };
}

async function doUninstall(c, flags) {
  if (!flags['keep-data'] && !flags['erase-data']) {
    c.err('uninstall needs a choice: --keep-data (keep your ledger) or --erase-data (delete it).');
    return 2;
  }
  if (flags['keep-data'] && flags['erase-data']) { c.err('choose one of --keep-data or --erase-data'); return 2; }
  const manifest = readJsonFile(c.manifestFile, null);
  if (manifest && manifest.statusLine && manifest.statusLine.wrapped) {
    const code = statuslineUnwrap(c);
    if (code !== 0) return code;
  }
  const m2 = readJsonFile(c.manifestFile, null) || manifest;
  const s = cli(c, ['stop'], { timeout: 15_000 });
  c.out(`Collector: ${(s.stdout.trim() || s.stderr.trim() || 'stopped')}`);

  if (m2 && m2.env && Object.keys(m2.env).length) {
    let st;
    try { st = readSettings(c.settingsFile); } catch (e) { c.err(e.message); return 1; }
    if (st.exists) {
      const { next, kept } = removeOurKeys(st.data, m2);
      const candidates = [];
      if (m2.backup) { try { candidates.push(fs.readFileSync(join(c.dataDir, m2.backup), 'utf8')); } catch { /* gone */ } }
      if (m2.settingsExisted === false && Object.keys(next).length === 0) {
        fs.unlinkSync(c.settingsFile);
        c.out('Settings: removed the settings.json Token Ledger created.');
      } else if (writeSettings(c.settingsFile, next, st.format, candidates)) c.out('Settings: Token Ledger keys removed.');
      else c.out('Settings: nothing to remove.');
      for (const k of kept) c.out(`  kept ${k}: you changed it after setup, so it was left as is.`);
    }
  } else c.out('Settings: no Token Ledger keys recorded.');

  if (flags['erase-data']) {
    fs.rmSync(c.dataDir, { recursive: true, force: true });
    c.out(`Data: erased ${c.dataDir}`);
  } else {
    try { fs.unlinkSync(c.manifestFile); } catch { /* none */ }
    c.out(`Data: kept in ${c.dataDir} (delete later with: token-ledger erase --yes, or remove the folder).`);
  }
  c.out('');
  c.out('Last step — remove the plugin itself (run outside the plugin):');
  c.out(`  shell:   claude plugin uninstall ${PLUGIN_ID}`);
  c.out(`  session: /plugin uninstall ${PLUGIN_ID}`);
  return 0;
}

// ---------------------------------------------------------------- statusline

function renderCommand(c) {
  const q = (p) => `"${p}"`;
  return `${q(process.execPath)} ${q(c.cliPath)} statusline render`;
}

function statuslineWrap(c) {
  let st;
  try { st = readSettings(c.settingsFile); } catch (e) { c.err(e.message); return 1; }
  const manifest = readJsonFile(c.manifestFile, null) || { schema: 1, env: {} };
  const cmd = renderCommand(c);
  if (manifest.statusLine && manifest.statusLine.wrapped && st.data.statusLine && st.data.statusLine.command === cmd) {
    c.out('Status line already shows the Token Ledger counter.');
    return 0;
  }
  ensureDir(c.dataDir); ensureDir(c.backups);
  const had = Object.prototype.hasOwnProperty.call(st.data, 'statusLine');
  const original = had ? structuredClone(st.data.statusLine) : null;
  const preName = join('backups', 'settings.pre-statusline.json');
  if (st.exists) fs.writeFileSync(join(c.dataDir, preName), st.raw, { mode: 0o600 });
  manifest.statusLine = { wrapped: true, hadKey: had, original, ourCommand: cmd, preWrapBackup: st.exists ? preName : null, settingsExisted: st.exists };
  const next = structuredClone(st.data);
  const base = original && typeof original === 'object' ? original : {};
  next.statusLine = { ...base, type: 'command', command: cmd };
  writeJsonIfChanged(c.manifestFile, manifest);
  writeSettings(c.settingsFile, next, st.format);
  c.out(original ? 'Status line wrapped: your status line runs first, then " · Total tracked tokens · …".' : 'Status line added: shows the Token Ledger counter.');
  c.out('Undo any time: token-ledger statusline unwrap');
  return 0;
}

function statuslineUnwrap(c) {
  const manifest = readJsonFile(c.manifestFile, null);
  if (!manifest || !manifest.statusLine || !manifest.statusLine.wrapped) { c.out('Status line is not wrapped by Token Ledger.'); return 0; }
  let st;
  try { st = readSettings(c.settingsFile); } catch (e) { c.err(e.message); return 1; }
  const sl = manifest.statusLine;
  const cur = st.data.statusLine;
  if (cur && cur.command !== sl.ourCommand) {
    c.out('Your status line was changed after wrapping, so it was left as is.');
  } else {
    const next = structuredClone(st.data);
    if (sl.hadKey) {
      // Re-insert at the same position: rebuild key order from the original settings if possible.
      next.statusLine = sl.original;
    } else delete next.statusLine;
    const candidates = [];
    if (sl.preWrapBackup) { try { candidates.push(fs.readFileSync(join(c.dataDir, sl.preWrapBackup), 'utf8')); } catch { /* gone */ } }
    if (sl.settingsExisted === false && Object.keys(next).length === 0) { try { fs.unlinkSync(c.settingsFile); } catch { /* none */ } }
    else writeSettings(c.settingsFile, next, st.format, candidates);
    c.out('Status line restored.');
  }
  delete manifest.statusLine;
  writeJsonIfChanged(c.manifestFile, manifest);
  return 0;
}

function readStdin(ms) {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res('');
    let b = ''; let done = false;
    const finish = () => { if (!done) { done = true; res(b); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { b += d; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(() => { finish(); try { process.stdin.pause(); } catch { /* ignore */ } }, ms).unref();
  });
}

function runOriginal(command, input) {
  return new Promise((res) => {
    let out = '';
    let child;
    try { child = spawn(command, { shell: true, cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return res(''); }
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } res(out); }, 2000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(t); res(out); });
    child.on('close', () => { clearTimeout(t); res(out); });
    child.stdin.on('error', () => { /* original ignored stdin */ });
    child.stdin.end(input);
  });
}

export async function counterLine(dataDir) {
  try {
    const fmt = await import('../format.mjs');
    let s = null;
    try { s = JSON.parse(fs.readFileSync(join(dataDir, 'summary.json'), 'utf8')); } catch { s = null; }
    return fmt.formatCounter(s);
  } catch { return 'Total tracked tokens · unavailable'; }
}

export function composeStatus(original, counter) {
  const o = String(original || '').replace(/\s+$/, '');
  return o ? `${o} · ${counter}` : counter;
}

async function statuslineRender(c) {
  const input = await readStdin(1000);
  const manifest = readJsonFile(c.manifestFile, null);
  const orig = manifest && manifest.statusLine && manifest.statusLine.original;
  let originalOut = '';
  if (orig && typeof orig.command === 'string' && orig.command) originalOut = await runOriginal(orig.command, input);
  process.stdout.write(composeStatus(originalOut, await counterLine(c.dataDir)) + '\n');
  return 0;
}

// ---------------------------------------------------------------- verify / doctor

async function doVerify(c, flags) {
  const config = readJsonFile(c.configFile, null);
  if (!config) { c.err('Token Ledger is not set up on this computer (no config.json). Run: token-ledger install --yes'); return 3; }
  const port = Number.isInteger(config.port) ? config.port : c.defaultPort;
  let ok = true;
  const h = await httpGetJson(port, '/healthz');
  if (h && h.status === 200 && h.body && h.body.ok) c.out(`✓ Collector answers on 127.0.0.1:${port} (version ${h.body.version || '?'})`);
  else {
    c.out(`… Collector not answering on 127.0.0.1:${port}; starting it`);
    cli(c, ['ensure'], { port });
    if (await waitHealth(port, 5000)) c.out('✓ Collector started');
    else { c.out(`✗ Collector is not running. See ${join(c.dataDir, 'collector.log')}`); ok = false; }
  }
  let st = null;
  try { st = readSettings(c.settingsFile); } catch (e) { c.out(`✗ ${e.message}`); ok = false; }
  const mode = (config.telemetry && config.telemetry.mode) || 'otel';
  if (st) {
    const want = ourEnv(port);
    const env = st.data.env || {};
    const missing = Object.keys(want).filter((k) => env[k] !== want[k]);
    if (mode === 'otel') {
      if (missing.length) { c.out(`✗ settings.json is missing: ${missing.join(', ')} (run: token-ledger install --yes)`); ok = false; }
      else c.out('✓ Telemetry settings present in settings.json');
    } else c.out(`• Live OTel not used: ${config.telemetry.reason || 'transcript sync mode'}`);
  }
  if (!flags.live) {
    c.out(ok ? 'Basic checks passed. Run `token-ledger verify --live` to send one real request.' : 'Some checks failed.');
    return ok ? 0 : 1;
  }
  if (!ok) { c.out('Fix the problems above before the live check.'); return 1; }
  const before = summaryJson(c);
  const b = before && typeof before.requests === 'number' ? before : { requests: 0, total: 0 };
  c.out('… Sending one small real request: claude -p "Reply with the single word: ok"');
  const { cmd, args, shell } = claudeCommand(c.env, ['-p', flags.prompt || 'Reply with the single word: ok']);
  const r = spawnSync(cmd, args, { env: c.env, encoding: 'utf8', timeout: 180_000, shell, windowsHide: true, input: '' });
  if (r.error || r.status !== 0) {
    c.out(`✗ claude -p failed (${r.error ? r.error.code || r.error.message : 'exit ' + r.status}). ${String(r.stderr || '').trim().slice(0, 300)}`);
    c.out('  Check that Claude Code is signed in (run `claude` once) and on PATH.');
    return 1;
  }
  const waitMs = Math.min(Number(flags.timeout) > 0 ? Number(flags.timeout) * 1000 : 30_000, 300_000);
  const until = Date.now() + waitMs;
  let synced = false;
  for (;;) {
    await new Promise((x) => setTimeout(x, 1500));
    if (!synced && (mode !== 'otel' || Date.now() > until - waitMs / 2)) { cli(c, ['sync'], { timeout: 60_000 }); synced = true; }
    const s = summaryJson(c);
    if (s && typeof s.requests === 'number' && s.requests > b.requests) {
      const n = s.requests - b.requests;
      c.out(`Verified: a real Claude Code request reached the ledger (${n} new request${n === 1 ? '' : 's'}, +${(s.total - b.total).toLocaleString('en-US')} tokens since the check began).`);
      return 0;
    }
    if (Date.now() > until) break;
  }
  c.out(`✗ No new request reached the ledger within ${Math.round(waitMs / 1000)} s.`);
  if (mode === 'otel') {
    c.out('  Most likely: this Claude Code process started before setup changed settings.json, or managed settings override telemetry.');
    c.out(`  ${RESTART_NOTE}. Then run token-ledger verify --live again. Diagnostics: token-ledger doctor`);
  } else c.out('  Transcript sync found nothing new. Diagnostics: token-ledger doctor');
  return 1;
}

function redactConfig(cfg) {
  const o = structuredClone(cfg || {});
  if (o.forward) {
    if (o.forward.logsEndpoint) o.forward.logsEndpoint = redactUrl(o.forward.logsEndpoint);
    if (o.forward.headers) o.forward.headers = Object.fromEntries(Object.keys(o.forward.headers).map((k) => [k, '<redacted>']));
  }
  if (o.relay) for (const k of Object.keys(o.relay)) if (/token|secret|key/i.test(k)) o.relay[k] = '<redacted>';
  for (const k of Object.keys(o)) if (/token|secret/i.test(k) && typeof o[k] === 'string') o[k] = '<redacted>';
  return o;
}

async function doDoctor(c) {
  c.out(`Claude Token Ledger ${c.version} — doctor`);
  c.out(`OS: ${process.platform} ${os.release()} ${process.arch}`);
  const nv = parseVersion(process.versions.node);
  c.out(`Node.js: ${process.versions.node} ${versionAtLeast(nv, MIN_NODE) ? 'OK' : `TOO OLD (need ${MIN_NODE.join('.')})`} (${process.execPath})`);
  const cv = claudeVersion(c.env);
  c.out(`Claude Code: ${cv.found ? vstr(cv.version) + (versionAtLeast(cv.version, MIN_CLAUDE) ? ' OK' : ` TOO OLD (need ${MIN_CLAUDE.join('.')})`) : 'not found on PATH'}`);
  c.out(`Claude config dir: ${c.claudeDir}`);
  c.out(`Ledger data dir: ${c.dataDir} ${fs.existsSync(c.dataDir) ? '' : '(missing)'}`);
  const cfg = readJsonFile(c.configFile, null);
  c.out(`config.json: ${cfg ? JSON.stringify(redactConfig(cfg)) : 'missing — run token-ledger install'}`);
  const port = cfg && Number.isInteger(cfg.port) ? cfg.port : c.defaultPort;
  const h = await httpGetJson(port, '/healthz');
  c.out(`Collector: ${h && h.body && h.body.ok ? `running on 127.0.0.1:${port} (version ${h.body.version})` : `not answering on 127.0.0.1:${port}`}`);
  try {
    const st = readSettings(c.settingsFile);
    const env = st.data.env || {};
    const want = ourEnv(port);
    for (const k of Object.keys(want)) c.out(`  settings env ${k}: ${env[k] === want[k] ? 'ours' : env[k] === undefined ? 'absent' : 'set to another value'}`);
    const otherOtel = Object.keys(env).filter((k) => /^OTEL_/.test(k) && !(k in want));
    if (otherOtel.length) c.out(`  other OTEL_* keys (left untouched): ${otherOtel.join(', ')}`);
    c.out(`  statusLine: ${st.data.statusLine ? (String(st.data.statusLine.command || '').includes('statusline render') ? 'wrapped by Token Ledger' : 'yours (untouched)') : 'none'}`);
    if (st.data.otelHeadersHelper) c.out('  otelHeadersHelper: present (untouched)');
  } catch (e) { c.out(`  settings.json: ${e.message}`); }
  const shellOtel = Object.keys(c.env).filter((k) => /^OTEL_|^CLAUDE_CODE_ENABLE_TELEMETRY$/.test(k));
  if (shellOtel.length) c.out(`Shell environment telemetry variables (names only): ${shellOtel.join(', ')}`);
  const managed = readManagedSettings(c.env);
  c.out(`Managed settings: ${managed.files.length ? `${managed.files.length} file(s) in ${managed.dir}${managed.pinned.length ? `; pins ${managed.pinned.join(', ')} → authority gap, transcript sync` : '; no telemetry pins'}` : 'none'}`);
  const m = readJsonFile(c.manifestFile, null);
  c.out(`Install manifest: ${m ? `keys ${Object.keys(m.env || {}).join(', ') || '(none)'}; mode ${(m.telemetry && m.telemetry.mode) || '?'}` : 'none'}`);
  const s = summaryJson(c);
  if (s) {
    c.out(`Summary: status ${s.status}, total ${typeof s.total === 'number' ? s.total.toLocaleString('en-US') : '?'}, requests ${s.requests ?? '?'}`);
    for (const g of s.gaps || []) c.out(`  gap: ${g.source} ${g.kind} ×${g.count}`);
  } else c.out('Summary: unavailable');
  return 0;
}

// ---------------------------------------------------------------- entry

export async function run(command, args = [], ctx = {}) {
  const c = makeContext(ctx);
  const { flags, pos } = parseArgs(args);
  try {
    switch (command) {
      case 'install': return await doInstall(c, flags);
      case 'upgrade': return await doInstall(c, { ...flags, yes: true, 'no-import': true }, { upgrade: true });
      case 'uninstall': return await doUninstall(c, flags);
      case 'verify': return await doVerify(c, flags);
      case 'doctor': return await doDoctor(c);
      case 'statusline': {
        const sub = pos[0];
        if (sub === 'wrap') return statuslineWrap(c);
        if (sub === 'unwrap') return statuslineUnwrap(c);
        if (sub === 'render') return await statuslineRender(c);
        c.err('usage: token-ledger statusline wrap | unwrap | render');
        return 2;
      }
      default:
        c.err(`unknown installer command: ${command}`);
        return 2;
    }
  } catch (e) {
    c.err(`${command} failed: ${e && e.message ? e.message : String(e)}`);
    return 1;
  }
}
