import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpBridge } from './http.mjs';
test('HTTP bridge authenticates before MCP, isolates the approved identity and rejects browser origins', async () => {
  const token = 'a'.repeat(43); const calls = [];
  const bridge = createHttpBridge({ client: { agentId: 'approved', execute: async (cap,args) => { calls.push([cap,args]); return { messages: [] }; } }, token, expiresAt: Date.now()+60000 });
  await new Promise(r => bridge.listen(0,'127.0.0.1',r));
  const url = new URL(`http://127.0.0.1:${bridge.address().port}/mcp`);
  const client = new Client({ name: 'http-test', version: '1' });
  try {
    assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal(calls.length,0);
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:'Bearer '+token}}}));
    const tools = await client.listTools(); assert.ok(tools.tools.some(t=>t.name==='x402m_inbox'));
    const result = await client.callTool({name:'x402m_inbox',arguments:{}});assert.ok(!result.isError);
    assert.deepEqual(calls,[['x402m.inbox',{}]]);
  } finally { await client.close(); await new Promise(r=>bridge.close(r)); }
});
test('expired bridge denies even the correct bearer', async () => {
  const bridge = createHttpBridge({client:{agentId:'a'},token:'a'.repeat(43),expiresAt:Date.now()-1});
  await new Promise(r=>bridge.listen(0,'127.0.0.1',r));
  try { assert.equal((await fetch(`http://127.0.0.1:${bridge.address().port}/mcp`,{headers:{authorization:'Bearer '+'a'.repeat(43)}})).status,401); }
  finally {await new Promise(r=>bridge.close(r));}
});
