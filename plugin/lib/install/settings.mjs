// settings.json helpers: read without loss, write atomically preserving key order, indentation and line endings,
// and restore byte-for-byte from a saved copy when the content matches it.
import fs from 'node:fs';
import { dirname } from 'node:path';

/** Read a JSON settings file. Returns { exists, raw, data, format }. Throws a plain Error on invalid JSON. */
export function readSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, raw: null, data: {}, format: defaultFormat() };
    throw e;
  }
  const text = raw.replace(/^﻿/, '');
  let data = {};
  if (text.trim() !== '') {
    try { data = JSON.parse(text); } catch (e) {
      const err = new Error(`settings file is not valid JSON (${file}): ${e.message}. Fix it first; nothing was changed.`);
      err.code = 'SETTINGS_INVALID';
      throw err;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const err = new Error(`settings file must hold a JSON object (${file}); nothing was changed.`);
    err.code = 'SETTINGS_INVALID';
    throw err;
  }
  return { exists: true, raw, data, format: detectFormat(raw) };
}

export function defaultFormat() { return { indent: 2, eol: '\n', finalNewline: true, bom: false }; }

export function detectFormat(raw) {
  const f = defaultFormat();
  if (typeof raw !== 'string') return f;
  f.bom = raw.startsWith('﻿');
  f.eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const m = raw.match(/\n([ \t]+)"/);
  if (m) f.indent = m[1].includes('\t') ? '\t' : m[1].length;
  else if (raw.trim() !== '' && !raw.includes('\n')) f.indent = 0;
  f.finalNewline = /\r?\n$/.test(raw) || raw.trim() === '';
  return f;
}

export function serialize(data, format = defaultFormat()) {
  let s = format.indent === 0 ? JSON.stringify(data) : JSON.stringify(data, null, format.indent);
  if (format.eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  if (format.finalNewline) s += format.eol;
  if (format.bom) s = '﻿' + s;
  return s;
}

/** Order-sensitive deep equality (settings key order matters to us). */
export function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** Atomic write: temp file in the same directory, then rename (retried on Windows locks). */
export function writeAtomic(file, text, mode) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tl-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  const opts = mode ? { mode } : undefined;
  let keepMode;
  try { keepMode = fs.statSync(file).mode & 0o777; } catch { keepMode = undefined; }
  fs.writeFileSync(tmp, text, opts);
  if (keepMode !== undefined && process.platform !== 'win32') { try { fs.chmodSync(tmp, keepMode); } catch { /* ignore */ } }
  let last;
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      last = e;
      const until = Date.now() + 25 * (i + 1);
      while (Date.now() < until) { /* short back-off for transient Windows locks */ }
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  throw last;
}

/**
 * Write `data` to `file`. If `data` equals the parse of one of `candidates` (raw texts saved earlier),
 * write that raw text instead so the file comes back byte-for-byte. Returns true if the file changed.
 */
export function writeSettings(file, data, format, candidates = []) {
  let text = null;
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    try {
      const parsed = c.replace(/^﻿/, '').trim() === '' ? {} : JSON.parse(c.replace(/^﻿/, ''));
      if (sameJson(parsed, data)) { text = c; break; }
    } catch { /* not a candidate */ }
  }
  if (text === null) text = serialize(data, format);
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (current === text) return false;
  writeAtomic(file, text);
  return true;
}
