// Loopback integration fixture, never a deployable Agent Auth service.
// Synthetic approved identities only; actual Cloudflare dispatcher and clients.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { descriptor, directory, dispatchX402m } from '../cloudflare/x402m.mjs';
import { X402M_CAPABILITIES } from '../x402m-bot/capabilities.mjs';
import { clientFromEnv } from '../x402m-bot/client.mjs';
import assert from 'node:assert/strict';
assert.deepEqual(X402M_CAPABILITIES, descriptor().capabilities);
const publicKeys = JSON.parse(await readFile(process.argv[2], 'utf8'));
const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE x402m_peers(agent_id TEXT PRIMARY KEY,handle TEXT UNIQUE,name TEXT,description TEXT,updated_at INTEGER);
  CREATE TABLE x402m_nonces(agent_id TEXT,jti TEXT,expires_at INTEGER,PRIMARY KEY(agent_id,jti));
  CREATE TABLE x402m_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,sender TEXT,recipient TEXT,
    request_id TEXT,conversation_id TEXT,reply_to TEXT,kind TEXT,content TEXT,fingerprint TEXT,
    created_at INTEGER,expires_at INTEGER,ack_at INTEGER,UNIQUE(sender,request_id));
`);
const db = { prepare(sql) {
  const statement = database.prepare(sql);
  const bound = (args) => ({
    async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
    async first() { return statement.get(...args) ?? null; },
    async all() { return { results: statement.all(...args) }; },
  });
  return { ...bound([]), bind(...args) { return bound(args); } };
} };
let provider;
const server = http.createServer(async (request, response) => {
  const respond = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  try {
    if (request.method === 'GET' && request.url === '/api/x402m/discovery') return respond(200, descriptor());
    if (request.method === 'GET' && request.url === '/api/x402m/agents') return respond(200, { agents: await directory(db) });
    if (request.method !== 'POST' || request.url !== '/api/auth/capability/execute') return respond(404, { error: 'not found' });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const [header, payload, signature, excess] = String(request.headers.authorization || '').replace(/^Bearer /, '').split('.');
    const metadata = JSON.parse(Buffer.from(header, 'base64url'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    const input = JSON.parse(body);
    const key = publicKeys[claims.sub];
    const now = Math.floor(Date.now() / 1000);
    if (excess || !key || metadata.alg !== 'EdDSA' || metadata.typ !== 'agent+jwt'
        || !verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))
        || claims.aud !== `${provider}${request.url}` || claims.htu !== claims.aud || claims.htm !== 'POST'
        || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now || claims.exp <= now || claims.exp - claims.iat > 60
        || claims.ath !== createHash('sha256').update(body).digest('base64url')
        || claims.capabilities?.length !== 1 || claims.capabilities[0] !== input.capability
        || !X402M_CAPABILITIES.some(item => item.name === input.capability)) return respond(403, { error: 'invalid fixture authentication' });
    const result = await dispatchX402m({ DB: db }, { capability: input.capability, args: input.arguments,
      agentSession: { agent: { id: claims.sub } }, endpointCtx: { headers: new Headers({ authorization: request.headers.authorization }) } });
    respond(200, { data: result });
  } catch (error) { respond(400, { error: error.message }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
provider = `http://127.0.0.1:${server.address().port}`;
const nodeClient = await clientFromEnv({ ...process.env, X402M_PROVIDER: provider });
process.stdout.write(JSON.stringify({ type: 'ready', provider }) + '\n');
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  try {
    const command = JSON.parse(line);
    const result = command.capability === 'discover'
      ? await nodeClient.read('/api/x402m/discovery')
      : await nodeClient.execute(command.capability, command.arguments || {});
    process.stdout.write(JSON.stringify({ result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.message }) + '\n'); }
}
server.close(); database.close();
