import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { HostedResponder, healthServer, filterInboxClient } from './server.mjs';
import { readConfig, provisionIdentity, validatePrivateJwk, openPrivateDatabase, ProcessLease, bindJournal } from './state.mjs';
import { initJournal } from '../bot.mjs';

const fixtureKey = () => JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }));
const cleanupStacks = new WeakMap();
const cleanup = (t, action) => {
  if (!cleanupStacks.has(t)) {
    cleanupStacks.set(t, []);
    t.after(async () => { for (const action of cleanupStacks.get(t).reverse()) await action(); });
  }
  cleanupStacks.get(t).push(action);
};
const temporary = t => {
  const path = mkdtempSync(join(tmpdir(), 'x402m-hosted-fixture-'));
  cleanup(t, () => rmSync(path, { recursive: true, force: true })); return path;
};
const enabledEnv = (storage, key = fixtureKey()) => ({ X402M_RESPONDER_ENABLED: '1',
  X402M_STORAGE_DIR: storage, X402M_AGENT_ID: 'approved-fixture-agent', X402M_PRIVATE_JWK: key,
  XAI_API_KEY: 'fixture-provider-secret', X402M_ALLOWED_SENDERS: 'allowed-fixture-sender' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const noNetwork = async () => { throw new Error('Unexpected real network attempt'); };

test('disabled runtime never accesses keys, state, clients or providers; HTTP is read-only', async t => {
  const storage = join(temporary(t), 'unopened'); let calls = 0;
  const runtime = new HostedResponder({ env: { X402M_RESPONDER_ENABLED: '0', X402M_STORAGE_DIR: storage,
    X402M_PRIVATE_JWK: 'invalid-secret', X402M_KEY_FILE: '/missing/secret-file' },
    makeClient: async () => { calls++; }, fetchImpl: async () => { calls++; } });
  await runtime.initialize(); runtime.start(); assert.equal(await runtime.pollOnce(), false);
  assert.equal(calls, 0); assert.equal(existsSync(storage), false);
  const server = healthServer(runtime); await new Promise(r => server.listen(0, '127.0.0.1', r));
  cleanup(t, async () => { await runtime.stop(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(base + '/health'); assert.equal(health.status, 200);
  const data = await health.json(); assert.equal(data.status, 'disabled'); assert.equal(data.configurationNeeded, true);
  assert.equal((await fetch(base + '/ready')).status, 503);
  assert.equal(await (await fetch(base + '/health', { method: 'HEAD' })).text(), '');
  assert.equal((await fetch(base + '/health', { method: 'POST', body: 'private text' })).status, 405);
  assert.equal((await fetch(base + '/mcp')).status, 404);
  assert.equal((await fetch(base + '/' + 'x'.repeat(70))).status, 414);
  assert.ok(JSON.stringify(data).length < 1024); assert.equal(calls, 0);
});

test('enabled incomplete or invalid configuration fails closed before private-state access', async t => {
  const storage = join(temporary(t), 'unopened'); let clients = 0;
  const runtime = new HostedResponder({ env: { X402M_RESPONDER_ENABLED: '1', X402M_STORAGE_DIR: storage,
    X402M_PRIVATE_JWK: 'private-value-that-must-not-appear' }, makeClient: async () => { clients++; }, fetchImpl: noNetwork });
  await runtime.initialize(); assert.equal(runtime.status().configured, false); assert.equal(runtime.status().ready, false);
  assert.equal(runtime.status().errorClass, 'configuration_error'); assert.equal(clients, 0); assert.equal(existsSync(storage), false);
  assert.ok(!JSON.stringify(runtime.status()).includes('private-value')); await runtime.stop();
  const base = enabledEnv(temporary(t));
  for (const overrides of [{ X402M_ALLOWED_SENDERS: '' }, { X402M_ALLOWED_SENDERS: '@handle' },
    { X402M_ALLOWED_SENDERS: 'sender,' }, { X402M_DAILY_LIMIT: 'Infinity' }, { X402M_DAILY_LIMIT: '0' },
    { X402M_JOURNAL: '/outside.sqlite' }, { X402M_PROVIDER: 'https://untrusted.example' }]) {
    assert.throws(() => readConfig({ ...base, ...overrides }));
  }
});

test('injected identity is validated and private; existing different identities are never replaced', t => {
  const storageDir = temporary(t), privateJwk = fixtureKey();
  const first = provisionIdentity({ storageDir, privateJwk });
  assert.equal(statSync(join(storageDir, 'identity')).mode & 0o777, 0o700);
  assert.equal(statSync(first.keyFile).mode & 0o777, 0o600);
  const saved = readFileSync(first.keyFile);
  assert.deepEqual(provisionIdentity({ storageDir, privateJwk }), first);
  assert.throws(() => provisionIdentity({ storageDir, privateJwk: fixtureKey() }), /identity_error/);
  assert.deepEqual(readFileSync(first.keyFile), saved);
  chmodSync(first.keyFile, 0o644);
  assert.throws(() => provisionIdentity({ storageDir, privateJwk }), /identity_error/);
  const absent = join(storageDir, 'invalid-new');
  assert.throws(() => provisionIdentity({ storageDir: absent, privateJwk: '{"kty":"EC"}' }), /identity_error/);
  assert.equal(existsSync(absent), false);
  assert.throws(() => validatePrivateJwk('{"kty":"OKP","crv":"Ed25519","x":"bad","d":"bad"}'), /identity_error/);
});

test('identity file symlinks and a changed journal identity fail closed', t => {
  const storageDir = temporary(t), identity = provisionIdentity({ storageDir, privateJwk: fixtureKey() });
  const link = join(storageDir, 'key-link'); symlinkSync(identity.keyFile, link);
  assert.throws(() => provisionIdentity({ storageDir, keyFile: link }), /identity_error/);
  const db = openPrivateDatabase(join(storageDir, 'journal.sqlite')); cleanup(t, () => db.close());
  assert.equal(bindJournal(db, { agentId: 'one', fingerprint: 'original' }, 1000), 1000);
  assert.equal(bindJournal(db, { agentId: 'one', fingerprint: 'original' }, 2000), 1000);
  assert.throws(() => bindJournal(db, { agentId: 'two', fingerprint: 'replacement' }, 2000), /identity_error/);
});

test('finite singleton lease prevents overlap, including expired lease while a poll lock is held', t => {
  const path = join(temporary(t), 'lease.sqlite'); let now = 1000;
  const a = openPrivateDatabase(path), b = openPrivateDatabase(path);
  cleanup(t, () => { a.close(); b.close(); });
  const first = new ProcessLease(a, { now: () => now, ttlMs: 100 }), second = new ProcessLease(b, { now: () => now, ttlMs: 100 });
  assert.equal(first.acquire(), true); assert.equal(second.acquire(), false);
  now = 1050; assert.equal(first.heartbeat(), true);
  first.beginPoll(); now = 2000;
  assert.equal(second.acquire(), false); assert.throws(() => first.assert(), /lease_lost/);
  first.endPoll(); assert.equal(second.acquire(), true);
  assert.equal(first.heartbeat(), false); first.release(); assert.equal(second.owns(), true);
  second.release(); assert.equal(first.acquire(), true); first.release();
});

test('history pagination excludes diagnostic requests, persists only old prefix and retains current requests', async t => {
  const db = openPrivateDatabase(join(temporary(t), 'journal.sqlite')); cleanup(t, () => db.close()); initJournal(db);
  bindJournal(db, { agentId: 'fixture', fingerprint: 'fixture' }, 1000);
  const afters = [];
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: 'old-' + i, seq: i + 1, created_at: 900, kind: 'request' }))
    .concat([{ id: 'current', seq: 61, created_at: 1100, kind: 'request' }, { id: 'missing-timestamp', seq: 62, kind: 'request' }]);
  const client = filterInboxClient({ execute: async (_cap, args) => {
    afters.push(args.after); return { messages: rows.filter(m => m.seq > args.after).slice(0, args.limit) };
  } }, { db, activationAt: 1000, assertLease() {} });
  const inbox = await client.execute('x402m.inbox', { from: 'sender', limit: 20 });
  assert.deepEqual(inbox.messages.map(m => m.id), ['current']); assert.deepEqual(afters, [0, 50]);
  assert.equal(db.prepare('SELECT cursor FROM hosted_history WHERE sender=?').get('sender').cursor, 60);
  assert.deepEqual((await client.execute('x402m.inbox', { from: 'sender' })).messages.map(m => m.id), ['current']);
});

test('readiness waits for a successful poll and errors never expose upstream private text', async t => {
  const storage = temporary(t); let fail = false;
  const runtime = new HostedResponder({ env: enabledEnv(storage), now: () => 1000,
    makeClient: async () => ({ execute: async () => { if (fail) throw new Error('SECRET TOKEN and private message'); return { messages: [] }; } }), fetchImpl: noNetwork });
  cleanup(t, () => runtime.stop()); await runtime.initialize();
  assert.equal(runtime.status().configured, true); assert.equal(runtime.status().ready, false);
  assert.equal(await runtime.pollOnce(), true); assert.equal(runtime.status().ready, true);
  assert.equal(runtime.status().lastSuccessfulPollAt, 1000);
  fail = true; assert.equal(await runtime.pollOnce(), false); assert.equal(runtime.status().ready, false);
  assert.equal(runtime.status().errorClass, 'poll_error'); assert.ok(!JSON.stringify(runtime.status()).includes('SECRET'));
});

test('a second runtime cannot poll and SIGTERM-style draining retains the lease until work finishes', async t => {
  const storage = temporary(t), env = enabledEnv(storage), started = deferred(), finish = deferred(); let calls = 0;
  const first = new HostedResponder({ env, now: () => 1000, makeClient: async () => ({ execute: async () => {
    calls++; started.resolve(); await finish.promise; return { messages: [] };
  } }), fetchImpl: noNetwork });
  const second = new HostedResponder({ env, now: () => 1000, makeClient: async () => ({ execute: async () => { calls++; return { messages: [] }; } }), fetchImpl: noNetwork });
  await first.initialize(); await second.initialize();
  const work = first.pollOnce(); await started.promise;
  assert.equal(await first.pollOnce(), false); assert.equal(await second.pollOnce(), false); assert.equal(calls, 1);
  const stopped = first.stop(); assert.equal(first.status().ready, false);
  assert.equal(await second.pollOnce(), false); finish.resolve(); await work; await stopped;
  assert.equal(await second.pollOnce(), true); assert.equal(calls, 2); await second.stop();
});

test('restart retries the same durable reply without fresh inference and keeps original activation', async t => {
  const storage = temporary(t), env = enabledEnv(storage); let now = 1000, inference = 0, sendCount = 0, acknowledgements = 0;
  const sent = [];
  const makeClient = async () => ({ execute: async (cap, args) => {
    if (cap === 'x402m.inbox') return { messages: [{ id: 'eligible-request', sender: 'allowed-fixture-sender',
      seq: 1, created_at: 1100, kind: 'request', content: 'fixture request' }] };
    if (cap === 'x402m.send') { sent.push(args); if (++sendCount === 1) throw new Error('ambiguous transport failure'); }
    if (cap === 'x402m.ack') acknowledgements++;
    return { ok: true };
  } });
  const fakeProvider = async () => { inference++; return Response.json({ output: [{ content: [{ type: 'output_text', text: 'saved fixture answer' }] }] }); };
  const first = new HostedResponder({ env, now: () => now, makeClient, fetchImpl: fakeProvider });
  await first.initialize(); assert.equal(await first.pollOnce(), false); assert.equal(inference, 1); assert.equal(acknowledgements, 0);
  assert.equal(first.db.prepare('SELECT content FROM replies WHERE id=?').get('eligible-request').content, 'saved fixture answer');
  await first.stop(); now = 2000;
  const next = new HostedResponder({ env, now: () => now, makeClient, fetchImpl: fakeProvider });
  await next.initialize(); assert.equal(next.activationAt, 1000); assert.equal(await next.pollOnce(), true);
  assert.equal(inference, 1); assert.equal(acknowledgements, 1); assert.deepEqual(sent[0], sent[1]);
  assert.equal(next.db.prepare('SELECT count FROM usage').get().count, 1); await next.stop();
});
