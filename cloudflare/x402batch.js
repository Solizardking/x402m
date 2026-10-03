// Experimental historical reference only. This repository does not expose a
// settlement service, start RPC calls on import, or enable funded settlement.
// Endpoint names below describe the original Worker integration.
// x402batch.js — x402m meta-protocol: single-signature batch settlement,
// multi-payer/EVM aggregated settlement, public receipts, pulse, referrals,
// and the facilitator registry.
//
// Non-custodial: the facilitator builds unsigned batch transactions and
// verifies + relays client-signed ones. It never signs as authority and never
// holds payer funds. Mirrors the upto.js module pattern (self-contained,
// KV state in env.TELEMETRY).
//
// x402m-batch-v0 endpoints (wired in worker.js):
//   POST /api/x402/batch/plan         build an unsigned N-payment batch tx
//   POST /api/x402/batch/verify       verify a signed batch tx
//   POST /api/x402/batch/settle       settle a signed batch tx (one on-chain tx)
//   POST /api/x402/batch/settle-multi verify+settle N envelopes (multi-payer, Solana+EVM)
//   GET  /api/x402/receipts           public m2m payment tape
//   GET  /api/x402/pulse              24h m2m economy stats
//   GET  /api/x402/facilitators       known-facilitator registry
//   POST /api/x402/facilitators       register a facilitator
//   GET  /.well-known/x402-facilitator discovery document

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BATCH_MAX_ITEMS = 8;
const BATCH_PLAN_TTL_MS = 90_000;
const FACILITATOR_ID = "musebook";

const BATCH_NETWORKS = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
    label: "solana",
    kind: "solana",
    rpc: "https://api.mainnet-beta.solana.com",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    rpcEnv: "SOLANA_RPC_URL",
  },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": {
    label: "solana-devnet",
    kind: "solana",
    rpc: "https://api.devnet.solana.com",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
    rpcEnv: "SOLANA_DEVNET_RPC_URL",
  },
// EVM entries: EIP-3009 TransferWithAuthorization relay.
// (USDC addresses cross-confirmed against Circle's canonical list, 2026-10-01.)
// Settle submits via FACILITATOR_EVM_KEY when configured (503 without it).
  "eip155:8453": {
    label: "base",
    kind: "evm",
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcName: "USD Coin",
    usdcVersion: "2",
    decimals: 6,
    rpcEnv: "BASE_RPC_URL",
  },
  "eip155:84532": {
    label: "base-sepolia",
    kind: "evm",
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcName: "USDC",
    usdcVersion: "2",
    decimals: 6,
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
  },
};
// v1 simple network names -> CAIP-2
const EVM_ALIASES = { base: "eip155:8453", "base-sepolia": "eip155:84532" };

// ---- codecs ---------------------------------------------------------------

function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58ToBytes(s) {
  let num = 0n;
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("invalid base58");
    num = num * 58n + BigInt(v);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < raw.length; i++)
    raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let leading = 0;
  for (const ch of s) {
    if (ch === "1") leading++;
    else break;
  }
  const out = new Uint8Array(leading + raw.length);
  out.set(raw, leading);
  if (out.length === 32) return out;
  if (out.length > 32) return out.slice(out.length - 32);
  const padded = new Uint8Array(32);
  padded.set(out, 32 - out.length);
  return padded;
}
function b58encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  let s = "";
  while (num > 0n) {
    s = B58_ALPHABET[Number(num % 58n)] + s;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s || "1";
}
function readCompactU16(buf, off) {
  let val = 0, shift = 0, i = off;
  for (;;) {
    const b = buf[i++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [val, i];
}
function writeCompactU16(n) {
  const out = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) out.push(b | 0x80);
    else {
      out.push(b);
      break;
    }
  }
  return out;
}

// ---- Solana message parse (subset) ----------------------------------------

function parseMessage(bytes) {
  let off = 0;
  const prefix = bytes[off++];
  let numRequired;
  if (prefix & 0x80) numRequired = bytes[off++];
  else numRequired = prefix;
  const numReadonlySigned = bytes[off++];
  const numReadonlyUnsigned = bytes[off++];
  const [nKeys, o1] = readCompactU16(bytes, off);
  off = o1;
  const keys = [];
  for (let i = 0; i < nKeys; i++) {
    keys.push(bytes.slice(off, off + 32));
    off += 32;
  }
  const blockhash = bytes.slice(off, off + 32);
  off += 32;
  const [nIx, o2] = readCompactU16(bytes, off);
  off = o2;
  const ixs = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = bytes[off++];
    const [nAcct, o3] = readCompactU16(bytes, off);
    off = o3;
    const accounts = [];
    for (let j = 0; j < nAcct; j++) accounts.push(bytes[off++]);
    const [nData, o4] = readCompactU16(bytes, off);
    off = o4;
    const data = bytes.slice(off, off + nData);
    off += nData;
    ixs.push({ programIdIndex, accounts, data });
  }
  return { numRequired, numReadonlySigned, numReadonlyUnsigned, keys, blockhash, ixs };
}
function parseTransaction(bytes) {
  let off = 0;
  const [nSigs, o] = readCompactU16(bytes, off);
  off = o;
  const sigs = [];
  for (let i = 0; i < nSigs; i++) {
    sigs.push(bytes.slice(off, off + 64));
    off += 64;
  }
  const messageBytes = bytes.slice(off);
  return { sigs, messageBytes, msg: parseMessage(messageBytes) };
}
async function ed25519Verify(pubkey, sig, msg) {
  try {
    const key = await crypto.subtle.importKey("raw", pubkey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig, msg);
  } catch {
    return false;
  }
}

