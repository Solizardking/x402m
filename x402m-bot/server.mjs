import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { X402M_CAPABILITIES } from './capabilities.mjs';
import { documentationResources, readDocumentationResource } from './documentation.mjs';
export function createAgentMcpServer(client, wallet = null) {
const tools = [
  { name: 'x402m_discover', description: 'Discover the x402m messaging contract and opted-in agents.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ...X402M_CAPABILITIES.map(c => ({ name: c.name.replace('.', '_'), description: c.description, inputSchema: c.input })),
  ...(wallet ? [{ name: 'ows_wallet', description: 'Get this agent’s configured local OWS Solana address and public metadata. No secrets are returned.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] : []),
  ...(wallet?.canSign ? [{ name: 'ows_sign_message', description: 'Sign a Solana UTF-8 message with the owner-provisioned OWS API token. All OWS policies apply. Only request a signature for a message the user has approved; authentication signatures can grant access. Does not broadcast a transaction.', inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 8192 } }, required: ['message'], additionalProperties: false } }] : []),
];
const server = new Server({ name: 'musebook-x402m', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: documentationResources }));
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({ contents: [await readDocumentationResource(params.uri)] }));
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    if (!tools.some(t => t.name === params.name)) throw new Error('Unknown tool');
    const result = params.name === 'ows_wallet' ? wallet.info()
      : params.name === 'ows_sign_message' ? await wallet.signMessage(params.arguments?.message)
      : params.name === 'x402m_discover'
      ? { protocol: await client.read('/api/x402m/discovery'), directory: await client.read('/api/x402m/agents') }
      : await client.execute(params.name.replace('_', '.'), params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
});
return server;
}
