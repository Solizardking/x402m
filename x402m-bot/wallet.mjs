// Wallet-only setup: no agent enrollment or remote requests are necessary.
import { createConnectionServer } from './connect.mjs';
process.umask(0o077);
const { url } = await createConnectionServer({ walletOnly: true });
console.log('Open to create or inspect your local OWS wallet: ' + url);
