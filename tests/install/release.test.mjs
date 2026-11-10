import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

const { auditTree } = await import(pathToFileURL(join(ROOT, 'scripts', 'audit-release.mjs')).href);
const { checkVersions } = await import(pathToFileURL(join(ROOT, 'scripts', 'build-release.mjs')).href);

function tree(files) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'tl-audit-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(join(d, f, '..'), { recursive: true }); fs.writeFileSync(join(d, f), c); }
  return d;
}
const CLEAN = { 'README.md': '# ok\n', 'LICENSE': 'MIT\n', 'plugin/lib/a.mjs': 'export const a = 1;\n', 'demo/t.jsonl': '{}\n' };

test('audit passes a clean tree', (t) => {
  const d = tree(CLEAN); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  assert.deepEqual(auditTree(d).findings, []);
});

test('audit catches a planted secret file', (t) => {
  const d = tree({ ...CLEAN, 'plugin/notes.txt': 'token=' + 'tl_' + 'ing_' + 'A'.repeat(43) + '\n' });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = auditTree(d).findings;
  assert.equal(f.length, 1);
  assert.match(f[0], /plugin\/notes\.txt: looks like a ledger ingest token/);
});

test('audit catches API keys, private keys, databases, logs, home paths and files outside the allowlist', (t) => {
  const d = tree({
    ...CLEAN,
    'docs/a.md': 'sk-' + 'ant-' + 'x'.repeat(30),
    'docs/b.md': '-----BEGIN' + ' RSA PRIVATE' + ' KEY-----',
    'plugin/ledger.db': 'x',
    'plugin/collector.log': 'x',
    'plugin/t.jsonl': '{}',
    'docs/c.md': 'see /' + 'home/' + 'jeffrey/.claude',
    'scripts/x.sh': 'echo',
    '.env': 'A=1',
  });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = auditTree(d).findings.join('\n');
  for (const re of [/a\.md: looks like a Anthropic API key/, /b\.md: looks like a private key/, /ledger\.db: file type/, /collector\.log: file type/,
    /plugin\/t\.jsonl: file type/, /c\.md: absolute home path/, /scripts\/x\.sh: outside the release allowlist/, /\.env: outside the release allowlist/]) assert.match(f, re);
});

test('the repository release paths pass the audit and versions agree', () => {
  assert.deepEqual(auditTree(ROOT, { strict: false }).findings, []);
  assert.equal(checkVersions('v' + checkVersions()), checkVersions());
  assert.throws(() => checkVersions('v9.9.9'), /version mismatch/);
});
