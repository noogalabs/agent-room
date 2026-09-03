import { generateKeyPairSync } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';

const [fleetId, keyId, privatePath, trustPath] = process.argv.slice(2);
if (![fleetId, keyId, privatePath, trustPath].every(Boolean)) throw new Error('usage: fleetId keyId private-path trust-store-path');
for (const path of [privatePath, trustPath]) { try { await readFile(path); throw new Error(`refuse_overwrite:${path}`); } catch (e) { if (e?.code !== 'ENOENT') throw e; } }
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const handle = await open(privatePath, 'wx', 0o600);
try { await handle.writeFile(JSON.stringify(privateKey.export({ format: 'jwk' }))); } finally { await handle.close(); }
await writeFile(trustPath, JSON.stringify([{ fleetId, keyId, publicKey: publicKey.export({ format: 'jwk' }) }], null, 2), { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ fleetId, keyId, privateKeyWritten: true, trustStoreWritten: true }));
