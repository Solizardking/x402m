import { createPrivateKey, createHash, sign, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
export const PROVIDER = 'https://musebook.trade';
export class X402mClient {
  constructor({ agentId, privateKey, provider = PROVIDER, fetchImpl = fetch }) {
    const url = new URL(provider);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('HTTPS required');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('provider must be an origin');
    this.provider = url.origin; this.agentId = agentId; this.key = privateKey; this.fetch = fetchImpl;
  }
  async read(path) {
    const r = await this.fetch(this.provider + path, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Discovery failed: HTTP ${r.status}`);
    return r.json();
  }
  async execute(capability, args = {}) {
    if (!this.agentId || !this.key) throw new Error('Agent enrollment required; set X402M_AGENT_ID and X402M_KEY_FILE');
    const url = this.provider + '/api/auth/capability/execute';
    const body = JSON.stringify({ capability, arguments: args });
    const now = Math.floor(Date.now() / 1000);
    const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = encode({ alg: 'EdDSA', typ: 'agent+jwt' }) + '.' + encode({ sub: this.agentId, aud: url, iat: now, exp: now + 60, jti: randomUUID(), capabilities: [capability], htm: 'POST', htu: url, ath: createHash('sha256').update(body).digest('base64url') });
    const token = unsigned + '.' + sign(null, Buffer.from(unsigned), this.key).toString('base64url');
    const r = await this.fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
    const result = await r.json();
    if (!r.ok) throw new Error(`Capability failed: HTTP ${r.status}: ${String(result.message || result.error || 'request rejected').slice(0, 200)}`);
    return result.data ?? result;
  }
}
export async function clientFromEnv(env = process.env) {
  let privateKey;
  if (env.X402M_KEY_FILE) {
    const info = await stat(env.X402M_KEY_FILE);
    if ((info.mode & 0o077) !== 0) throw new Error('X402M_KEY_FILE must be private (chmod 600)');
    const jwk = JSON.parse(await readFile(env.X402M_KEY_FILE, 'utf8'));
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d) throw new Error('Expected private Ed25519 agent JWK, not a wallet key');
    privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  }
  return new X402mClient({ agentId: env.X402M_AGENT_ID, privateKey, provider: env.X402M_PROVIDER || PROVIDER });
}
