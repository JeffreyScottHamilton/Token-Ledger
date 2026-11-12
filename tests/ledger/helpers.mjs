// Shared test helpers (not a test file).
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');
export const PROJECTS = join(FIXTURES, 'projects');
export const REPO = join(HERE, '..', '..');
export const CLI = join(REPO, 'plugin', 'bin', 'token-ledger.mjs');

export const CANARIES = ['CANARY_PROMPT_TEXT_ab12', 'CANARY_TOOL_PAYLOAD_c0de', 'canary-email@example.invalid',
  'CANARY_ACCOUNT_UUID_9d04', 'CANARY_ACCOUNT_ID_33aa', 'CANARY_ORG_UUID_51c2', 'CANARY_USER_ID_7f3a',
  'CANARY_PROMPT_ID_0b1e', 'CANARY_REPLY_TEXT_44', 'CANARY_HOSTNAME_e1', 'CANARY_CONTENT_TEXT_f00d', 'CANARY_CWD_PATH',
  'CANARY_PATH', 'req_SYNTHETIC', 'synthetic-session-0001'];

// Totals of the fixtures (input + output + cache_write + cache_read)
export const T = { otel1: 35494, otel2: 1710, tr3: 30055, sub4: 2133 };

export function otlpBody() { return JSON.parse(fs.readFileSync(join(FIXTURES, 'otlp-logs.json'), 'utf8')); }
export function otlpRaw() { return fs.readFileSync(join(FIXTURES, 'otlp-logs.json')); }

const temps = [];
export function tmpDir(prefix = 'tl-test-') {
  const d = fs.mkdtempSync(join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}
export function cleanupTemps() {
  for (const d of temps.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** Copy the fixture projects dir to a temp dir (so tests can mutate it). */
export function copyProjects() {
  const d = tmpDir('tl-proj-');
  fs.cpSync(PROJECTS, d, { recursive: true });
  return d;
}

export function hasOpenssl() {
  try { return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

/** Self-signed cert for localhost/127.0.0.1. Returns {cert, key} file paths or null. */
export function makeCert() {
  if (!hasOpenssl()) return null;
  const d = tmpDir('tl-cert-');
  const cert = join(d, 'cert.pem');
  const key = join(d, 'key.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  return r.status === 0 ? { cert, key } : null;
}

export async function waitFor(fn, ms = 10_000, step = 50) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}