// ---- RPC -------------------------------------------------------------------

function solRpcUrl(env, net) {
  return env[net.rpcEnv] || net.rpc;
}
async function solRpc(env, net, method, params) {
  const res = await fetch(solRpcUrl(env, net), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error("rpc error: " + JSON.stringify(j.error).slice(0, 200));
  return j.result;
}
function evmRpcUrl(env, net) {
  return env[net.rpcEnv] || net.rpc;
}
async function evmRpc(env, net, method, params) {
  const res = await fetch(evmRpcUrl(env, net), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error("evm rpc error: " + JSON.stringify(j.error).slice(0, 200));
  return j.result;
}

// ---- Solana batch tx builder -------------------------------------------------
// Builds an UNSIGNED legacy transaction: N TransferChecked instructions,
// payer is fee payer + sole authority. No other instructions allowed.

function findAllTransferChecked(msg) {
  const out = [];
  for (const ix of msg.ixs) {
    const programId = b58encode(msg.keys[ix.programIdIndex]);
    if (programId !== TOKEN_PROGRAM) return null; // strict: token program only
    if (ix.data.length < 10 || ix.data[0] !== 12) return null; // TransferChecked only
    if (ix.accounts.length < 4) return null;
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8);
    const amount = (BigInt(dv.getUint32(4, true)) << 32n) + BigInt(dv.getUint32(0, true));
    out.push({
      source: b58encode(msg.keys[ix.accounts[0]]),
      mint: b58encode(msg.keys[ix.accounts[1]]),
      destination: b58encode(msg.keys[ix.accounts[2]]),
      authority: b58encode(msg.keys[ix.accounts[3]]),
      authorityIndex: ix.accounts[3],
      amount,
    });
  }
  return out;
}

function buildBatchTx({ payer, items, blockhash }) {
  // items: [{ source, destination, mint, amount: bigint|number|string, decimals }]
  const keyList = [payer]; // fee payer / sole signer first
  const writable = new Set([payer]);
  const ixDescs = [];
  for (const it of items) {
    for (const k of [it.source, it.mint, it.destination]) {
      if (!keyList.includes(k)) keyList.push(k);
    }
    writable.add(it.source);
    writable.add(it.destination);
    ixDescs.push(it);
  }
  if (!keyList.includes(TOKEN_PROGRAM)) keyList.push(TOKEN_PROGRAM);
  // order: signer, writable unsigned, readonly unsigned
  const ordered = [payer];
  for (const k of keyList) {
    if (k !== payer && writable.has(k) && !ordered.includes(k)) ordered.push(k);
  }
  const readonlyUnsigned = [];
  for (const k of keyList) {
    if (k !== payer && !writable.has(k) && !ordered.includes(k)) {
      ordered.push(k);
      readonlyUnsigned.push(k);
    }
  }
  const idx = new Map(ordered.map((k, i) => [k, i]));
  const ixs = ixDescs.map((it) => {
    const data = new Uint8Array(10);
    data[0] = 12; // TransferChecked
    const amt = BigInt(it.amount);
    const dv = new DataView(data.buffer, 1, 8);
    dv.setUint32(0, Number(amt & 0xffffffffn), true);
    dv.setUint32(4, Number((amt >> 32n) & 0xffffffffn), true);
    data[9] = it.decimals;
    return {
      programIdIndex: idx.get(TOKEN_PROGRAM),
      accounts: [idx.get(it.source), idx.get(it.mint), idx.get(it.destination), idx.get(payer)],
      data,
    };
  });
  const msg = [];
  msg.push(1, 0, readonlyUnsigned.length); // numRequired, readonlySigned, readonlyUnsigned
  msg.push(...writeCompactU16(ordered.length));
  for (const k of ordered) msg.push(...b58ToBytes(k));
  msg.push(...b58ToBytes(blockhash));
  msg.push(...writeCompactU16(ixs.length));
  for (const ix of ixs) {
    msg.push(ix.programIdIndex);
    msg.push(...writeCompactU16(ix.accounts.length));
    msg.push(...ix.accounts);
    msg.push(...writeCompactU16(ix.data.length));
    msg.push(...ix.data);
  }
  const tx = [0x00, ...msg]; // zero signatures prefix
  return new Uint8Array(tx);
}

// ---- KV --------------------------------------------------------------------

function kv(env) {
  const store = env.TELEMETRY;
  if (!store) throw new Error("KV (TELEMETRY) not bound");
  return store;
}
async function sha256hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- receipts / pulse / referrals / cashback --------------------------------

async function writeReceipt(env, { sig, network, batch, payer, items, ref, facilitator }) {
  const receipt = {
    ts: Date.now(),
    network,
    facilitator: facilitator || FACILITATOR_ID,
    batch: !!batch,
    payer,
    items: items.map((i) => ({ payTo: i.payTo, asset: i.asset, amount: String(i.amount) })),
    tx: sig,
    ...(ref ? { ref: String(ref).slice(0, 64) } : {}),
  };
  await kv(env).put("x402:receipt:" + sig, JSON.stringify(receipt), { expirationTtl: 30 * 86400 });
  // rolling recent index (last 200)
  try {
    const raw = await kv(env).get("x402:receipts:recent");
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(sig);
    await kv(env).put("x402:receipts:recent", JSON.stringify(list.slice(0, 200)), {
      expirationTtl: 30 * 86400,
    });
  } catch { /* best effort */ }
  // $CLAWD cashback points: 1 point per 1 USDC base-unit unit (1e6) settled
  try {
    let total = 0n;
    for (const i of items) total += BigInt(i.amount);
    const points = Number(total / 1_000_000n);
    if (points > 0 && payer) {
      const k = "x402:cashback:" + payer;
      const cur = parseInt((await kv(env).get(k)) || "0", 10) || 0;
      await kv(env).put(k, String(cur + points), { expirationTtl: 90 * 86400 });
    }
  } catch { /* best effort */ }
  // referral volume tally (30d)
  try {
    if (ref) {
      const k = "x402:refvol:" + String(ref).slice(0, 64);
      let total = 0n;
      for (const i of items) total += BigInt(i.amount);
      const cur = BigInt((await kv(env).get(k)) || "0");
      await kv(env).put(k, String(cur + total), { expirationTtl: 30 * 86400 });
    }
  } catch { /* best effort */ }
  return receipt;
}

let pulseCache = null;
export async function handlePulse(env) {
  if (pulseCache && Date.now() - pulseCache.at < 60_000) return { status: 200, body: pulseCache.body };
  const raw = await kv(env).get("x402:receipts:recent").catch(() => null);
  const sigs = raw ? JSON.parse(raw) : [];
  const dayAgo = Date.now() - 86400_000;
  let volume = 0n, count = 0, batchCount = 0;
  const pairs = new Map();
  const referrers = new Map();
  const gets = await Promise.all(
    sigs.slice(0, 200).map((s) => kv(env).get("x402:receipt:" + s).catch(() => null))
  );
  for (const g of gets) {
    if (!g) continue;
    let r;
    try { r = JSON.parse(g); } catch { continue; }
    if (r.ts < dayAgo) continue;
    count++;
    if (r.batch) batchCount++;
    for (const it of r.items || []) {
      volume += BigInt(it.amount || "0");
      const pk = r.payer + "->" + it.payTo;
      pairs.set(pk, (pairs.get(pk) || 0n) + BigInt(it.amount || "0"));
    }
    if (r.ref) {
      let rv = 0n;
      for (const it of r.items || []) rv += BigInt(it.amount || "0");
      const cur = referrers.get(r.ref) || { settlements: 0, volume: 0n };
      cur.settlements += 1;
      cur.volume += rv;
      referrers.set(r.ref, cur);
    }
  }
  const body = {
    ok: true,
    window: "24h",
    settlements: count,
    batchSettlements: batchCount,
    volumeBaseUnits: volume.toString(),
    topPairs: [...pairs.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, 10)
      .map(([pair, v]) => ({ pair, volumeBaseUnits: v.toString() })),
    topReferrers: [...referrers.entries()]
      .sort((a, b) => b[1].settlements - a[1].settlements)
      .slice(0, 10)
      .map(([ref, s]) => ({ ref, settlements: s.settlements, volumeBaseUnits: s.volume.toString() })),
    facilitator: FACILITATOR_ID,
  };
  pulseCache = { at: Date.now(), body };
  return { status: 200, body };
}

export async function handleReceipts(env, url) {
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const raw = await kv(env).get("x402:receipts:recent").catch(() => null);
  const sigs = (raw ? JSON.parse(raw) : []).slice(0, limit);
  const out = [];
  for (const s of sigs) {
    const g = await kv(env).get("x402:receipt:" + s).catch(() => null);
    if (g) {
      try { out.push(JSON.parse(g)); } catch { /* skip */ }
    }
  }
  return { status: 200, body: { ok: true, receipts: out } };
}

// ---- facilitator registry ----------------------------------------------------

export async function handleFacilitators(env) {
  const raw = await kv(env).get("x402:facilitators").catch(() => null);
  const list = raw ? JSON.parse(raw) : [];
  if (!list.some((f) => f.id === FACILITATOR_ID)) {
    list.unshift({
      id: FACILITATOR_ID,
      wellKnown: "https://musebook.trade/.well-known/x402-facilitator",
      networks: Object.keys(BATCH_NETWORKS),
      extensions: ["x402m-batch-v0", "x402m-receipts-v0", "x402m-referral-v0"],
      operator: "clawd",
    });
  }
  return { status: 200, body: { ok: true, facilitators: list } };
}

export async function handleRegisterFacilitator(env, body) {
  const id = String(body.id || "").slice(0, 64);
  const wellKnown = String(body.wellKnown || "").slice(0, 256);
  if (!id || !/^https:\/\//.test(wellKnown))
    return { status: 400, body: { ok: false, error: "id and https wellKnown required" } };
  const raw = await kv(env).get("x402:facilitators").catch(() => null);
  const list = raw ? JSON.parse(raw) : [];
  const entry = {
    id,
    wellKnown,
    networks: Array.isArray(body.networks) ? body.networks.slice(0, 16) : [],
    extensions: Array.isArray(body.extensions) ? body.extensions.slice(0, 16) : [],
    operator: String(body.operator || "").slice(0, 64),
    ts: Date.now(),
  };
  const i = list.findIndex((f) => f.id === id);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  await kv(env).put("x402:facilitators", JSON.stringify(list.slice(0, 100)));
  return { status: 200, body: { ok: true, id } };
}

export function batchWellKnown() {
  const base = "https://musebook.trade";
  return {
    x402m: "v0",
    id: FACILITATOR_ID,
    operator: "clawd",
    description: "Non-custodial x402 facilitator with single-signature batch settlement (x402m meta protocol)",
    endpoints: {
      supported: base + "/api/x402/supported",
      verify: base + "/api/x402/verify",
      settle: base + "/api/x402/settle",
      batchPlan: base + "/api/x402/batch/plan",
      batchVerify: base + "/api/x402/batch/verify",
      batchSettle: base + "/api/x402/batch/settle",
      batchSettleMulti: base + "/api/x402/batch/settle-multi",
      receipts: base + "/api/x402/receipts",
      pulse: base + "/api/x402/pulse",
      facilitators: base + "/api/x402/facilitators",
    },
    networks: Object.keys(BATCH_NETWORKS),
    extensions: ["x402m-batch-v0", "x402m-receipts-v0", "x402m-referral-v0"],
  };
}

export function batchExtensionKinds() {
  return Object.keys(BATCH_NETWORKS)
    .filter((n) => BATCH_NETWORKS[n].kind === "solana")
    .map((network) => ({ x402Version: 1, scheme: "exact", network, extension: "x402m-batch-v0" }));
}

// ---- batch plan ---------------------------------------------------------------

export async function handleBatchPlan(env, body) {
  const net = BATCH_NETWORKS[body.network];
  if (!net || net.kind !== "solana")
    return { status: 400, body: { ok: false, error: "unsupported_network (batch v0: solana only)" } };
  const payer = String(body.payer || "");
  const payments = Array.isArray(body.payments) ? body.payments : [];
  if (!payer || payments.length < 1 || payments.length > BATCH_MAX_ITEMS)
    return { status: 400, body: { ok: false, error: `payments must be 1-${BATCH_MAX_ITEMS} items` } };
  let payerBytes;
  try {
    payerBytes = b58ToBytes(payer);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid payer" } };
  }
  // normalize + validate items (single asset: the network USDC)
  const items = [];
  for (const p of payments) {
    const payTo = String(p.payTo || "");
    const asset = String(p.asset || net.usdc);
    let amount;
    try {
      amount = BigInt(p.amount);
    } catch {
      return { status: 400, body: { ok: false, error: "invalid amount" } };
    }
    if (asset !== net.usdc)
      return { status: 400, body: { ok: false, error: "batch v0: single asset (USDC) only" } };
    if (amount <= 0n) return { status: 400, body: { ok: false, error: "amount must be > 0" } };
    try {
      b58ToBytes(payTo);
    } catch {
      return { status: 400, body: { ok: false, error: "invalid payTo" } };
    }
    items.push({ payTo, asset, amount });
  }
  // resolve payer source ATA + check funding (one RPC call)
  let srcAta, srcBalance = 0n;
  try {
    const accs = await solRpc(env, net, "getTokenAccountsByOwner", [
      payer,
      { mint: net.usdc },
      { encoding: "jsonParsed" },
    ]);
    let best = null;
    for (const a of accs.value || []) {
      const bal = BigInt(a.account.data.parsed.info.tokenAmount.amount);
      if (!best || bal > best.bal) best = { ata: a.pubkey, bal };
    }
    if (!best) return { status: 402, body: { ok: false, error: "payer has no USDC token account" } };
    srcAta = best.ata;
    srcBalance = best.bal;
  } catch (e) {
    return { status: 500, body: { ok: false, error: "rpc_unavailable" } };
  }
  const total = items.reduce((a, i) => a + i.amount, 0n);
  if (srcBalance < total)
    return { status: 402, body: { ok: false, error: "insufficient_balance", balance: srcBalance.toString(), required: total.toString() } };
  // resolve each payTo destination ATA (must exist; payer funds creation out of band in v0)
  const built = [];
  for (const it of items) {
    let dstAccs;
    try {
      dstAccs = await solRpc(env, net, "getTokenAccountsByOwner", [
        it.payTo,
        { mint: net.usdc },
        { encoding: "jsonParsed" },
      ]);
    } catch {
      return { status: 500, body: { ok: false, error: "rpc_unavailable" } };
    }
    const dst = (dstAccs.value || [])[0];
    if (!dst)
      return { status: 402, body: { ok: false, error: "payee_missing_token_account", payTo: it.payTo } };
    built.push({
      source: srcAta,
      destination: dst.pubkey,
      mint: net.usdc,
      amount: it.amount,
      decimals: net.decimals,
      payTo: it.payTo,
      asset: net.usdc,
    });
  }
  // fresh blockhash
  let blockhash;
  try {
    const bh = await solRpc(env, net, "getLatestBlockhash", [{ commitment: "confirmed" }]);
    blockhash = bh.value.blockhash;
  } catch {
    return { status: 500, body: { ok: false, error: "rpc_unavailable" } };
  }
  const txBytes = buildBatchTx({ payer, items: built, blockhash });
  const planId = "x402m:plan:" + (await sha256hex(txBytes)).slice(0, 16);
  const expiresAt = Date.now() + BATCH_PLAN_TTL_MS;
  return {
    status: 200,
    body: {
      ok: true,
      planId,
      network: body.network,
      payer,
      unsignedTx: bytesToB64(txBytes),
      blockhash,
      expiresAt,
      items: built.map((b) => ({
        payTo: b.payTo,
        asset: b.asset,
        amount: b.amount.toString(),
        source: b.source,
        destination: b.destination,
      })),
      totalAmount: total.toString(),
      instructionCount: built.length,
      // x402m-referral-v0: `referral` is an accepted alias for `ref`
      ref: (body.referral || body.ref) ? String(body.referral || body.ref).trim().slice(0, 64) : undefined,
      private: !!body.private,
    },
  };
}

// ---- batch verify ---------------------------------------------------------------

export async function handleBatchVerify(env, body) {
  const net = BATCH_NETWORKS[body.network];
  if (!net || net.kind !== "solana")
    return { status: 400, body: { isValid: false, invalidReason: "unsupported_network" } };
  const plan = body.plan || {};
  if (plan.expiresAt && Date.now() > plan.expiresAt)
    return { status: 200, body: { isValid: false, invalidReason: "plan_expired" } };
  const planItems = Array.isArray(plan.items) ? plan.items : [];
  if (!planItems.length)
    return { status: 200, body: { isValid: false, invalidReason: "missing_plan" } };
  let tx;
  try {
    tx = parseTransaction(b64ToBytes(body.paymentHeader));
  } catch {
    return { status: 200, body: { isValid: false, invalidReason: "invalid_payload" } };
  }
  const { sigs, messageBytes, msg } = tx;
  if (msg.numRequired !== 1 || sigs.length < 1)
    return { status: 200, body: { isValid: false, invalidReason: "missing_signatures" } };
  const payerBytes = msg.keys[0];
  if (!(await ed25519Verify(payerBytes, sigs[0], messageBytes)))
    return { status: 200, body: { isValid: false, invalidReason: "invalid_signature" } };
  const payer = b58encode(payerBytes);
  if (plan.payer && plan.payer !== payer)
    return { status: 200, body: { isValid: false, invalidReason: "payer_mismatch" } };
  // strict allowlist: every instruction must be a TransferChecked for the asset
  const transfers = findAllTransferChecked(msg);
  if (!transfers)
    return { status: 200, body: { isValid: false, invalidReason: "invalid_batch" } };
  if (transfers.length !== planItems.length)
    return { status: 200, body: { isValid: false, invalidReason: "item_count_mismatch" } };
  const seen = new Set();
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const p = planItems[i];
    if (t.mint !== net.usdc || t.mint !== p.asset)
      return { status: 200, body: { isValid: false, invalidReason: "wrong_asset" } };
    if (t.authorityIndex !== 0)
      return { status: 200, body: { isValid: false, invalidReason: "authority_not_payer" } };
    if (t.amount < BigInt(p.amount))
      return { status: 200, body: { isValid: false, invalidReason: "insufficient_amount" } };
    if (t.destination !== p.destination)
      return { status: 200, body: { isValid: false, invalidReason: "destination_mismatch" } };
    if (t.source !== p.source)
      return { status: 200, body: { isValid: false, invalidReason: "source_mismatch" } };
    if (seen.has(t.destination + t.amount.toString()))
      return { status: 200, body: { isValid: false, invalidReason: "duplicate_item" } };
    seen.add(t.destination + t.amount.toString());
    // destination must be a token account owned by payTo (cached 60s)
    try {
      const accs = await solRpc(env, net, "getTokenAccountsByOwner", [
        p.payTo,
        { mint: net.usdc },
        { encoding: "jsonParsed" },
      ]);
      const owned = (accs.value || []).map((a) => a.pubkey);
      if (!owned.includes(t.destination))
        return { status: 200, body: { isValid: false, invalidReason: "wrong_recipient" } };
    } catch {
      return { status: 200, body: { isValid: false, invalidReason: "rpc_unavailable" } };
    }
  }
  return {
    status: 200,
    body: { isValid: true, payer, items: planItems.map((p) => ({ payTo: p.payTo, amount: p.amount })) },
  };
}

// ---- batch settle -----------------------------------------------------------------
// Settles one signed batch tx. The caller must hold the worker's settle
// concurrency guard (shared with single settle).

async function solConfirm(env, net, sig, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  let delay = 500;
  while (Date.now() < deadline) {
    const r = await solRpc(env, net, "getSignatureStatuses", [[sig], { searchTransactionHistory: false }]);
    const st = r.value && r.value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return st;
    if (st && st.err) return st;
    await new Promise((r2) => setTimeout(r2, delay));
    delay = Math.min(delay * 2, 4000);
  }
  return null;
}

export async function handleBatchSettle(env, body) {
  const net = BATCH_NETWORKS[body.network];
  if (!net || net.kind !== "solana")
    return { status: 400, body: { success: false, error: "unsupported_network" } };
  const v = await handleBatchVerify(env, body);
  if (!v.body.isValid)
    return { status: 402, body: { success: false, error: v.body.invalidReason } };
  const plan = body.plan || {};
  let sig;
  try {
    sig = await solRpc(env, net, "sendTransaction", [
      body.paymentHeader,
      { skipPreflight: false, preflightCommitment: "confirmed", encoding: "base64" },
    ]);
  } catch (e) {
    return { status: 500, body: { success: false, error: String(e).slice(0, 200) } };
  }
  const st = await solConfirm(env, net, sig).catch(() => null);
  if (st && st.err)
    return { status: 500, body: { success: false, error: "settlement_failed", transaction: sig } };
  const items = (plan.items || []).map((p) => ({ payTo: p.payTo, asset: p.asset, amount: p.amount }));
  if (!st) {
    // park for the reconciler like single settle does
    try {
      await kv(env).put("x402:pending:" + sig, JSON.stringify({ sig, network: body.network, reason: "batch_confirmation_timeout", ts: Date.now(), attempts: 0 }), { expirationTtl: 86400 });
    } catch { /* best effort */ }
    return {
      status: 202,
      body: { success: true, pending: true, transaction: sig, network: body.network, payer: v.body.payer, items, note: "submitted; confirmation pending — auto-reconciliation active" },
    };
  }
  let receipt = null;
  if (!plan.private) {
    try {
      receipt = await writeReceipt(env, { sig, network: body.network, batch: true, payer: v.body.payer, items, ref: plan.ref });
    } catch { /* best effort */ }
  }
  return {
    status: 200,
    body: { success: true, transaction: sig, network: body.network, payer: v.body.payer, items: items.map((i) => ({ ...i, status: "settled" })), receipt: receipt ? "x402:receipt:" + sig : undefined },
  };
}

// ---- settle-multi: N envelopes, multi-payer, Solana + EVM ----------------------------

function hexToBytes(h) {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b) {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// ---- EIP-712 / EIP-3009 (x402 EVM exact scheme) --------------------------------
// The standard x402 EVM payload is NOT a raw signed tx: it is an EIP-712
// signature over an EIP-3009 TransferWithAuthorization, which the facilitator
// submits on-chain via the token contract's transferWithAuthorization().

function keccak(b) {
  return keccak_256(b);
}
function ethAddrToBytes(a) {
  return hexToBytes(a.toLowerCase().startsWith("0x") ? a : "0x" + a).slice(-20);
}
function abiUint256(v) {
  const out = new Uint8Array(32);
  let n = BigInt(v);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
function abiAddress(a) {
  const out = new Uint8Array(32);
  out.set(ethAddrToBytes(a), 12);
  return out;
}
function abiBytes32(h) {
  const b = hexToBytes(h);
  if (b.length !== 32) throw new Error("bad bytes32");
  return b;
}
function concatBytes(...arrs) {
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
function eip712Digest({ chainId, verifyingContract, name, version, auth }) {
  // typeHash(TransferWithAuthorization(...))
  const typeStr =
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
  const domainTypeStr =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
  const typeHash = keccak(new TextEncoder().encode(typeStr));
  const domainTypeHash = keccak(new TextEncoder().encode(domainTypeStr));
  const domainSep = keccak(
    concatBytes(
      domainTypeHash,
      keccak(new TextEncoder().encode(name)),
      keccak(new TextEncoder().encode(version)),
      abiUint256(chainId),
      abiAddress(verifyingContract)
    )
  );
  const structHash = keccak(
    concatBytes(
      typeHash,
      abiAddress(auth.from),
      abiAddress(auth.to),
      abiUint256(auth.value),
      abiUint256(auth.validAfter),
      abiUint256(auth.validBefore),
      abiBytes32(auth.nonce)
    )
  );
  return keccak(concatBytes(new Uint8Array([0x19, 0x01]), domainSep, structHash));
}
function evmAddressFromPubkey(pub) {
  // pub: 65-byte uncompressed (0x04 prefix) or 64-byte raw
  const raw = pub.length === 65 ? pub.slice(1) : pub;
  const h = keccak(raw);
  return "0x" + bytesToHex(h.slice(-20)).slice(2);
}
function recoverEvmSigner(digest, signatureHex) {
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 65) throw new Error("bad signature length");
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error("bad signature v");
  // @noble/curves v2 'recovered' format: recovery byte FIRST, then r || s.
  // recoverPublicKey hashes the message unless prehash:false (EIP-712 digest
  // is already hashed). It returns a compressed key; decompress for eth addr.
  const recovered = concatBytes(new Uint8Array([v]), sig.slice(0, 64));
  const compressed = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
  return evmAddressFromPubkey(uncompressed).toLowerCase();
}

// minimal RLP encode (for the facilitator's own submission tx)
function rlpEncode(item) {
  let bytes;
  if (item instanceof Uint8Array) bytes = item;
  else if (Array.isArray(item)) {
    const payload = concatBytes(...item.map(rlpEncode));
    return concatBytes(rlpLen(payload.length, 0xc0), payload);
  } else throw new Error("rlp: bad type");
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return concatBytes(rlpLen(bytes.length, 0x80), bytes);
}
function rlpLen(len, base) {
  if (len < 56) return new Uint8Array([base + len]);
  const hex = len.toString(16);
  const blen = hex.length / 2;
  const out = new Uint8Array(1 + blen);
  out[0] = base + 55 + blen;
  for (let i = 0; i < blen; i++) out[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bigToBytesMin(n) {
  n = BigInt(n);
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes("0x" + hex);
}

function resolveEvmNetwork(nameOrCaip) {
  if (BATCH_NETWORKS[nameOrCaip]) return { caip: nameOrCaip, net: BATCH_NETWORKS[nameOrCaip] };
  const caip = EVM_ALIASES[String(nameOrCaip || "").toLowerCase()];
  if (caip && BATCH_NETWORKS[caip]) return { caip, net: BATCH_NETWORKS[caip] };
  return null;
}

// Verify a standard x402 EVM exact payload against its requirements.
// Returns { from, to, value } on success; throws otherwise.
export async function verifyEvmExact(env, paymentPayload, paymentRequirements) {
  const req = paymentRequirements || {};
  const r = resolveEvmNetwork(req.network);
  if (!r || r.net.kind !== "evm") throw new Error("unsupported_network");
  const { caip, net } = r;
  const payload = paymentPayload || {};
  const auth = payload.authorization || {};
  const signature = payload.signature;
  if (!signature || !auth.from || !auth.to || auth.value == null || !auth.nonce)
    throw new Error("invalid_exact_evm_payload");
  const asset = String(req.asset || "");
  if (asset.toLowerCase() !== net.usdc.toLowerCase()) throw new Error("invalid_asset");
  const required = BigInt(req.maxAmountRequired ?? req.amount ?? "0");
  const value = BigInt(auth.value);
  if (required <= 0n || value < required) throw new Error("insufficient_amount");
  if (String(auth.to).toLowerCase() !== String(req.payTo || "").toLowerCase())
    throw new Error("wrong_recipient");
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(auth.validAfter ?? "0");
  const validBefore = BigInt(auth.validBefore ?? "0");
  if (!(validAfter <= BigInt(now) && BigInt(now) < validBefore)) throw new Error("authorization_expired");
  const extra = req.extra || {};
  const name = extra.name || net.usdcName;
  const version = extra.version || net.usdcVersion;
  const digest = eip712Digest({
    chainId: net.chainId,
    verifyingContract: net.usdc,
    name,
    version,
    auth: {
      from: auth.from,
      to: auth.to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: auth.nonce,
    },
  });
  const signer = recoverEvmSigner(digest, signature);
  if (signer !== String(auth.from).toLowerCase()) throw new Error("invalid_exact_evm_payload_signature");
  // replay check: the authorization nonce must be unused on-chain
  try {
    const sel = bytesToHex(keccak(new TextEncoder().encode("authorizationState(address,bytes32)")).slice(0, 4));
    const callData =
      sel +
      bytesToHex(abiAddress(auth.from)).slice(2) +
      bytesToHex(abiBytes32(auth.nonce)).slice(2);
    const used = await evmRpc(env, net, "eth_call", [{ to: net.usdc, data: callData }, "latest"]);
    if (used && BigInt(used) !== 0n) throw new Error("authorization_already_used");
  } catch (e) {
    if (String(e.message || "").includes("authorization_already_used")) throw e;
    // RPC hiccup: fail open on the replay check would be unsafe; fail closed.
    throw new Error("rpc_unavailable");
  }
  return { from: String(auth.from).toLowerCase(), to: String(auth.to).toLowerCase(), value: value.toString(), network: caip, auth, sigHex: String(signature), digest };
}

// Submit a verified EIP-3009 authorization on-chain via the facilitator key.
// Requires env.FACILITATOR_EVM_KEY (hex private key, no 0x needed). The key only
// ever submits other parties' signed authorizations; it never moves its own funds.
export async function settleEvmAuthorization(env, net, verified) {
  const keyHex = (env.FACILITATOR_EVM_KEY || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    const e = new Error("evm_relay_not_configured");
    e.status = 503;
    throw e;
  }
  const priv = hexToBytes("0x" + keyHex);
  const pub = secp256k1.getPublicKey(priv, false);
  const sender = evmAddressFromPubkey(pub);
  const { auth } = verified;
  // transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)
  const sel = bytesToHex(keccak(new TextEncoder().encode("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)")).slice(0, 4));
  const sigBytes = hexToBytes(verified.sigHex);
  const data =
    sel +
    bytesToHex(abiAddress(auth.from)).slice(2) +
    bytesToHex(abiAddress(auth.to)).slice(2) +
    bytesToHex(abiUint256(auth.value)).slice(2) +
    bytesToHex(abiUint256(auth.validAfter)).slice(2) +
    bytesToHex(abiUint256(auth.validBefore)).slice(2) +
    bytesToHex(abiBytes32(auth.nonce)).slice(2) +
    // bytes sig: offset (7*32) + length (65) + padded sig
    bytesToHex(abiUint256(7 * 32)).slice(2) +
    bytesToHex(abiUint256(65)).slice(2) +
    bytesToHex(concatBytes(sigBytes, new Uint8Array(31))).slice(2);
  const [nonceHex, gasPriceHex] = await Promise.all([
    evmRpc(env, net, "eth_getTransactionCount", [sender, "pending"]),
    evmRpc(env, net, "eth_gasPrice", []),
  ]);
  let gasLimit = 120000n;
  try {
    const est = await evmRpc(env, net, "eth_estimateGas", [{ from: sender, to: net.usdc, data }]);
    gasLimit = (BigInt(est) * 12n) / 10n;
  } catch { /* fallback */ }
  const fields = [
    bigToBytesMin(nonceHex),
    bigToBytesMin(gasPriceHex),
    bigToBytesMin(gasLimit),
    ethAddrToBytes(net.usdc),
    new Uint8Array(0),
    hexToBytes(data),
    bigToBytesMin(net.chainId),
    new Uint8Array(0),
    new Uint8Array(0),
  ];
  const msgHash = keccak(rlpEncode(fields));
  // @noble/curves v2: sign returns compact bytes; format:'recovered' prepends
  // the recovery byte. prehash:false — the tx hash is signed directly.
  const rec = secp256k1.sign(msgHash, priv, { format: "recovered", prehash: false });
  const r = BigInt("0x" + bytesToHex(rec.slice(1, 33)).slice(2));
  const s = BigInt("0x" + bytesToHex(rec.slice(33, 65)).slice(2));
  const v = BigInt(net.chainId) * 2n + 35n + BigInt(rec[0]);
  const signed = rlpEncode([
    bigToBytesMin(nonceHex),
    bigToBytesMin(gasPriceHex),
    bigToBytesMin(gasLimit),
    ethAddrToBytes(net.usdc),
    new Uint8Array(0),
    hexToBytes(data),
    bigToBytesMin(v),
    bigToBytesMin(r),
    bigToBytesMin(s),
  ]);
  return await evmRpc(env, net, "eth_sendRawTransaction", [bytesToHex(signed)]);
}

async function evmConfirm(env, net, hash, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  let delay = 1000;
  while (Date.now() < deadline) {
    const r = await evmRpc(env, net, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r && r.blockNumber) return r;
    await new Promise((r2) => setTimeout(r2, delay));
    delay = Math.min(delay * 2, 5000);
  }
  return null;
}

function resolveBatchNetwork(name) {
  if (BATCH_NETWORKS[name]) return { caip: name, net: BATCH_NETWORKS[name] };
  const caip = EVM_ALIASES[String(name || "").toLowerCase()];
  if (caip && BATCH_NETWORKS[caip]) return { caip, net: BATCH_NETWORKS[caip] };
  return null;
}

export async function handleBatchSettleMulti(env, body) {
  const payments = Array.isArray(body.payments) ? body.payments : [];
  if (!payments.length || payments.length > 16)
    return { status: 400, body: { ok: false, error: "payments must be 1-16 envelopes" } };
  const results = [];
  const settled = [];
  // verify phase: fail fast, settle nothing new
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i];
    const rn = resolveBatchNetwork(p.network || (p.paymentRequirements || {}).network);
    if (!rn) {
      results.push({ index: i, success: false, error: "unsupported_network" });
      continue;
    }
    const { caip, net } = rn;
    if (net.kind === "solana") {
      // standard x402 Solana envelope: signature + TransferChecked shape vs requirements
      try {
        const req = p.paymentRequirements || {};
        const tx = parseTransaction(b64ToBytes(p.paymentHeader));
        const { sigs, messageBytes, msg } = tx;
        if (sigs.length < msg.numRequired) throw new Error("missing_signatures");
        for (let j = 0; j < msg.numRequired; j++) {
          if (!(await ed25519Verify(msg.keys[j], sigs[j], messageBytes))) throw new Error("invalid_signature");
        }
        const transfers = findAllTransferChecked(msg);
        if (!transfers || !transfers.length) throw new Error("invalid_exact_svm_payload");
        const asset = String(req.asset || net.usdc);
        const required = BigInt(req.maxAmountRequired ?? "0");
        let sum = 0n;
        for (const t of transfers) {
          if (t.mint !== asset) throw new Error("invalid_asset");
          if (t.authorityIndex !== 0) throw new Error("invalid_exact_svm_payload");
          sum += t.amount;
        }
        if (required > 0n && sum < required) throw new Error("insufficient_amount");
        results.push({ index: i, success: true, phase: "verified", network: caip, payer: b58encode(msg.keys[0]), amount: sum.toString() });
      } catch (e) {
        results.push({ index: i, success: false, error: String(e.message || e).slice(0, 120) });
      }
    } else {
      // EVM: standard x402 exact payload (EIP-712 over EIP-3009 authorization)
      try {
        const req2 = { ...(p.paymentRequirements || {}) };
        if (!req2.network) req2.network = rn.caip; // fall back to envelope-level network
        const v = await verifyEvmExact(env, p.paymentPayload, req2);
        results.push({ index: i, success: true, phase: "verified", network: v.network, from: v.from, to: v.to, amount: v.value, verified: v });
      } catch (e) {
        results.push({ index: i, success: false, error: String(e.message || e).slice(0, 120) });
      }
    }
  }
  // settle phase: only verified items, in parallel
  await Promise.all(
    results.map(async (r) => {
      if (!r.success) return;
      const p = payments[r.index];
      const { caip, net } = resolveBatchNetwork(p.network || (p.paymentRequirements || {}).network);
      try {
        if (net.kind === "solana") {
          const sig = await solRpc(env, net, "sendTransaction", [
            p.paymentHeader,
            { skipPreflight: false, preflightCommitment: "confirmed", encoding: "base64" },
          ]);
          const st = await solConfirm(env, net, sig).catch(() => null);
          r.phase = "settled";
          r.transaction = sig;
          r.confirmed = !!(st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"));
          if (r.confirmed) settled.push({ sig, network: caip, payer: r.payer, items: [{ payTo: (p.paymentRequirements || {}).payTo || "unknown", asset: net.usdc, amount: r.amount }] });
        } else {
          // EVM: submit the verified EIP-3009 authorization via the facilitator key
          const hash = await settleEvmAuthorization(env, net, r.verified);
          const rcpt = await evmConfirm(env, net, hash).catch(() => null);
          r.phase = "settled";
          r.transaction = hash;
          r.confirmed = !!(rcpt && rcpt.status === "0x1");
          if (r.confirmed) settled.push({ sig: hash, network: caip, payer: r.from, items: [{ payTo: r.to, asset: net.usdc, amount: r.amount }] });
        }
      } catch (e) {
        r.success = false;
        r.error = String(e.message || e).slice(0, 160);
        if (e.status) r.status = e.status;
      }
    })
  );
  // one aggregated receipt for the confirmed ones
  let receiptTx = null;
  if (settled.length && !body.private) {
    try {
      const allItems = settled.flatMap((s) => s.items);
      const fakeSig = "multi:" + (await sha256hex(new TextEncoder().encode(JSON.stringify(settled.map((s) => s.sig))))).slice(0, 32);
      await writeReceipt(env, {
        sig: fakeSig,
        network: "multi",
        batch: true,
        payer: settled.length === 1 ? settled[0].payer : "multi",
        items: allItems,
        // x402m-referral-v0: `referral` is an accepted alias for `ref`
        ref: String(body.referral || body.ref || "").trim().slice(0, 64) || undefined,
      });
      receiptTx = "x402:receipt:" + fakeSig;
    } catch { /* best effort */ }
  }
  return { status: 200, body: { ok: true, results, receipt: receiptTx } };
}
