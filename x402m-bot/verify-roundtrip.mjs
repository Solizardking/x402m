// Verify two independently approved identities against the real transport.
// This drives both endpoints locally; it does not prove a desktop app or LLM replied.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { clientFromEnv } from './client.mjs';
async function findMessage(client, from, id) {
  let after = 0;
  for (let page = 0; page < 200; page++) {
    const inbox = await client.execute('x402m.inbox', { from, after, limit: 50 });
    const found = inbox.messages.find(m => m.id === id);
    if (found) return found;
    if (!inbox.messages.length || inbox.nextCursor <= after) break;
    after = inbox.nextCursor;
  }
  throw new Error('Probe message missing from recipient inbox; no unrelated messages were acknowledged');
}
export async function verifyRoundtrip(sender, recipient) {
  if (!sender.agentId || !recipient.agentId || sender.agentId === recipient.agentId) throw new Error('Two distinct approved agent identities are required');
  if (sender.provider !== recipient.provider) throw new Error('Both identities must use the same provider; federation is not implemented');
  const nonce = crypto.randomUUID();
  const sent = await sender.execute('x402m.send', { to: recipient.agentId, requestId: `probe:${nonce}`, kind: 'request', content: `Transport verification ${nonce}: return this exact nonce.` });
  const received = await findMessage(recipient, sender.agentId, sent.id);
  if (received.sender !== sender.agentId || !received.content.includes(nonce)) throw new Error('Probe identity/content mismatch');
  const reply = await recipient.execute('x402m.send', { to: sender.agentId, requestId: `probe-reply:${nonce}`, replyTo: sent.id, kind: 'response', content: nonce });
  const returned = await findMessage(sender, recipient.agentId, reply.id);
  if (returned.sender !== recipient.agentId || returned.content !== nonce || returned.reply_to !== sent.id || returned.conversation_id !== received.conversation_id) throw new Error('Probe reply correlation mismatch');
  await recipient.execute('x402m.ack', { id: sent.id });
  await sender.execute('x402m.ack', { id: reply.id });
  return { verified: true, scope: 'two approved identities; locally driven transport roundtrip, not desktop or LLM execution', sender: sender.agentId, recipient: recipient.agentId, requestId: sent.id, replyId: reply.id, acknowledged: true, at: new Date().toISOString() };
}
async function fromConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const servers = Object.values(config.mcpServers || {}).filter(s => s.env?.X402M_AGENT_ID && s.env?.X402M_KEY_FILE);
  if (servers.length !== 1) throw new Error('Configuration must contain exactly one enrolled x402m server');
  return clientFromEnv(servers[0].env);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) throw new Error('Usage: node verify-roundtrip.mjs SENDER_MCP_JSON RECIPIENT_MCP_JSON');
  console.log(JSON.stringify(await verifyRoundtrip(await fromConfig(a), await fromConfig(b)), null, 2));
}
