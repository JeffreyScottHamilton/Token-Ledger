// Shared helpers for installer tests: isolated temp homes, never the real ~/.claude.
import fs from 'node:fs';
import os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = join(ROOT, 'plugin', 'bin', 'token-ledger.mjs');
export const installer = await import(pathToFileURL(join(ROOT, 'plugin', 'lib', 'install', 'index.mjs')).href);
export const { run } = installer;

export function tempEnv(settings) {
  const base = fs.mkdtempSync(join(os.tmpdir(), 'tl-install-'));
  const home = join(base, 'home');
  const claudeDir = join(home, '.claude');
  const dataDir = join(base, 'data');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = join(claudeDir, 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeDir, TOKEN_LEDGER_HOME: dataDir,
    TOKEN_LEDGER_MANAGED_SETTINGS_DIR: join(base, 'managed'), TOKEN_LEDGER_PORT: '1',
  };
  const lines = [];
  const ctx = {
    env, home: dataDir, paths: { home: dataDir }, claudeConfigDir: claudeDir, cliPath: CLI, version: '0.1.0',
    out: (s) => lines.push(s), err: (s) => lines.push(s),
  };
  return {
    base, home, claudeDir, dataDir, settingsFile, env, ctx, lines,
    read: () => fs.readFileSync(settingsFile, 'utf8'),
    json: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
    hash: () => crypto.createHash('sha256').update(fs.readFileSync(settingsFile)).digest('hex'),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

export const OFFLINE = ['--yes', '--no-start', '--no-import', '--skip-claude-check'];
