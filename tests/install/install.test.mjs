import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tempEnv, run, OFFLINE, installer } from './helpers.mjs';

const ORIGINAL = {
  theme: 'dark',
  permissions: { allow: ['Bash(npm test)'] },
  env: { FOO: 'bar', OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://metrics.example:4318' },
  statusLine: { type: 'command', command: 'echo mine', padding: 1 },
  enabledPlugins: { 'x@y': true },
};

test('merge preserves unrelated keys, order, existing env and statusLine', async (t) => {
  const e = tempEnv(ORIGINAL); t.after(e.cleanup);
  assert.equal(await run('install', OFFLINE, e.ctx), 0, e.lines.join('\n'));
  const s = e.json();
  assert.deepEqual(Object.keys(s), Object.keys(ORIGINAL));
  assert.deepEqual(s.permissions, ORIGINAL.permissions);
  assert.deepEqual(s.statusLine, ORIGINAL.statusLine);
  assert.deepEqual(s.enabledPlugins, ORIGINAL.enabledPlugins);
  assert.deepEqual(Object.keys(s.env).slice(0, 3), Object.keys(ORIGINAL.env));
  assert.equal(s.env.FOO, 'bar');
  assert.equal(s.env.OTEL_METRICS_EXPORTER, 'otlp');
  assert.equal(s.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(s.env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.equal(s.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json');
  assert.equal(s.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:47318/v1/logs');
  assert.equal(s.env.OTEL_LOGS_EXPORT_INTERVAL, '5000');
  const backups = fs.readdirSync(join(e.dataDir, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(join(e.dataDir, 'backups', backups[0]), 'utf8'), JSON.stringify(ORIGINAL, null, 2) + '\n');
  const cfg = JSON.parse(fs.readFileSync(join(e.dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.nodePath, process.execPath);
  assert.equal(cfg.port, 47318);
  assert.match(cfg.sourceLabel, /^[a-z0-9-]{1,40}$/);
});

test('second run is a no-op: settings.json byte-identical, one backup, manifest unchanged', async (t) => {
  const e = tempEnv(ORIGINAL); t.after(e.cleanup);
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  const h1 = e.hash();
  const m1 = fs.readFileSync(join(e.dataDir, 'install-manifest.json'), 'utf8');
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  assert.equal(e.hash(), h1);
  assert.equal(fs.readFileSync(join(e.dataDir, 'install-manifest.json'), 'utf8'), m1);
  assert.equal(fs.readdirSync(join(e.dataDir, 'backups')).length, 1);
  assert.ok(e.lines.some((l) => l.includes('already up to date')));
});

test('formatting is preserved: 4-space indent and CRLF', async (t) => {
  const raw = JSON.stringify({ a: 1, env: { B: '2' } }, null, 4).replace(/\n/g, '\r\n') + '\r\n';
  const e = tempEnv(raw); t.after(e.cleanup);
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  const out = e.read();
  assert.ok(out.includes('\r\n    "a": 1'));
  assert.ok(!/[^\r]\n/.test(out));
});

test('missing settings.json is created, and removed again on uninstall', async (t) => {
  const e = tempEnv(); t.after(e.cleanup);
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  assert.equal(e.json().env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.equal(await run('uninstall', ['--erase-data'], e.ctx), 0, e.lines.join('\n'));
  assert.equal(fs.existsSync(e.settingsFile), false);
  assert.equal(fs.existsSync(e.dataDir), false);
});

test('invalid settings.json is never touched', async (t) => {
  const e = tempEnv('{ "a": 1, }'); t.after(e.cleanup);
  assert.equal(await run('install', OFFLINE, e.ctx), 1);
  assert.equal(e.read(), '{ "a": 1, }');
});

test('existing http/json logs exporter becomes forward target', async (t) => {
  const e = tempEnv({ env: { OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com:4318/' } });
  t.after(e.cleanup);
  assert.equal(await run('install', OFFLINE, e.ctx), 0, e.lines.join('\n'));
  const cfg = JSON.parse(fs.readFileSync(join(e.dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.forward.logsEndpoint, 'https://otel.example.com:4318/v1/logs');
  assert.equal(cfg.forward.protocol, 'http/json');
  const env = e.json().env;
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:47318/v1/logs');
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://otel.example.com:4318/', 'generic endpoint (metrics) untouched');
  // second run keeps forward config and stays byte-identical
  const h = e.hash();
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  assert.equal(e.hash(), h);
  assert.equal(JSON.parse(fs.readFileSync(join(e.dataDir, 'config.json'), 'utf8')).forward.logsEndpoint, 'https://otel.example.com:4318/v1/logs');
});

test('existing logs endpoint replaced value is restored on uninstall', async (t) => {
  const orig = { env: { OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://collector.internal:4318/v1/logs' } };
  const e = tempEnv(orig); t.after(e.cleanup);
  const before = e.read();
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  assert.equal(e.json().env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:47318/v1/logs');
  assert.equal(await run('uninstall', ['--keep-data'], e.ctx), 0);
  assert.equal(e.read(), before);
});

for (const proto of ['grpc', 'http/protobuf']) {
  test(`existing ${proto} logs exporter is not hijacked`, async (t) => {
    const orig = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: proto, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example:4317' } };
    const e = tempEnv(orig); t.after(e.cleanup);
    const before = e.read();
    assert.equal(await run('install', OFFLINE, e.ctx), 0);
    assert.equal(e.read(), before, 'settings untouched');
    assert.ok(e.lines.some((l) => l.includes('Live OTel left to your existing collector; Token Ledger uses transcript sync')));
    const cfg = JSON.parse(fs.readFileSync(join(e.dataDir, 'config.json'), 'utf8'));
    assert.equal(cfg.telemetry.mode, 'transcript');
    assert.equal(cfg.forward, undefined);
  });
}

test('managed settings that pin OTel are respected (authority note, no change)', async (t) => {
  const e = tempEnv({ a: 1 }); t.after(e.cleanup);
  const md = e.env.TOKEN_LEDGER_MANAGED_SETTINGS_DIR;
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(join(md, 'managed-settings.json'), JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp' } }));
  const before = e.read();
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  assert.equal(e.read(), before);
  assert.ok(e.lines.some((l) => /managed settings set OTEL_EXPORTER_OTLP_ENDPOINT/.test(l)));
});

test('uninstall removes only our keys, keeps keys the user changed, restores original bytes', async (t) => {
  const e = tempEnv(ORIGINAL); t.after(e.cleanup);
  const before = e.read();
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  assert.equal(await run('uninstall', ['--keep-data'], e.ctx), 0);
  assert.equal(e.read(), before);
  assert.ok(fs.existsSync(join(e.dataDir, 'config.json')), 'data kept');

  // user edits one of our keys and adds a key after install
  assert.equal(await run('install', OFFLINE, e.ctx), 0);
  const s = e.json();
  s.env.OTEL_LOGS_EXPORT_INTERVAL = '60000';
  s.newKey = true;
  fs.writeFileSync(e.settingsFile, JSON.stringify(s, null, 2) + '\n');
  assert.equal(await run('uninstall', ['--keep-data'], e.ctx), 0);
  const after = e.json();
  assert.equal(after.env.OTEL_LOGS_EXPORT_INTERVAL, '60000', 'user-changed key kept');
  assert.equal(after.env.OTEL_LOGS_EXPORTER, undefined);
  assert.equal(after.newKey, true);
  assert.equal(after.env.FOO, 'bar');
});

test('uninstall requires --keep-data or --erase-data', async (t) => {
  const e = tempEnv({}); t.after(e.cleanup);
  assert.equal(await run('uninstall', [], e.ctx), 2);
});

test('sanitizeLabel and version helpers', () => {
  assert.equal(installer.sanitizeLabel('Jeff’s MacBook-Pro.local'), 'jeff-s-macbook-pro');
  assert.equal(installer.sanitizeLabel('***'), 'local');
  assert.ok(installer.versionAtLeast(installer.parseVersion('2.1.322 (Claude Code)'), installer.MIN_CLAUDE));
  assert.ok(!installer.versionAtLeast(installer.parseVersion('2.1.299'), installer.MIN_CLAUDE));
});

test('old Claude Code version is refused with an explanation', async (t) => {
  const e = tempEnv({}); t.after(e.cleanup);
  const fake = join(e.base, 'fake-claude.mjs');
  fs.writeFileSync(fake, "console.log('2.1.250 (Claude Code)');\n");
  e.ctx.env.TOKEN_LEDGER_CLAUDE_BIN = fake;
  assert.equal(await run('install', ['--yes', '--no-start', '--no-import'], e.ctx), 1);
  assert.ok(e.lines.some((l) => /2\.1\.250 is too old/.test(l)));
  assert.equal(e.read(), '{}\n');
});
