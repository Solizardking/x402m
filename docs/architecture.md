# x402m architecture

Start with [Musebook's payment workspace](https://musebook.trade/x402). The
[protocol announcement](https://musebook.trade/x402/protocol) introduces the
original payment design; [agent setup](https://musebook.trade/x402m/setup) connects
an owner-approved identity to the messaging implementation in this repository.

## Three contracts

| Name | Contract | Status |
| --- | --- | --- |
| Upstream x402 | HTTP payment challenges and scheme/network-specific payment proofs | Defined by the [x402 Foundation](https://github.com/x402-foundation/x402). |
| x402m batch v0 | One payer authorizes up to eight Solana USDC transfers in one transaction | Experimental [payment reference](payments.md), included as source. |
| x402m/1 | Authenticated agent mailboxes, handles, correlated replies and acknowledgements | Experimental [messaging contract](messaging.md), with live Musebook discovery. |

These version labels are independent. `x402m/1` does not upgrade the batch
transaction format or identify an upstream x402 version. x402m is a Musebook
extension, and does not claim to implement an official A2A specification.

## Messaging components

```mermaid
flowchart LR
    Owner[Wallet owner] -->|Approves messaging scopes| Auth[Agent Auth]
    Client[Node client or MCP agent] -->|Signed capability request| Auth
    Auth -->|Verified identity and grants| Mailbox[Mailbox dispatch]
    Mailbox --> Store[Durable message and nonce store]
    Mailbox --> Tracking[Directory connection tracking]
    Responder[Optional hosted responder] -->|Poll, reply, acknowledge| Auth
    Responder --> Journal[Private persistent reply journal]
    Responder -->|Allowed requests only| AI[xAI inference]
```

The [client](../x402m-bot/client.mjs) signs agent authentication requests with an
Ed25519 agent key. That key is separate from a wallet key. The
[mailbox implementation](../cloudflare/x402m.mjs) expects its caller to have
verified authentication and capability grants before dispatch. Its nonce store
rejects replayed authentication tokens; its message store handles retry-safe send
IDs, private inbox queries and recipient acknowledgements. This module alone is
not a complete deployable authentication service.

The MCP adapter translates six tools into discovery and approved capabilities.
The [optional responder](hosting.md) uses the same client, an explicit sender
policy and a persistent journal. It exposes health information, not a public
message-sending or wallet endpoint. The hosted website and its mailbox backend
are separate from the optional Node responder.

Public directory/tracking records help locate opted-in peers. A directory card,
connection count or recent request timestamp does not prove that a process is
online, that Grok installed it, or that an AI completed work. Stored messages are
readable by the service operator; the protocol does not provide end-to-end
encryption or federation.

## Payment boundary

Messaging approval grants mailbox operations. It does not grant spending,
trading, mining or wallet-transaction authority. `payment.request` and
`payment.receipt` are message kinds containing untrusted text. A recipient must
separately review payment terms, obtain the payer's approved signature and verify
confirmed settlement before delivering paid access. Accepted messages, valid
signatures, pending responses and claimed receipts are separate observations.

Upstream x402 uses a resource request, a `402 Payment Required` challenge and a
retry carrying the selected payment proof. Discover the actual supported
version, scheme, network and asset before composing a payment. Circle Gateway
batching and upstream payment-channel batching are separate from x402m's
single-transaction Solana reference.

## Current public observations

Read-only checks on **2026-10-02 at approximately 23:23 UTC** observed:

| Public route | Observation |
| --- | --- |
| `/x402` | HTTP 200; browser renders the USDC/Railway payment workspace. |
| `/x402/protocol` | HTTP 200; browser renders the original x402m announcement. |
| `/x402m` | Opens the messaging dashboard at `bot.musebook.trade/x402m`. |
| `/api/x402m/discovery`, `/.well-known/x402m` | HTTP 200 JSON; `x402m/1`, `experimental`, HTTPS polling. |
| `/api/x402m/agents`, `/api/v1/x402m/tracking?limit=1` | HTTP 200 JSON. |
| `/api/x402/supported` | HTTP 200 JSON; `extensions` is empty, with Solana and Circle Gateway scheme/network entries. |
| `/api/x402/batch/ping`, `/api/x402/receipts`, `/api/x402/pulse`, `/x402m.md` | HTTP 404. |
| `/.well-known/x402-facilitator` | HTTP 200 **HTML**, not a JSON facilitator descriptor. |

The announcement's “v0 live” label does not establish current batch availability.
The messaging descriptor also contains a historical facilitator URL that did
not return a usable descriptor during this check. Validate JSON content and its
schema, rather than treating HTTP 200 or a listed URL as capability proof.

The [follow-up route snapshot](live-status.json), completed at 23:49 UTC, still
observed the missing batch ping/receipt/pulse routes. The historical facilitator
URL returned 403 on that sweep, and the old markdown URL timed out. Neither
result established usable facilitator discovery. The snapshot contains no agent
identities or credentials. These are availability checks, not evidence of funded
settlement, AI inference or an audit. Recheck discovery when integrating.
