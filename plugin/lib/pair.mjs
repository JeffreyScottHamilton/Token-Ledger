// Pairing: the primary mints an ingest + read token for a new source and packs them into a code.
// THE PAIRING CODE IS A SECRET: anyone holding it can add usage to the primary and read its totals.
// Revoke with `token-ledger source revoke <label>` if it leaks.
import fs from 'node:fs';
import { createToken } from './tokens.mjs';
import { isLabel } from './normalize.mjs';
import { readConfig, writeConfig, writeFileAtomic } from './paths.mjs';
import { isLoopbackHost } from './server.mjs';

export const CODE_PREFIX = 'tlpair1.';

function checkUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('pair: --url must be an absolute URL like https://host:port'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
    throw new Error('pair: the primary URL must use https://');
  }
  return u.origin;
}

/** On the primary. Returns the pairing code (secret). */
export function createPair(store, label, { url, kind = 'remote', caFile } = {}) {
  if (!isLabel(label)) throw new Error('pair: label must match [a-z0-9-]{1,40}');
  if (!url) throw new Error('pair: --url https://host:port (address the secondary will use to reach this collector) is required');
  if (kind !== 'remote' && kind !== 'cloud') throw new Error('pair: --kind must be remote or cloud');
  const origin = checkUrl(url);
  store.upsertSource(label, kind);
  const i = createToken(store, label, 'ingest', kind);
  const r = createToken(store, label, 'read', kind);
  const payload = { u: origin, l: label, i, r };
  if (caFile) payload.ca = fs.readFileSync(caFile, 'utf8');
  return CODE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function parsePairCode(code) {
  if (typeof code !== 'string' || !code.startsWith(CODE_PREFIX)) throw new Error('pair: not a tlpair1 code');
  let p;
  try { p = JSON.parse(Buffer.from(code.slice(CODE_PREFIX.length), 'base64url').toString('utf8')); } catch {
    throw new Error('pair: code is corrupted');
  }
  if (!p || typeof p.u !== 'string' || !isLabel(p.l) || typeof p.i !== 'string' || !p.i.startsWith('tl_ing_') ||
      typeof p.r !== 'string' || !p.r.startsWith('tl_read_')) throw new Error('pair: code is incomplete');
  checkUrl(p.u);
  return p;
}

/** On the secondary. Writes config.relay (config.json 0600) and queues existing records for relay. */
export function joinPair(paths, code, store = null) {
  const p = parsePairCode(code);
  const cfg = readConfig(paths);
  const relay = { url: p.u, label: p.l, ingestToken: p.i, readToken: p.r };
  if (p.ca) {
    writeFileAtomic(paths.relayCa, p.ca);
    relay.caFile = paths.relayCa;
  }
  cfg.relay = relay;
  writeConfig(paths, cfg);
  const queued = store ? store.backfillOutbox() : 0;
  return { url: p.u, label: p.l, queued };
}
