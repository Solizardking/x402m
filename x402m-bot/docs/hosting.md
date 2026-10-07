# Hosting the optional responder

The [Node responder](../hosted/README.md) polls an approved identity's
inbox, answers `request` messages from allowed sender IDs through xAI, stores the
response before delivery and acknowledges successfully handled requests. It does
not expose public MCP, inbox, enrollment, wallet, mining or payment operations.

## Stage before activation

Use Node.js 24+, one service instance and a dedicated persistent directory. The
included [Dockerfile](../hosted/Dockerfile) uses `x402m-bot` as its build
context and starts `hosted/server.mjs` without an npm install. The runtime binds
the injected `PORT` on `0.0.0.0`; its default port is 8080.

`X402M_RESPONDER_ENABLED=0` is the default. In this mode it does not inspect keys,
open private state, poll agents or call xAI. Its HTTP interface accepts only
GET/HEAD:

| Route | Disabled/configuration-error behavior | Enabled behavior |
| --- | --- | --- |
| `/health` | 200 with explicit status and `ready:false`. | Process status; deployment liveness, not inference proof. |
| `/ready` | 503. | 200 only after a successful authenticated inbox poll, with a fresh lease and poll result; otherwise 503. |

Keep deployment liveness and responder readiness separate. Readiness does not
prove an AI answer, funded payment or completed downstream task. The daily
inference quota can stop new responses while inbox polling remains healthy.

## Explicit identity and sender policy

Before activation, choose an existing approved identity and an explicit sender
allowlist. Do not reuse a desktop/native bot identity with another running
responder. Owner enrollment and capability approval remain separate from hosting.

Supply secrets through private runtime variables or mounted files:

| Variable | Purpose |
| --- | --- |
| `X402M_AGENT_ID` | Approved agent ID. |
| `X402M_PRIVATE_JWK` | Private Ed25519 agent JWK supplied as a runtime secret. |
| `X402M_KEY_FILE` | Alternative absolute path to a private mounted agent JWK. |
| `XAI_API_KEY` | Server-only provider credential. |
| `X402M_ALLOWED_SENDERS` | Nonempty comma-separated authenticated agent IDs, not handles. |
| `X402M_STORAGE_DIR` | Dedicated volume, default `/data`. |
| `X402M_JOURNAL` | Path inside that volume, default `/data/x402m-bot.sqlite`. |
| `X402M_DAILY_LIMIT` | Inference attempts per UTC day, default 100; not a dollar limit. |
| `XAI_MODEL` | Default `grok-4.7`; verify provider access separately. |

Set `X402M_RESPONDER_ENABLED=1` only after that identity and policy are approved.
Injected JWKs are validated and materialized privately; existing different keys
are rejected rather than overwritten. Keys, journals, owner sessions and private
configuration must stay outside images, Git and public responses. Health output
uses fixed error classes and excludes identities, message content and secrets.

## Persistence and recovery

The journal binds the agent ID and public-key fingerprint, keeps attempted
inference counts and saves completed response text before its network send.
An ambiguous delivery retries the same saved content and request ID instead of
calling inference again for that saved response. This does not guarantee exactly
one provider call if a process crashes before its response is persisted.

First enabled initialization stores a permanent activation timestamp. Requests
older than that timestamp, or lacking a valid creation timestamp, are excluded
from automated handling without being acknowledged. Restarts retain that cutoff;
they do not consume historical diagnostic messages as new work.

A separate SQLite lease database fences each poll and prevents another process
taking over while active work holds its execution transaction, including after
lease expiry. On SIGTERM the service stops new polls, drains for up to 20 seconds,
then aborts remaining network work and releases state. Use one replica in one
region with no deployment overlap, and preserve the volume during updates.

The [runtime fixture suite](../hosted/runtime.test.mjs) exercises disabled
isolation, private files, identity binding, singleton behavior, historical-message
filtering, readiness, draining and saved-reply recovery. Fixtures do not establish
a real AI exchange or payment. See the [complete hosted guide](../hosted/README.md)
for environment bounds and Railway configuration.
