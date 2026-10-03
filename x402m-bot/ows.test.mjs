import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { createSolanaWallet, getSolanaWallet, listSolanaWallets, signSolanaMessage, owsCore, SOLANA_CHAIN, walletToolsFromEnv } from './ows.mjs';
import { createConnectionServer } from './connect.mjs';

const passphrase = 'isolated-test-passphrase-123';
export function verifySolana(address, message, signature) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of address) n = n * 58n + BigInt(alphabet.indexOf(c));
  const raw = Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message), key, signature);
}

test('real OWS creates an encrypted Solana wallet and signs verifiable messages', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'musebook-ows-test-'));
  try {
    assert.throws(() => createSolanaWallet('test', 'short', vault), /12/);
    const wallet = createSolanaWallet('test', passphrase, vault);
    assert.equal(wallet.chainId, SOLANA_CHAIN);
    assert.equal(wallet.derivationPath, "m/44'/501'/0'/0'");
    assert.deepEqual(getSolanaWallet(wallet.id, vault), wallet);
    assert.equal(listSolanaWallets(vault).length, 1);
    assert.throws(() => createSolanaWallet('test', passphrase, vault), /already exists/);
    const path = join(vault, 'wallets', wallet.id + '.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const stored = await readFile(path, 'utf8'), encrypted = JSON.parse(stored);
    assert.equal(encrypted.crypto.cipher, 'aes-256-gcm');
    assert.ok(encrypted.crypto.ciphertext);
    assert.ok(!stored.includes(passphrase));
    assert.deepEqual(Object.keys(wallet).sort(), ['id','name','createdAt','chainId','address','derivationPath'].sort());
    assert.throws(() => signSolanaMessage(wallet.id, 'hello', 'incorrect-passphrase', vault));
    const signed = signSolanaMessage(wallet.id, 'Musebook OWS test', passphrase, vault);
    assert.ok(verifySolana(wallet.address, 'Musebook OWS test', Buffer.from(signed.signature, 'hex')));
    assert.ok(!verifySolana(wallet.address, 'different message', Buffer.from(signed.signature, 'hex')));
  } finally { await rm(vault, { recursive: true, force: true }); }
});

test('delegated OWS signing enforces policies, wallet scope, revocation and credential permissions', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'musebook-ows-policy-'));
  try {
    const core = owsCore(), wallet = createSolanaWallet('agent', passphrase, vault);
    const tokenFile = join(vault, 'agent-token');
    const policy = { id: 'solana-only', name: 'Solana only', version: 1, created_at: new Date().toISOString(), action: 'deny', rules: [{ type: 'allowed_chains', chain_ids: [SOLANA_CHAIN] }] };
    core.createPolicy(JSON.stringify(policy), vault);
    const key = core.createApiKey('test-agent', [wallet.id], ['solana-only'], passphrase, undefined, vault);
    await writeFile(tokenFile, key.token, { mode: 0o600 });
    const agent = walletToolsFromEnv({ OWS_WALLET_ID: wallet.id, OWS_VAULT_PATH: vault, OWS_API_TOKEN_FILE: tokenFile });
    const signed = await agent.signMessage('approved fixture message');
    assert.ok(verifySolana(wallet.address, 'approved fixture message', Buffer.from(signed.signature, 'hex')));
    assert.throws(() => core.signMessage(wallet.id, 'ethereum', 'denied', key.token, 'utf8', 0, vault), /polic|chain/i);
    const other = createSolanaWallet('other', passphrase, vault);
    assert.throws(() => signSolanaMessage(other.id, 'denied', key.token, vault), /scope|access|authoriz|wallet/i);
    await chmod(tokenFile, 0o644);
    await assert.rejects(agent.signMessage('denied'), /private/);
    await chmod(tokenFile, 0o600);
    await writeFile(tokenFile, passphrase);
    await assert.rejects(agent.signMessage('denied'), /owner passphrases/);
    await writeFile(tokenFile, key.token);
    core.revokeApiKey(key.id, vault);
    await assert.rejects(agent.signMessage('denied'), /key|token/i);
    core.createPolicy(JSON.stringify({ ...policy, id: 'expired', rules: [...policy.rules, { type: 'expires_at', timestamp: '2020-01-01T00:00:00Z' }] }), vault);
    const expired = core.createApiKey('expired-agent', [wallet.id], ['expired'], passphrase, undefined, vault);
    await writeFile(tokenFile, expired.token);
    await assert.rejects(agent.signMessage('denied'), /expir|policy/i);
    const readOnly = walletToolsFromEnv({ OWS_WALLET_ID: wallet.id, OWS_VAULT_PATH: vault });
    assert.equal(readOnly.canSign, false);
    await assert.rejects(readOnly.signMessage('denied'), /configure/);
  } finally { await rm(vault, { recursive: true, force: true }); }
});

