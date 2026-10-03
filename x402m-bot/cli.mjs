import { clientFromEnv, X402mClient, PROVIDER } from './client.mjs';
import { pathToFileURL } from 'node:url';

export async function discoverX402m({ provider = PROVIDER, fetchImpl = fetch } = {}) {
  // Public discovery never initializes or opens an enrolled private identity.
  const client = new X402mClient({ provider, fetchImpl });
  const [protocol, directory] = await Promise.all([
    client.read('/api/x402m/discovery'), client.read('/api/x402m/agents'),
  ]);
  return { protocol, directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [capability, raw = '{}'] = process.argv.slice(2);
  if (!capability) throw new Error('Usage: node cli.mjs discover | x402m.CAPABILITY JSON');
  const result = capability === 'discover'
    ? await discoverX402m({ provider: process.env.X402M_PROVIDER || PROVIDER })
    : await (await clientFromEnv()).execute(capability, JSON.parse(raw));
  console.log(JSON.stringify(result, null, 2));
}
