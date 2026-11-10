#!/usr/bin/env node
// SessionStart hook: make sure the collector is running. Prints nothing (SessionStart stdout would enter the
// conversation), never fails the session (always exits 0), and gives up after 4 seconds.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

try {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'token-ledger.mjs');
  const env = { ...process.env };
  if (!env.TOKEN_LEDGER_PORT) {
    // The installer may have recorded a non-default port in config.json; the collector takes it from the environment.
    try {
      const home = env.TOKEN_LEDGER_HOME || join(homedir(), '.claude-token-ledger');
      const port = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).port;
      if (Number.isInteger(port) && port > 0 && port < 65536) env.TOKEN_LEDGER_PORT = String(port);
    } catch { /* default port */ }
  }
  spawnSync(process.execPath, ['--no-warnings', cli, 'ensure'], { env, stdio: 'ignore', timeout: 4000, windowsHide: true });
} catch { /* never fail the session */ }
process.exit(0);
