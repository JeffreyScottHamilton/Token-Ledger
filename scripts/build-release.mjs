#!/usr/bin/env node
// Build release archives locally (cross-platform alternative to `git archive`).
// Usage: node scripts/build-release.mjs [--out dist]
// Produces dist/token-ledger-<ver>.tar.gz, .zip and SHA256SUMS from the allowlisted paths, then audits the tree.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowed, auditTree } from './audit-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(join(ROOT, p), 'utf8'));

export function versions() {
  return {
    'package.json': readJson('package.json').version,
    'plugin/.claude-plugin/plugin.json': readJson('plugin/.claude-plugin/plugin.json').version,
    '.claude-plugin/marketplace.json': readJson('.claude-plugin/marketplace.json').plugins[0].version,
  };
}

/** All versions must agree (and equal `tag` without the leading v, when given). Returns the version. */
export function checkVersions(tag) {
  const v = versions();
  const set = new Set(Object.values(v));
  if (tag) set.add(String(tag).replace(/^v/, ''));
  if (set.size !== 1) throw new Error(`version mismatch: ${JSON.stringify(v)}${tag ? ` tag=${tag}` : ''}`);
  return [...set][0];
}

function listFiles() {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ls-files failed (run inside the repository)');
  return r.stdout.split('\0').filter(Boolean).filter((f) => allowed(f) && fs.existsSync(join(ROOT, f))).sort();
}

function zip(entries) {
  const parts = []; const central = []; let offset = 0;
  for (const { name, data, mode } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); // fixed DOS time/date (1980-01-01) for reproducible output
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

function tarGz(entries) {
  const blocks = [];
  for (const { name, data, mode } of entries) {
    const h = Buffer.alloc(512);
    let n = name, prefix = '';
    if (Buffer.byteLength(n) > 100) { const i = n.lastIndexOf('/', 154); prefix = n.slice(0, i); n = n.slice(i + 1); }
    if (Buffer.byteLength(n) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long for tar: ${name}`);
    h.write(n, 0); h.write(mode.toString(8).padStart(7, '0') + '\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0' + '00', 257); h.write(prefix, 345);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function build({ out = join(ROOT, 'dist'), tag } = {}) {
  const ver = checkVersions(tag);
  const top = `token-ledger-${ver}`;
  const stage = join(out, top);
  fs.rmSync(stage, { recursive: true, force: true });
  const entries = [];
  for (const f of listFiles()) {
    const data = fs.readFileSync(join(ROOT, f));
    const exec = f === 'plugin/bin/token-ledger' || f === 'plugin/bin/token-ledger.mjs';
    fs.mkdirSync(dirname(join(stage, f)), { recursive: true });
    fs.writeFileSync(join(stage, f), data, { mode: exec ? 0o755 : 0o644 });
    entries.push({ name: `${top}/${f}`, data, mode: exec ? 0o755 : 0o644 });
  }
  const audit = auditTree(stage, { strict: true });
  if (audit.findings.length) throw new Error('release audit failed:\n  - ' + audit.findings.join('\n  - '));
  const artifacts = { [`${top}.tar.gz`]: tarGz(entries), [`${top}.zip`]: zip(entries) };
  let sums = '';
  for (const [name, buf] of Object.entries(artifacts)) {
    fs.writeFileSync(join(out, name), buf);
    sums += `${crypto.createHash('sha256').update(buf).digest('hex')}  ${name}\n`;
  }
  fs.writeFileSync(join(out, 'SHA256SUMS'), sums);
  return { version: ver, stage, files: entries.length, artifacts: Object.keys(artifacts), sums };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    if (a.includes('--check-versions')) { console.log(checkVersions(opt('--tag'))); process.exit(0); }
    const r = build({ out: opt('--out') ? resolve(opt('--out')) : undefined, tag: opt('--tag') });
    console.log(`Built ${r.artifacts.join(', ')} (${r.files} files, version ${r.version})`);
    process.stdout.write(r.sums);
  } catch (e) { console.error(e.message); process.exit(1); }
}
