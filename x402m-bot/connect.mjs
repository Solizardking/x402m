// Loopback-only enrollment: signatures come from a browser wallet or local OWS; private
// agent keys and the SIWS session never leave this local process/filesystem.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectionPage } from './connect-page.mjs';
import { createSolanaWallet, listSolanaWallets, getSolanaWallet, signSolanaMessage, ownerCredential, vaultPath } from './ows.mjs';
import { enrollWithSession, SCOPES } from './enrollment.mjs';
import { PROVIDER, clientFromEnv } from './client.mjs';
export async function createConnectionServer({ name = 'Grok Bot', handle = 'grok-local', dir = join(homedir(), '.config/musebook/x402m', handle), vault = vaultPath(), walletOnly = false, fetchImpl = fetch, enroll = enrollWithSession, makeClient = clientFromEnv, templateId = process.env.X402M_TEMPLATE_ID } = {}) {
if (!/^[a-z][a-z0-9_-]{2,31}$/.test(handle)) throw new Error('Invalid handle');
dir = resolve(dir);
await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
const secret = randomBytes(24).toString('hex');
let origin, pending, session, registered, selectedWallet, completed = false, busy = false;
async function post(path, body, token) {
  const r = await fetchImpl(PROVIDER + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(`Musebook returned HTTP ${r.status}`);
  return data;
}
const page = connectionPage(name, handle, walletOnly, secret);
const server = createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${secret}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  if (req.headers.host !== new URL(origin).host || !req.url?.startsWith('/' + secret)) { res.writeHead(403).end(); return; }
  const path = req.url.slice(secret.length + 1);
  if (req.method === 'GET' && path === '') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page); return; }
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST' || req.headers.origin !== origin || !['/challenge','/enroll','/approve','/ows/create','/ows/list','/ows/challenge','/ows/enroll'].includes(path) || (walletOnly && !['/ows/create','/ows/list'].includes(path)) || !(req.headers['content-type'] || '').startsWith('application/json')) { res.writeHead(403).end(JSON.stringify({ error: 'forbidden' })); return; }
  if (busy || completed) { res.writeHead(409).end(JSON.stringify({ error: completed ? 'Already connected; close this page.' : 'Request already in progress' })); return; }
  busy = true;
  try {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('Request too large'); }
    const body = JSON.parse(raw);
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Expected a JSON object');
    let result;
    if (path === '/ows/create') {
      try { result = { wallet: createSolanaWallet(body.name, body.passphrase, vault), vaultPath: vault }; }
      finally { body.passphrase = ''; }
    } else if (path === '/ows/list') {
      result = { wallets: listSolanaWallets(vault) };
    } else if (path === '/challenge' || path === '/ows/challenge') {
      const local = path === '/ows/challenge' ? getSolanaWallet(body.walletId, vault) : null;
      if (local) body.wallet = local.address;
      if (registered) throw new Error('An identity is already enrolled; approve its displayed scopes.');
      if (typeof body.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.wallet)) throw new Error('Invalid wallet');
      const challenge = await post('/api/siws/challenge', { wallet: body.wallet });
      if (!challenge.ok || typeof challenge.message !== 'string' || Buffer.byteLength(challenge.message) > 8192 || typeof challenge.nonce !== 'string' || !challenge.nonce) throw new Error('Invalid sign-in challenge');
      pending = { ...challenge, wallet: body.wallet, owsWalletId: local?.id, expiresAt: Date.now() + 5 * 60000 };
      result = { message: challenge.message, nonce: challenge.nonce };
    } else if (path === '/enroll' || path === '/ows/enroll') {
      if (!pending || Date.now() > pending.expiresAt) throw new Error('Sign-in message expired. Request a new one.');
      if (path === '/ows/enroll') {
        try {
          if (!pending.owsWalletId || body.walletId !== pending.owsWalletId || body.nonce !== pending.nonce) throw new Error('Sign-in challenge mismatch');
          ownerCredential(body.passphrase);
          const signed = signSolanaMessage(pending.owsWalletId, pending.message, body.passphrase, vault);
          body.wallet = signed.wallet.address;
          body.signature = Buffer.from(signed.signature, 'hex').toString('base64');
        } finally { body.passphrase = ''; }
      } else if (pending.owsWalletId) throw new Error('Use OWS to complete this sign-in.');
      if (!pending || body.wallet !== pending.wallet || body.nonce !== pending.nonce || typeof body.signature !== 'string') throw new Error('Sign-in challenge mismatch');
      const verified = await post('/api/siws/verify', { wallet: pending.wallet, nonce: pending.nonce, message: pending.message, signature: body.signature });
      const localWalletId = pending.owsWalletId;
      pending = null;
      if (!verified.ok || !verified.token) throw new Error('Sign-in failed');
      session = verified.token;
      registered = await enroll({ session, name, dir, fetchImpl });
      selectedWallet = localWalletId;
      result = { ...registered, scopes: SCOPES };
    } else {
      if (!registered || !session) throw new Error('Sign in and enroll first');
      await post('/api/auth/agent/approve-capability', { agent_id: registered.agentId, user_code: registered.approval.user_code, action: 'approve', capabilities: SCOPES }, session);
      const client = await makeClient({ X402M_AGENT_ID: registered.agentId, X402M_KEY_FILE: registered.keyFile });
      await client.execute('x402m.register', { handle, name, ...(templateId === 'musebot' ? { templateId: 'musebot' } : {}) });
      const configFile = join(dir, 'mcp.json');
      await writeFile(configFile, JSON.stringify({ mcpServers: { 'musebook-x402m': { command: process.execPath, args: [fileURLToPath(new URL('./mcp.mjs', import.meta.url))], env: { X402M_AGENT_ID: registered.agentId, X402M_KEY_FILE: registered.keyFile, ...(selectedWallet ? { OWS_WALLET_ID: selectedWallet, OWS_VAULT_PATH: vault } : {}) } } } }, null, 2), { mode: 0o600 });
      session = null; completed = true;
      result = { handle, configFile };
      console.log(JSON.stringify({ connected: true, handle, agentId: registered.agentId, configFile }));
    }
    res.end(JSON.stringify(result));
  } catch (e) { res.writeHead(400).end(JSON.stringify({ error: String(e.message).replace(/ows_key_[a-f0-9]+/gi, '[redacted token]') })); }
  finally { busy = false; }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
origin = `http://127.0.0.1:${server.address().port}`;
const timer = setTimeout(() => { session = null; pending = null; server.close(); }, 3600000);
timer.unref(); server.on('close', () => clearTimeout(timer));
return { server, url: origin + '/' + secret };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const { url } = await createConnectionServer({ name: process.argv[2], handle: process.argv[3], dir: process.argv[4] });
  console.log('Open to enroll: ' + url);
}
