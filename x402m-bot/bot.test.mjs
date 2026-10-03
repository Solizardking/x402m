import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { X402mClient } from './client.mjs';
import { tick, initJournal } from './bot.mjs';
import { discoverX402m } from './cli.mjs';

test('public CLI discovery reads only public descriptors without enrollment or authorization', async () => {
  const requests = [];
  const result = await discoverX402m({ fetchImpl: async (url, init) => {
    requests.push(url);
    assert.equal(init.redirect, 'error'); assert.equal(init.headers, undefined);
    assert.equal(init.method, undefined); assert.equal(init.body, undefined);
    return Response.json(url.endsWith('/discovery') ? { protocol: 'x402m/1', capabilities: [] } : { agents: [] });
  } });
  assert.deepEqual(requests.sort(), ['https://musebook.trade/api/x402m/agents', 'https://musebook.trade/api/x402m/discovery']);
  assert.equal(result.protocol.protocol, 'x402m/1'); assert.deepEqual(result.directory.agents, []);
});
test('client uses fresh signed, scoped, body-bound JWTs', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const nonces = [];
  const client = new X402mClient({ agentId: 'a', privateKey, fetchImpl: async (url, init) => {
    const [h, p, s] = init.headers.authorization.slice(7).split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.ok(verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
    assert.equal(claims.aud, url); assert.deepEqual(claims.capabilities, ['x402m.inbox']);
    assert.equal(claims.ath, createHash('sha256').update(init.body).digest('base64url'));
    assert.equal(claims.exp - claims.iat, 60); nonces.push(claims.jti);
    return Response.json({ data: { ok: true } });
  } });
  await client.execute('x402m.inbox'); await client.execute('x402m.inbox');
  assert.notEqual(nonces[0], nonces[1]);
});
test('bot retries durable reply without second inference and acks only after delivery', async () => {
  const db = new DatabaseSync(':memory:'); initJournal(db);
  let inference = 0, sends = 0, acks = 0;
  const contents = [];
  const client = { execute: async (cap, args) => {
    if (cap === 'x402m.inbox') return { messages: [{ id: 'msg', sender: 'a', kind: 'request', content: 'help' }, { id: 'loop', sender: 'a', kind: 'response', content: 'hi' }, { id: 'spam', sender: 'unknown', kind: 'request', content: 'bad' }] };
    if (cap === 'x402m.send') { sends++; contents.push(args); if (sends === 1) throw new Error('network lost'); }
    if (cap === 'x402m.ack') acks++;
    return { ok: true };
  } };
  const config = { client, db, apiKey: 'fixture', model: 'test', allowedSenders: new Set(['a']), fetchImpl: async (_url, init) => {
    inference++; assert.equal(JSON.parse(init.body).store, false);
    return Response.json({ output: [{ content: [{ type: 'output_text', text: 'hello' }] }] });
  } };
  await assert.rejects(tick(config), /network lost/); assert.equal(acks, 0);
  await tick(config); assert.equal(inference, 1); assert.equal(acks, 1); assert.deepEqual(contents[0], contents[1]);
});
