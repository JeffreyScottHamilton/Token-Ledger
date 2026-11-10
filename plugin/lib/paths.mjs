// Data-home and Claude config paths. No side effects on import.
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import fs from 'node:fs';

export const VERSION = '0.1.0';
export const DEFAULT_PORT = 47318;
export const IS_WIN = process.platform === 'win32';

export function dataHome(env = process.env) {
  return env.TOKEN_LEDGER_HOME ? resolve(env.TOKEN_LEDGER_HOME) : join(homedir(), '.claude-token-ledger');
}

export function ledgerPaths(home = dataHome()) {
  return {
    home,
    db: join(home, 'ledger.db'),
    summary: join(home, 'summary.json'),
    remoteSummary: join(home, 'remote-summary.json'),
    config: join(home, 'config.json'),
    manifest: join(home, 'install-manifest.json'),
    pid: join(home, 'collector.pid'),
    log: join(home, 'collector.log'),
    backups: join(home, 'backups'),
    relayCa: join(home, 'relay-ca.pem'),
  };
}

export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
}

export function projectsDir(env = process.env) {
  return join(claudeConfigDir(env), 'projects');
}

export function collectorPort(env = process.env) {
  const p = Number(env.TOKEN_LEDGER_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

/** Create the data home with 0700 (POSIX). */
export function ensureHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!IS_WIN) {
    try { fs.chmodSync(home, 0o700); } catch { /* not owner */ }
  }
  return home;
}

/** Atomic write with 0600 (POSIX); retries rename on Windows where the target may be locked. */
export function writeFileAtomic(file, data) {
  ensureHome(dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); lastErr = null; break; } catch (e) {
      lastErr = e;
      if (IS_WIN && i === 2) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* brief spin; rename lock contention is rare */ }
    }
  }
  if (lastErr) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw lastErr;
  }
  if (!IS_WIN) { try { fs.chmodSync(file, 0o600); } catch { /* ignore */ } }
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readConfig(paths) {
  const c = readJson(paths.config, {});
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

export function writeConfig(paths, cfg) {
  writeFileAtomic(paths.config, JSON.stringify(cfg, null, 2) + '\n');
}

/** Label of this computer's own records. */
export function localLabel(cfg) {
  const l = cfg && typeof cfg.label === 'string' ? cfg.label : '';
  if (cfg && cfg.relay && typeof cfg.relay.label === 'string') return cfg.relay.label;
  return /^[a-z0-9-]{1,40}$/.test(l) ? l : 'local';
}
