// Native OWS runs only in the local connector, never in the hosted frontend.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { open, constants } from 'node:fs/promises';

export const SOLANA_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const require = createRequire(import.meta.url);
let native;
export function owsCore() {
  try { return native ||= require('@open-wallet-standard/core'); }
  catch { throw new Error('OWS native SDK unavailable. Run npm ci --omit=dev on macOS or Linux with Node 22+.'); }
}
export function vaultPath(env = process.env) { return resolve(env.OWS_VAULT_PATH || join(homedir(), '.ows')); }
export function publicWallet(wallet) {
  const account = wallet.accounts.find(a => a.chainId === SOLANA_CHAIN);
  if (!account) throw new Error('This OWS wallet has no Solana account.');
  return { id: wallet.id, name: wallet.name, createdAt: wallet.createdAt, chainId: account.chainId, address: account.address, derivationPath: account.derivationPath };
}
export function ownerCredential(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024 || value.startsWith('ows_key_')) throw new Error('Use an owner passphrase of 12–1024 characters, not an agent API token.');
  return value;
}
export function createSolanaWallet(name, passphrase, vault = vaultPath()) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/.test(name)) throw new Error('Wallet name must be 1–64 letters, numbers, spaces, underscores or hyphens.');
  ownerCredential(passphrase);
  const core = owsCore();
  if (core.listWallets(vault).some(w => w.name === name)) throw new Error('A wallet with this name already exists. Select it instead.');
  return publicWallet(core.createWallet(name, passphrase, 24, vault));
}
export function listSolanaWallets(vault = vaultPath()) {
  return owsCore().listWallets(vault).filter(w => w.accounts.some(a => a.chainId === SOLANA_CHAIN)).map(publicWallet);
}
export function getSolanaWallet(id, vault = vaultPath()) {
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('Select an OWS wallet.');
  return publicWallet(owsCore().getWallet(id, vault));
}
export function signSolanaMessage(id, message, credential, vault = vaultPath()) {
  if (typeof message !== 'string' || !message || Buffer.byteLength(message) > 8192) throw new Error('Message must contain 1–8192 UTF-8 bytes.');
  if (typeof credential !== 'string' || !credential) throw new Error('An OWS credential is required.');
  const wallet = getSolanaWallet(id, vault);
  const { signature } = owsCore().signMessage(wallet.id, SOLANA_CHAIN, message, credential, 'utf8', 0, vault);
  if (!/^[0-9a-f]{128}$/i.test(signature)) throw new Error('OWS returned an invalid Solana signature.');
  return { wallet, signature, encoding: 'hex' };
}
export async function readPrivateCredential(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 2048 || (process.getuid && info.uid !== process.getuid())) throw new Error('Credential file must be owned by you and private (chmod 600).');
    return (await file.readFile('utf8')).trim();
  } finally { await file.close(); }
}

// Only explicitly configured stdio clients get wallet tools. Owner credentials
// are never accepted here; policy denials propagate without an owner fallback.
export function walletToolsFromEnv(env = process.env) {
  if (!env.OWS_WALLET_ID) return null;
  const vault = vaultPath(env), id = env.OWS_WALLET_ID;
  return {
    canSign: Boolean(env.OWS_API_TOKEN_FILE),
    info: () => getSolanaWallet(id, vault),
    async signMessage(message) {
      if (!env.OWS_API_TOKEN_FILE) throw new Error('Owner must configure OWS_API_TOKEN_FILE to enable delegated signing.');
      let token = await readPrivateCredential(env.OWS_API_TOKEN_FILE);
      try {
        if (!/^ows_key_[0-9a-f]{64}$/.test(token)) throw new Error('Delegated signing requires an OWS API token; owner passphrases are not accepted.');
        return signSolanaMessage(id, message, token, vault);
      } finally { token = ''; }
    },
  };
}
