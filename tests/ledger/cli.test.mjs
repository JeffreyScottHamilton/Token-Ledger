import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir, cleanupTemps, CLI, PROJECTS, waitFor } from './helpers.mjs';

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const home = tmpDir();
let env;
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });

after(() => {
  try { run('stop'); } catch { /* ignore */ }
  cleanupTemps();
});

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('CLI smoke', { timeout: 40_000 }, async () => {
  env = { ...process.env, TOKEN_LEDGER_HOME: home, TOKEN_LEDGER_PORT: String(await freePort()), CLAUDE_CONFIG_DIR: tmpDir() };

  let r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /token-ledger <command>/);

  r = run('summary', '--json');
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).status, 'unavailable');
  assert.equal(run('summary').stdout.trim(), 'Total tracked tokens · unavailable');

  r = run('import', '--dry-run', '--projects', PROJECTS, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).eligible, 3);
  assert.equal(r.stderr, '', 'no warning text on stderr');
  assert.equal(run('import', '--projects', PROJECTS).status, 2, 'import requires --dry-run or --yes');

  r = run('erase', '--yes');
  assert.equal(r.status, 0, r.stderr);
  r = run('summary', '--json');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).status, 'empty');
  assert.equal(run('summary').stdout.trim(), 'Total tracked tokens · 0');

  r = run('import', '--yes', '--projects', PROJECTS);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(run('summary', '--json').stdout).total, 35494 + 30055 + 2133);

  r = run('ensure');
  assert.equal(r.status, 0, r.stderr);
  const pidFile = join(home, 'collector.pid');
  await waitFor(() => fs.existsSync(pidFile), 5000);
  const pid1 = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
  const t0 = Date.now();
  r = run('ensure');
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 2000);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, pid1, 'single collector process');
  assert.equal(run('status').status, 0);

  r = run('source', 'list');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /local/);

  r = run('stop');
  assert.equal(r.status, 0);
  assert.ok(!alive(pid1));
  assert.equal(run('status').status, 3);
});
