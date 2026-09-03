import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { signAgentCard } from '../packages/room-persistence/dist/index.js';

const [baseUrl, code, cardPath, privatePath, keyId, scheme = 'oauth2'] = process.argv.slice(2);
if (![baseUrl, code, cardPath, privatePath, keyId].every(Boolean)) throw new Error('usage: base-url room-code card-path private-path key-id [scheme]');
const card = JSON.parse(await readFile(cardPath, 'utf8'));
const privateKey = createPrivateKey({ key: JSON.parse(await readFile(privatePath, 'utf8')), format: 'jwk' });
const response = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(code)}/join`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ participant: { name: card.name, role: '', color: '#000000', initials: card.name.slice(0, 2).toUpperCase(), client: 'cc' }, signedCard: signAgentCard(card, keyId, privateKey), scheme }),
});
const result = await response.json();
console.log(JSON.stringify({ ok: response.ok, status: response.status, participant: result?.name ?? null, error: result?.error ?? null }));
if (!response.ok) process.exitCode = 1;
