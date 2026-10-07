// Standalone desktop capability contract; kept in parity with cloudflare/x402m.mjs.
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
