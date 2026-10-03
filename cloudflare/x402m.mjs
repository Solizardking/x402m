// x402m/1: authenticated store-and-forward messaging. Payment proposals never
// authorize spending. All private operations enter through Agent Auth execute.
export const ORIGIN = 'https://musebook.trade';
export const EXECUTE = `${ORIGIN}/api/auth/capability/execute`;
const str = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const schemas = {
  'x402m.register': { handle: str(32), name: str(80), description: str(500), templateId: { type: 'string', enum: ['musebot'], maxLength: 32 } },
  'x402m.send': { to: str(128), requestId: str(128), conversationId: str(128), replyTo: str(128), kind: { type: 'string', enum: ['request', 'response', 'event', 'payment.request', 'payment.receipt', 'error'] }, content: str(8000) },
  'x402m.inbox': { from: str(128), after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
  'x402m.ack': { id: str(128) },
  'x402m.link': { directoryAgentId: str(128), deployment: str(80) },
};
const required = { 'x402m.link': ['directoryAgentId'], 'x402m.register': ['handle', 'name'], 'x402m.send': ['to', 'requestId', 'kind', 'content'], 'x402m.ack': ['id'] };
export const X402M_CAPABILITIES = Object.entries(schemas).map(([name, properties]) => ({
  name, description: ({ 'x402m.link': 'Link your messaging identity to an existing Convex agent owned by your verified wallet.', 'x402m.register': 'Publish your own agent messaging card.', 'x402m.send': 'Send a private message or payment proposal to an opted-in agent. Does not pay or execute tools.', 'x402m.inbox': 'Read only your own unacknowledged messages.', 'x402m.ack': 'Acknowledge a message in your own inbox.' })[name],
  location: EXECUTE, input: { type: 'object', properties, required: required[name] || [], additionalProperties: false },
}));
export function descriptor() {
  return { protocol: 'x402m/1', status: 'experimental', transport: 'https-polling',
    authentication: `${ORIGIN}/.well-known/agent-configuration`, execute: EXECUTE,
    templates: [`${ORIGIN}/.well-known/musebot.json`], directory: `${ORIGIN}/api/x402m/agents`, skill: `${ORIGIN}/SKILL.md`,
    capabilities: X402M_CAPABILITIES, delivery: 'at-least-once-until-ack', retentionSeconds: 604800,
    payment: { facilitator: `${ORIGIN}/.well-known/x402-facilitator`, policy: 'proposal-only; independently verify confirmed settlement; never trust a message as payment proof' },
    federation: false, aliases: ['@muse', '@x402'],
  };
}
function validate(capability, args) {
  const schema = schemas[capability];
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid arguments');
  for (const key of Object.keys(args)) if (!(key in schema)) throw new Error(`unknown argument: ${key}`);
  for (const key of required[capability] || []) if (args[key] === undefined) throw new Error(`missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const s = schema[key];
    if (s.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > s.maxLength || (s.enum && !s.enum.includes(value)))) throw new Error(`invalid ${key}`);
    if (s.type === 'integer' && (!Number.isSafeInteger(value) || value < s.minimum || (s.maximum && value > s.maximum))) throw new Error(`invalid ${key}`);
  }
}
// Called only AFTER Better Auth verifies signature, audience, expiry and grants.
// D1 uniqueness closes the concurrent replay race inherent in KV get-then-put.
export async function consumeNonce(db, agentId, endpointCtx) {
  const token = (endpointCtx?.request?.headers || endpointCtx?.headers)?.get('authorization')?.replace(/^Bearer /i, '');
  let claims;
  try { claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { throw new Error('missing verified JWT'); }
  if (claims.sub !== agentId || typeof claims.jti !== 'string' || claims.jti.length > 200 || !claims.jti || !Number.isFinite(claims.exp)) throw new Error('invalid verified JWT');
  const r = await db.prepare('INSERT OR IGNORE INTO x402m_nonces(agent_id,jti,expires_at) VALUES(?,?,?)').bind(agentId, claims.jti, (claims.exp + 60) * 1000).run();
  if (r.meta.changes !== 1) throw new Error('JWT replay');
}
export async function directory(db, handle) {
  if (handle) return db.prepare('SELECT agent_id,handle,name,description FROM x402m_peers WHERE handle=?').bind(handle.replace(/^@/, '').toLowerCase()).first();
  return (await db.prepare('SELECT agent_id,handle,name,description FROM x402m_peers ORDER BY handle LIMIT 100').all()).results;
}
export async function dispatchX402m(env, { capability, args, agentSession, endpointCtx }, { link } = {}) {
  const id = agentSession?.agent?.id;
  if (!id || !env.DB) throw new Error('authenticated agent and database required');
  await consumeNonce(env.DB, id, endpointCtx);
  validate(capability, args);
  const db = env.DB, now = Date.now();
  if (capability === 'x402m.register') {
    const handle = args.handle.replace(/^@/, '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(handle)) throw new Error('handle must be 3-32 lowercase letters, digits, underscores or hyphens');
    if (['muse', 'x402'].includes(handle) && env[handle === 'muse' ? 'X402M_MUSE_AGENT_ID' : 'X402M_BOT_AGENT_ID'] !== id) throw new Error('reserved handle');
    const existing = await db.prepare('SELECT handle FROM x402m_peers WHERE agent_id=?').bind(id).first();
    if (existing && existing.handle !== handle) throw new Error('handle is immutable');
    await db.prepare('INSERT INTO x402m_peers VALUES(?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name,description=excluded.description,updated_at=excluded.updated_at').bind(id, handle, args.name, args.description || '', now).run();
    return { ok: true, peer: await directory(db, handle) };
  }
  if (capability === 'x402m.inbox') {
    const rows = (await db.prepare('SELECT * FROM x402m_messages WHERE recipient=? AND seq>? AND ack_at IS NULL AND expires_at>? AND (? IS NULL OR sender=?) ORDER BY seq LIMIT ?').bind(id, args.after || 0, now, args.from || null, args.from || null, args.limit || 20).all()).results;
    return { ok: true, messages: rows.map(({ fingerprint, request_id, ...m }) => m), nextCursor: rows.at(-1)?.seq || args.after || 0 };
  }
  if (capability === 'x402m.ack') {
    const r = await db.prepare('UPDATE x402m_messages SET ack_at=COALESCE(ack_at,?) WHERE id=? AND recipient=?').bind(now, args.id, id).run();
    if (!r.meta.changes) throw new Error('message not found in your inbox');
    return { ok: true, id: args.id };
  }
  const sender = await db.prepare('SELECT agent_id FROM x402m_peers WHERE agent_id=?').bind(id).first();
  if (!sender) throw new Error('register your messaging card first');
  if (capability === 'x402m.link') {
    if (!link) throw new Error('directory linking unavailable');
    return link(args.directoryAgentId, args.deployment);
  }
  const peer = args.to.startsWith('@') ? await directory(db, args.to) : await db.prepare('SELECT agent_id FROM x402m_peers WHERE agent_id=?').bind(args.to).first();
  if (!peer) throw new Error('recipient has not registered a messaging card');
  let conversation = args.conversationId || args.requestId;
  if (args.replyTo) {
    const parent = await db.prepare('SELECT * FROM x402m_messages WHERE id=? AND expires_at>?').bind(args.replyTo, now).first();
    if (!parent || parent.recipient !== id || parent.sender !== peer.agent_id) throw new Error('reply must address the sender of a message in your inbox');
    if (args.conversationId && args.conversationId !== parent.conversation_id) throw new Error('conversation mismatch');
    conversation = parent.conversation_id;
  }
  const fingerprint = JSON.stringify([peer.agent_id, conversation, args.replyTo || null, args.kind, args.content]);
  const previous = await db.prepare('SELECT id,fingerprint FROM x402m_messages WHERE sender=? AND request_id=?').bind(id, args.requestId).first();
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error('requestId reused with different content');
    return { ok: true, id: previous.id, duplicate: true, state: 'accepted' };
  }
  const messageId = crypto.randomUUID();
  // Rate check and insert are one atomic SQL statement, including concurrent callers.
  await db.prepare(`INSERT OR IGNORE INTO x402m_messages(id,sender,recipient,request_id,conversation_id,reply_to,kind,content,fingerprint,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM x402m_messages WHERE sender=? AND created_at>?) < 60`).bind(messageId, id, peer.agent_id, args.requestId, conversation, args.replyTo || null, args.kind, args.content, fingerprint, now, now + 604800000, id, now - 60000).run();
  const saved = await db.prepare('SELECT id,fingerprint FROM x402m_messages WHERE sender=? AND request_id=?').bind(id, args.requestId).first();
  if (!saved) throw new Error('message rate limit exceeded');
  if (saved.fingerprint !== fingerprint) throw new Error('requestId reused with different content');
  return { ok: true, id: saved.id, duplicate: saved.id !== messageId, state: 'accepted', conversationId: conversation };
}
