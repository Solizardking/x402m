import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSolanaWallet, owsCore, SOLANA_CHAIN } from './ows.mjs';
import { minerToolsFromEnv } from './ore-tools.mjs';
test('desktop MCP handshake advertises tools and refuses unenrolled private access', async () => {
  const client = new Client({ name: 'desktop-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp.mjs', import.meta.url))], env: {} });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['x402m_ack','x402m_discover','x402m_inbox','x402m_link','x402m_register','x402m_send']);
    const result = await client.callTool({ name: 'x402m_inbox', arguments: {} });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /enrollment required/);
  } finally { await client.close(); }
});

test('public MCP ignores legacy mining configuration and never exposes executor tools', async () => {
  const state = await mkdtemp(join(tmpdir(), 'x402m-public-no-mining-'));
  const client = new Client({ name: 'public-mining-exclusion-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./mcp.mjs', import.meta.url))], env: { ORE_MINER_HOME: state } });
  try {
    assert.equal(minerToolsFromEnv({ ORE_MINER_HOME: state }), null);
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    assert.ok(tools.every(tool => tool.name.startsWith('x402m_')));
    const result = await client.callTool({ name: 'ore_miner_start', arguments: {} });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /Unknown tool/);
  } finally { await client.close(); await rm(state, { recursive: true, force: true }); }
});

test('stdio MCP exposes the selected OWS wallet and only enables signing with an explicit token file', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'musebook-ows-mcp-'));
  const passphrase = 'mcp-test-only-passphrase-123';
  try {
    const wallet = createSolanaWallet('mcp-wallet', passphrase, vault);
    const core = owsCore();
    core.createPolicy(JSON.stringify({ id: 'solana', name: 'Solana', version: 1, created_at: new Date().toISOString(), rules: [{ type: 'allowed_chains', chain_ids: [SOLANA_CHAIN] }], action: 'deny' }), vault);
    const key = core.createApiKey('mcp-test', [wallet.id], ['solana'], passphrase, undefined, vault);
    const tokenFile = join(vault, 'token');
    await writeFile(tokenFile, key.token, { mode: 0o600 });
    for (const enabled of [false, true]) {
      const client = new Client({ name: 'ows-mcp-test', version: '1.0.0' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp.mjs', import.meta.url))], env: { OWS_WALLET_ID: wallet.id, OWS_VAULT_PATH: vault, ...(enabled ? { OWS_API_TOKEN_FILE: tokenFile } : {}) } });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        assert.ok(tools.some(t => t.name === 'ows_wallet'));
        assert.equal(tools.some(t => t.name === 'ows_sign_message'), enabled);
        const info = await client.callTool({ name: 'ows_wallet', arguments: {} });
        assert.equal(JSON.parse(info.content[0].text).address, wallet.address);
        const sign = await client.callTool({ name: 'ows_sign_message', arguments: { message: 'approved MCP fixture' } });
        if (enabled) {
          assert.ok(!sign.isError);
          assert.match(JSON.parse(sign.content[0].text).signature, /^[a-f0-9]{128}$/);
          core.revokeApiKey(key.id, vault);
          assert.equal((await client.callTool({ name: 'ows_sign_message', arguments: { message: 'revoked' } })).isError, true);
        } else assert.equal(sign.isError, true);
      } finally { await client.close(); }
    }
  } finally { await rm(vault, { recursive: true, force: true }); }
});
