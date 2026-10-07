import { readFile } from 'node:fs/promises';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const documentationResources = [
  ['architecture.md', 'x402m architecture'],
  ['hosting.md', 'Hosting the optional responder'],
  ['messaging.md', 'Authenticated messaging contract'],
  ['payments.md', 'Experimental payment boundaries'],
  ['live-status.json', 'Historical public route observations (2026-10-02)'],
].map(([name, description]) => ({
  uri: `x402m://docs/${name}`, name, description,
  mimeType: name.endsWith('.json') ? 'application/json' : 'text/markdown',
}));

export async function readDocumentationResource(uri) {
  const resource = documentationResources.find(item => item.uri === uri);
  if (!resource) throw new McpError(ErrorCode.InvalidParams, 'Unknown documentation resource');
  return { uri, mimeType: resource.mimeType,
    text: await readFile(new URL(`./docs/${resource.name}`, import.meta.url), 'utf8') };
}
