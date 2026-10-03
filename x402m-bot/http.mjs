import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAgentMcpServer } from './server.mjs';
import { clientFromEnv } from './client.mjs';
export function createHttpBridge({ client, token, expiresAt }) {
  if (!client.agentId || typeof token !== 'string' || token.length < 43 || !Number.isFinite(expiresAt)) throw new Error('Approved identity, strong token and expiry required');
  const secret = Buffer.from('Bearer ' + token);
  let windowStart = 0, count = 0;
  return createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    const supplied = Buffer.from(req.headers.authorization || '');
    if (Date.now() >= expiresAt || supplied.length !== secret.length || !timingSafeEqual(secret, supplied)) { res.writeHead(401).end(); return; }
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    if (Date.now() - windowStart > 60000) { windowStart = Date.now(); count = 0; }
    if (++count > 120) { res.writeHead(429, { 'retry-after': '60' }).end(); return; }
    if (!(req.headers['content-type'] || '').startsWith('application/json')) { res.writeHead(415).end(); return; }
    let rpc;
    try {
      let size = 0; const parts = [];
      for await (const part of req) { size += part.length; if (size > 65536) { res.writeHead(413).end(); return; } parts.push(part); }
      rpc = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== '2.0') { res.writeHead(400).end(); return; }
    } catch { if (!res.headersSent) res.writeHead(400).end(); return; }
    const server = createAgentMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, rpc); }
    catch { if (!res.headersSent) res.writeHead(500).end(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node http.mjs PRIVATE_MCP_CONFIG_JSON');
  if ((await stat(configPath)).mode & 0o077) throw new Error('Configuration must have mode 600');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const entries = Object.values(config.mcpServers || {}).filter(s => s.env?.X402M_AGENT_ID && s.env?.X402M_KEY_FILE);
  if (entries.length !== 1) throw new Error('Select a configuration containing exactly one approved x402m identity');
  const client = await clientFromEnv(entries[0].env);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 24 * 3600000;
  const server = createHttpBridge({ client, token, expiresAt });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.listen(0, '127.0.0.1', async () => {
    const stateFile = join(dirname(configPath), 'http-bridge.json');
    await writeFile(stateFile, JSON.stringify({ port: server.address().port, token, expiresAt, agentId: client.agentId }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ listening: '127.0.0.1', port: server.address().port, expiresAt, stateFile }));
  });
  setTimeout(() => server.close(), 24 * 3600000).unref();
}
