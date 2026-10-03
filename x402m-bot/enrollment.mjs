import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROVIDER } from './client.mjs';
export const SCOPES = ['x402m.register', 'x402m.send', 'x402m.inbox', 'x402m.ack', 'x402m.link'];
export async function enrollWithSession({ session, name, dir, fetchImpl = fetch }) {
await mkdir(dir, { mode: 0o700 }); // refuses an existing directory: never overwrite identity
const host = generateKeyPairSync('ed25519'), agent = generateKeyPairSync('ed25519');
for (const [label, keys] of [['host', host], ['agent', agent]]) await writeFile(join(dir, `${label}.private.jwk`), JSON.stringify(keys.privateKey.export({ format: 'jwk' })), { mode: 0o600, flag: 'wx' });
async function post(path, body, token) {
  const r = await fetchImpl(PROVIDER + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(`Enrollment HTTP ${r.status}; identity retained in ${dir}`);
  return data;
}
const enrolled = await post('/api/auth/host/create', { name: name + ' host', public_key: host.publicKey.export({ format: 'jwk' }) }, session);
const hostId = enrolled.hostId || enrolled.host_id || enrolled.id;
if (!hostId) throw new Error('Host response did not contain an ID');
await writeFile(join(dir, 'host.json'), JSON.stringify({ hostId }), { mode: 0o600 });
const now = Math.floor(Date.now() / 1000), encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const unsigned = encode({ alg: 'EdDSA', typ: 'host+jwt' }) + '.' + encode({ iss: hostId, aud: PROVIDER + '/api/auth', iat: now, exp: now + 60, jti: randomUUID(), agent_public_key: agent.publicKey.export({ format: 'jwk' }) });
const token = unsigned + '.' + sign(null, Buffer.from(unsigned), host.privateKey).toString('base64url');
const registered = await post('/api/auth/agent/register', { name, mode: 'delegated', capabilities: SCOPES }, token);
await writeFile(join(dir, 'registration.json'), JSON.stringify(registered, null, 2), { mode: 0o600 });
const agentId = registered.agent_id;
if (!agentId) throw new Error('Registration response did not contain agent_id');
return { agentId, keyFile: join(dir, 'agent.private.jwk'), approval: registered.approval };
}
