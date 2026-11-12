// Ingest/read tokens: random 32 bytes base64url, stored only as sha256 hashes.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const PREFIX = { ingest: 'tl_ing_', read: 'tl_read_' };

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function createToken(store, label, scope, kind = null) {
  if (!PREFIX[scope]) throw new Error(`bad token scope: ${scope}`);
  const token = PREFIX[scope] + randomBytes(32).toString('base64url');
  store.insertToken(hashToken(token), label, scope, kind);
  return token;
}

/** Returns the token's label when valid for `scope`, else null. Revocation is immediate (checked per request). */
export function verifyToken(store, token, scope) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX[scope] || '\0') || token.length > 200) return null;
  const h = hashToken(token);
  const row = store.tokenByHash(h);
  if (!row) return null;
  const a = Buffer.from(row.hash, 'hex');
  const b = Buffer.from(h, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (row.scope !== scope || row.revoked_at) return null;
  const src = store.getSource(row.label);
  if (src && src.revoked_at) return null;
  return row.label;
}

export function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

export function revokeLabel(store, label) {
  return store.revokeLabel(label);
}
