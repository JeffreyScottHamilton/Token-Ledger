import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempEnv, run, OFFLINE, installer, CLI } from './helpers.mjs';

const RAW = '{\n\t"statusLine": {"type": "command", "command": "node -e \\"process.stdin.on(\'data\',d=>process.stdout.write(\'orig:\'+JSON.parse(d).x))\\"", "padding": 2},\n\t"theme": "dark"\n}\n';

test('statusline wrap/unwrap is byte-exact and idempotent', async (t) => {
  const e = tempEnv(RAW); t.after(e.cleanup);
  assert.equal(await run('statusline', ['wrap'], e.ctx), 0);
  const wrapped = e.json();
  assert.deepEqual(Object.keys(wrapped), ['statusLine', 'theme']);
  assert.match(wrapped.statusLine.command, /statusline render$/);
  assert.equal(wrapped.statusLine.padding, 2);
  const h = e.hash();
  assert.equal(await run('statusline', ['wrap'], e.ctx), 0);
  assert.equal(e.hash(), h, 'second wrap is a no-op');
  const m = JSON.parse(fs.readFileSync(join(e.dataDir, 'install-manifest.json'), 'utf8'));
  assert.deepEqual(m.statusLine.original, JSON.parse(RAW).statusLine);
  assert.equal(await run('statusline', ['unwrap'], e.ctx), 0);
  assert.equal(e.read(), RAW);
});

test('render runs the original command with stdin and appends the counter', async (t) => {
  const e = tempEnv(RAW); t.after(e.cleanup);
  assert.equal(await run('statusline', ['wrap'], e.ctx), 0);
  fs.writeFileSync(join(e.dataDir, 'summary.json'), JSON.stringify({ schema: 1, status: 'ok', total: 12483910, requests: 1, generatedAt: new Date().toISOString() }));
  const r = spawnSync(process.execPath, [CLI, 'statusline', 'render'], { env: e.env, input: '{"x":7}', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'orig:7 · Total tracked tokens · 12,483,910\n');
});

test('render without an original prints just the counter; unavailable is never 0', async (t) => {
  const e = tempEnv({}); t.after(e.cleanup);
  assert.equal(await run('statusline', ['wrap'], e.ctx), 0);
  const r = spawnSync(process.execPath, [CLI, 'statusline', 'render'], { env: e.env, input: '{}', encoding: 'utf8' });
  assert.equal(r.stdout, 'Total tracked tokens · unavailable\n');
  assert.equal(await run('statusline', ['unwrap'], e.ctx), 0);
  assert.equal(e.read(), '{}\n');
});

test('uninstall unwraps the status line and restores the original file', async (t) => {
  const e = tempEnv(RAW); t.after(e.cleanup);
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  assert.equal(await run('statusline', ['wrap'], e.ctx), 0);
  assert.equal(await run('uninstall', ['--erase-data'], e.ctx), 0, e.lines.join('\n'));
  assert.equal(e.read(), RAW);
});

test('install never changes an existing statusLine', async (t) => {
  const e = tempEnv(RAW); t.after(e.cleanup);
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  assert.deepEqual(e.json().statusLine, JSON.parse(RAW).statusLine);
  assert.equal(installer.composeStatus('a\n', 'c'), 'a · c');
});
