import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import bs58 from 'bs58';
import { batchWellKnown, batchExtensionKinds, handleBatchPlan, handleBatchVerify } from './x402batch.js';

const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const address = () => bs58.encode(randomBytes(32));

function fixture({ count = 2, balance = '100000000', noSource = false } = {}) {
  // Ephemeral signing key, fictitious accounts/blockhash, and mocked RPC only.
  const key = generateKeyPairSync('ed25519');
  const payer = bs58.encode(Buffer.from(key.publicKey.export({ format: 'jwk' }).x, 'base64url'));
  const source = address(), blockhash = address(), calls = [];
  const destinations = new Map();
  const payments = Array.from({ length: count }, (_, i) => {
    const payTo = address(); destinations.set(payTo, address());
    return { payTo, asset, amount: String(1000 + i) };
  });
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://rpc.fixture.invalid');
    const { method, params } = JSON.parse(init.body); calls.push(method);
    if (method === 'getLatestBlockhash') return Response.json({ result: { value: { blockhash } } });
    assert.equal(method, 'getTokenAccountsByOwner', 'Fixture refuses broadcasts and every other RPC method');
    assert.equal(params[1].mint, asset);
    const owner = params[0], pubkey = owner === payer ? source : destinations.get(owner);
    const value = !pubkey || (owner === payer && noSource) ? [] : [{ pubkey,
      account: { data: { parsed: { info: { tokenAmount: { amount: balance } } } } } }];
    return Response.json({ result: { value } });
  };
  const signed = plan => {
    const unsigned = Buffer.from(plan.unsignedTx, 'base64'); assert.equal(unsigned[0], 0);
    const message = unsigned.subarray(1);
    return Buffer.concat([Buffer.from([1]), sign(null, message, key.privateKey), message]).toString('base64');
  };
  return { request: { network, payer, payments }, env: { SOLANA_RPC_URL: 'https://rpc.fixture.invalid' }, calls, fetchImpl, signed };
}

async function withRpc(f, run) {
  const original = globalThis.fetch; globalThis.fetch = f.fetchImpl;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('historical discovery distinguishes Solana planning kinds from broader reference networks', () => {
  const descriptor = batchWellKnown(); assert.equal(descriptor.x402m, 'v0');
  assert.ok(descriptor.extensions.includes('x402m-batch-v0'));
  const kinds = batchExtensionKinds(); assert.equal(kinds.length, 2);
  assert.ok(kinds.every(kind => kind.network.startsWith('solana:')));
  assert.ok(descriptor.networks.includes('eip155:8453'));
});

test('unsupported and malformed planner requests are rejected before any RPC', async () => {
  const f = fixture();
  await withRpc(f, async () => {
    for (const change of [{ network: 'unsupported' }, { network: 'eip155:8453' }, { payer: '' },
      { payer: 'invalid!' }, { payments: [] }, { payments: Array(9).fill(f.request.payments[0]) },
      { payments: [{ ...f.request.payments[0], amount: 'invalid' }] },
      { payments: [{ ...f.request.payments[0], amount: '0' }] },
      { payments: [{ ...f.request.payments[0], asset: address() }] },
      { payments: [{ ...f.request.payments[0], payTo: 'invalid!' }] }]) {
      const result = await handleBatchPlan(f.env, { ...f.request, ...change });
      assert.equal(result.status, 400); assert.equal(result.body.ok, false);
    }
    assert.deepEqual(f.calls, []);
  });
});

test('eight-payment plan has zero signatures, a finite lifetime and consistent total; nine is rejected', async () => {
  const f = fixture({ count: 8 });
  await withRpc(f, async () => {
    const before = Date.now(), result = await handleBatchPlan(f.env, f.request), after = Date.now();
    assert.equal(result.status, 200); const plan = result.body;
    assert.equal(plan.instructionCount, 8); assert.equal(plan.items.length, 8);
    assert.equal(plan.totalAmount, f.request.payments.reduce((sum, p) => sum + BigInt(p.amount), 0n).toString());
    assert.equal(Buffer.from(plan.unsignedTx, 'base64')[0], 0);
    assert.ok(plan.expiresAt >= before + 90000 && plan.expiresAt <= after + 90000);
    assert.deepEqual((await handleBatchVerify(f.env, { network, plan, paymentHeader: plan.unsignedTx })).body,
      { isValid: false, invalidReason: 'missing_signatures' });
    const calls = f.calls.length;
    assert.equal((await handleBatchPlan(f.env, { ...f.request, payments: [...f.request.payments, f.request.payments[0]] })).status, 400);
    assert.equal(f.calls.length, calls);
  });
});

test('funding and account absence yield explicit planning failures without broadcasting', async () => {
  for (const options of [{ balance: '1' }, { noSource: true }]) {
    const f = fixture(options);
    await withRpc(f, async () => {
      const result = await handleBatchPlan(f.env, f.request);
      assert.equal(result.status, 402); assert.equal(result.body.ok, false);
      assert.deepEqual(f.calls, ['getTokenAccountsByOwner']);
    });
  }
});

test('offline signed plan verifies and rejects changed payer, source, destination, count and required amount', async () => {
  const f = fixture();
  await withRpc(f, async () => {
    const { body: plan } = await handleBatchPlan(f.env, f.request), paymentHeader = f.signed(plan);
    assert.equal((await handleBatchVerify(f.env, { network, plan, paymentHeader })).body.isValid, true);
    const first = plan.items[0];
    for (const [change, reason] of [[{ payer: address() }, 'payer_mismatch'],
      [{ items: plan.items.slice(0, 1) }, 'item_count_mismatch'],
      [{ items: [{ ...first, source: address() }, plan.items[1]] }, 'source_mismatch'],
      [{ items: [{ ...first, destination: address() }, plan.items[1]] }, 'destination_mismatch'],
      [{ items: [{ ...first, amount: String(BigInt(first.amount) + 1n) }, plan.items[1]] }, 'insufficient_amount']]) {
      assert.equal((await handleBatchVerify(f.env, { network, plan: { ...plan, ...change }, paymentHeader })).body.invalidReason, reason);
    }
    const corrupt = Buffer.from(paymentHeader, 'base64'); corrupt[1] ^= 1;
    assert.equal((await handleBatchVerify(f.env, { network, plan, paymentHeader: corrupt.toString('base64') })).body.invalidReason, 'invalid_signature');
    assert.ok(f.calls.every(method => ['getTokenAccountsByOwner', 'getLatestBlockhash'].includes(method)));
  });
});

test('legacy verifier limitations remain visible: overpayment, optional expiry and unbound plan blockhash', async () => {
  const f = fixture();
  await withRpc(f, async () => {
    const { body: plan } = await handleBatchPlan(f.env, f.request), paymentHeader = f.signed(plan);
    const changed = { ...plan, blockhash: address(), expiresAt: undefined,
      items: plan.items.map(item => ({ ...item, amount: String(BigInt(item.amount) - 1n) })) };
    assert.equal((await handleBatchVerify(f.env, { network, plan: changed, paymentHeader })).body.isValid, true);
    assert.equal((await handleBatchVerify(f.env, { network, plan: { ...plan, expiresAt: Date.now() - 1 }, paymentHeader })).body.invalidReason, 'plan_expired');
  });
});
