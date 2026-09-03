import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FleetTrustKey } from '@agent-room/room-persistence';

export class TrustStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = code; }
}

interface StoredTrustKey { fleetId?: unknown; keyId?: unknown; publicKey?: unknown }

export async function loadTrustStore(path: string | undefined): Promise<FleetTrustKey[]> {
  if (!path?.trim()) throw new TrustStoreError('trust_store_required', 'AGENT_ROOM_TRUST_STORE is required.');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new TrustStoreError('trust_store_invalid', 'Trust store is unreadable or malformed.'); }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TrustStoreError('trust_store_empty', 'Trust store must contain at least one public key.');
  }
  const seen = new Set<string>();
  return parsed.map((raw: StoredTrustKey) => {
    if (!raw || typeof raw !== 'object' || typeof raw.fleetId !== 'string' || !raw.fleetId.trim() ||
      typeof raw.keyId !== 'string' || !raw.keyId.trim() || !raw.publicKey || typeof raw.publicKey !== 'object') {
      throw new TrustStoreError('trust_store_entry_invalid', 'Trust store entry is incomplete.');
    }
    const id = `${raw.fleetId}\0${raw.keyId}`;
    if (seen.has(id)) throw new TrustStoreError('trust_store_duplicate_key', 'Trust store contains a duplicate fleet/key id.');
    seen.add(id);
    if ('d' in (raw.publicKey as Record<string, unknown>)) {
      throw new TrustStoreError('trust_store_key_invalid', 'Trust store accepts public keys only.');
    }
    let key: KeyObject;
    try { key = createPublicKey({ key: raw.publicKey as JsonWebKey, format: 'jwk' }); }
    catch { throw new TrustStoreError('trust_store_key_invalid', 'Trust store key is not a supported public key.'); }
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new TrustStoreError('trust_store_key_invalid', 'Trust store accepts only public Ed25519 keys.');
    }
    return { fleetId: raw.fleetId, keyId: raw.keyId, publicKey: key };
  });
}
