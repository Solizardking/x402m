import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { clientFromEnv } from './client.mjs';
import { createAgentMcpServer } from './server.mjs';
import { walletToolsFromEnv } from './ows.mjs';
await createAgentMcpServer(await clientFromEnv(), walletToolsFromEnv()).connect(new StdioServerTransport());
