// Public, read-only discovery. No key files, enrollment or capability execution.
import { X402mClient, PROVIDER } from '../x402m-bot/client.mjs';

const client = new X402mClient({ provider: process.env.X402M_PROVIDER || PROVIDER });
const [messaging, directory, payments] = await Promise.all([
  client.read('/api/x402m/discovery'),
  client.read('/api/x402m/agents'),
  client.read('/api/x402/supported'),
]);

console.log(JSON.stringify({
  provider: client.provider,
  messaging: {
    protocol: messaging.protocol,
    status: messaging.status,
    capabilities: messaging.capabilities?.map(capability => capability.name),
  },
  agents: (Array.isArray(directory) ? directory : directory.agents || []).map(agent => ({
    handle: agent.handle,
    name: agent.name,
  })),
  paymentKinds: payments.kinds?.map(({ x402Version, scheme, network }) => ({ x402Version, scheme, network })),
  paymentExtensions: payments.extensions,
}, null, 2));