test('local OWS creation, reviewed SIWS enrollment and MCP configuration; no secret crosses the provider boundary', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'musebook-ows-connect-'));
  const dir = join(temp, 'identity'), vault = join(temp, 'vault');
  const requests = []; let address;
  const fixtureFetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    assert.ok(!options.body.includes(passphrase));
    if (url.endsWith('/challenge')) { address = body.wallet; return Response.json({ ok: true, nonce: 'nonce-fixture', message: 'Review: Musebook sign-in ' + address }); }
    if (url.endsWith('/verify')) {
      assert.equal(body.wallet, address);
      assert.ok(verifySolana(address, body.message, Buffer.from(body.signature, 'base64')));
      return Response.json({ ok: true, token: 'fixture-session' });
    }
    return Response.json({ ok: true });
  };
  const { server, url } = await createConnectionServer({ name: 'OWS fixture', handle: 'ows-fixture', dir, vault, fetchImpl: fixtureFetch,
    enroll: async () => { const { mkdir } = await import('node:fs/promises'); await mkdir(dir); return { agentId: 'fixture-agent', keyFile: join(dir, 'agent.private.jwk'), approval: { user_code: 'TEST' } }; },
    makeClient: async () => ({ execute: async () => ({ ok: true }) }),
  });
  const post = (path, body, origin = new URL(url).origin) => fetch(url + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal((await post('/ows/create', { name: 'denied', passphrase }, 'https://evil.example')).status, 403);
    assert.equal((await post('/ows/list', {}, '')).status, 403);
    assert.equal((await fetch(url + '/ows/list')).status, 403);
    const created = await post('/ows/create', { name: 'local-agent', passphrase }); assert.equal(created.status, 200);
    const { wallet } = await created.json();
    assert.equal(requests.length, 0, 'wallet creation is entirely local');
    const challenge = await (await post('/ows/challenge', { walletId: wallet.id })).json();
    assert.equal((await post('/ows/enroll', { walletId: wallet.id, nonce: 'wrong', passphrase })).status, 400);
    assert.equal((await post('/ows/enroll', { walletId: wallet.id, nonce: challenge.nonce, passphrase: 'wrong-password-123' })).status, 400);
    assert.equal(requests.length, 1, 'wrong password never calls verify');
    const enrolled = await post('/ows/enroll', { walletId: wallet.id, nonce: challenge.nonce, passphrase });
    assert.equal(enrolled.status, 200);
    assert.deepEqual((await enrolled.json()).scopes, ['x402m.register','x402m.send','x402m.inbox','x402m.ack','x402m.link']);
    assert.equal((await post('/approve', {})).status, 200);
    const raw = await readFile(join(dir, 'mcp.json'), 'utf8');
    const env = JSON.parse(raw).mcpServers['musebook-x402m'].env;
    assert.equal(env.OWS_WALLET_ID, wallet.id);
    assert.equal(env.OWS_VAULT_PATH, vault);
    assert.equal(env.OWS_API_TOKEN_FILE, undefined);
    assert.ok(!raw.includes(passphrase) && !raw.includes('fixture-session'));
    assert.equal((await stat(join(dir, 'mcp.json'))).mode & 0o777, 0o600);
    assert.equal((await post('/approve', {})).status, 409);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); }
});
