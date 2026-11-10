#!/usr/bin/env node
// Release audit. Usage: node scripts/audit-release.mjs [DIR]
// DIR is an extracted release tree (default: the repository, restricted to the release allowlist).
// Fails (exit 1) on: a file outside the allowlist, a secret-looking string, a .db/.log/.jsonl outside demo/,
// or an absolute home path. Zero dependencies.
import fs from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOW_DIRS = ['plugin', '.claude-plugin', 'docs', 'demo'];
export const ALLOW_FILES = ['README.md', 'LICENSE', 'CHANGELOG.md'];

const P = (...parts) => new RegExp(parts.join(''), 'g'); // patterns are assembled so this file never matches itself
export const SECRET_PATTERNS = [
  ['ledger ingest token', P('tl_', 'ing_', '[A-Za-z0-9_-]{16,}')],
  ['ledger read token', P('tl_', 'read_', '[A-Za-z0-9_-]{16,}')],
  ['Anthropic API key', P('sk-', 'ant-', '[A-Za-z0-9_-]{16,}')],
  ['GitHub token', P('gh', '[pousr]_', '[A-Za-z0-9]{20,}')],
  ['private key', P('BEGIN', ' [A-Z ]*PRIVATE', ' KEY')],
];
const HOME_PATH = /(?:\/home\/|\/Users\/|[A-Za-z]:\\\\?Users\\\\?)([A-Za-z0-9._-]+)/g;
const HOME_PLACEHOLDERS = new Set(['you', 'me', 'name', 'username', 'user', 'USERNAME', 'runner', 'Shared', 'SYNTHETIC', 'u', 'test', 'example']);
const BAD_EXT = /\.(db|db-wal|db-shm|sqlite|log|jsonl|pem|key|p12|pfx)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

export function allowed(rel) {
  const r = rel.split(sep).join('/');
  if (ALLOW_FILES.includes(r)) return true;
  return ALLOW_DIRS.some((d) => r.startsWith(d + '/'));
}

function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(p, base, out); } else out.push(relative(base, p));
  }
  return out;
}

/** Audit an extracted release tree. strict=true: any file outside the allowlist is a finding. */
export function auditTree(root, { strict = true } = {}) {
  const findings = [];
  let files = walk(root, root, []);
  if (!strict) files = files.filter(allowed);
  for (const rel of files) {
    const r = rel.split(sep).join('/');
    if (!allowed(rel)) { findings.push(`${r}: outside the release allowlist`); continue; }
    if (BAD_EXT.test(r) && !(r.startsWith('demo/') && /\.jsonl$/i.test(r))) findings.push(`${r}: file type not allowed in a release`);
    const buf = fs.readFileSync(join(root, rel));
    if (buf.includes(0)) { findings.push(`${r}: binary file`); continue; }
    const text = buf.toString('utf8');
    for (const [name, re] of SECRET_PATTERNS) { re.lastIndex = 0; if (re.test(text)) findings.push(`${r}: looks like a ${name}`); }
    HOME_PATH.lastIndex = 0;
    for (let m; (m = HOME_PATH.exec(text));) {
      if (!HOME_PLACEHOLDERS.has(m[1])) { findings.push(`${r}: absolute home path (${m[0].slice(0, 12)}…)`); break; }
    }
  }
  return { files: files.length, findings };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  const root = resolve(arg || join(dirname(fileURLToPath(import.meta.url)), '..'));
  const { files, findings } = auditTree(root, { strict: !!arg });
  if (findings.length) {
    console.error(`Release audit FAILED (${findings.length} finding(s)) in ${root}:`);
    for (const f of findings) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`Release audit passed: ${files} files in ${root}`);
}
