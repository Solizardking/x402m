# Persistent x402m responder

This optional Node 24 runtime polls an already approved agent identity, answers
requests from explicitly allowed sender IDs through xAI, and preserves reply
content before delivery. Its public HTTP interface contains only `GET`/`HEAD`
`/health` and `/ready`. It provides no public MCP, inbox, enrollment, wallet,
identity editing, payment or mining endpoints.

The default `X402M_RESPONDER_ENABLED=0` starts only the status listener. Disabled
mode does not inspect an agent key, open its journal, contact agents or call xAI.
`/health` returns 200 with `enabled:false`, `configured:false` and
`configurationNeeded:true`; `/ready` returns 503. Configuration failures also
remain unready. A successful authenticated inbox poll is required before ready.
Approval must be granted through the existing owner enrollment flow separately.

## Railway service

Use a separate service with root directory `/x402m-bot` and config path
`/x402m-bot/hosted/railway.toml`. The Docker build context must be `x402m-bot`;
the image copies only `bot.mjs`, `client.mjs` and the hosted runtime modules.
It needs no npm installation. The [Railway configuration reference](https://docs.railway.com/config-as-code/reference)
describes Dockerfile, healthcheck and replica settings.

Attach one persistent Railway volume at `/data` and use one replica in one
region. Keep the mounted directory owned by the container process; the runtime
sets private directory permissions. Use `/health` for Railway's deployment
healthcheck so the disabled staging service can start. `/ready` describes actual
responder readiness and must not be treated as true merely because Railway
accepted the deployment. `PORT` is bound on `0.0.0.0`; the default is 8080.

Provision these variables privately through the deployment platform:

| Variable | Purpose |
| --- | --- |
| `X402M_RESPONDER_ENABLED` | `0` by default; `1` explicitly activates polling. |
| `X402M_AGENT_ID` | Existing approved agent ID, separate from a wallet address. |
| `X402M_PRIVATE_JWK` | Railway secret containing that agent's private Ed25519 JWK. Never publish it. |
| `X402M_KEY_FILE` | Alternative private mounted JWK file; do not combine with a different injected identity path. |
| `XAI_API_KEY` | Server-only xAI key. |
| `X402M_ALLOWED_SENDERS` | Nonempty comma-separated authenticated agent IDs; handles and empty entries are rejected. |
| `X402M_STORAGE_DIR` | Dedicated volume directory, default `/data`. |
| `X402M_JOURNAL` | Journal path within that directory, default `/data/x402m-bot.sqlite`. |
| `X402M_DAILY_LIMIT` | 1–10,000 inference attempts per UTC day, default 100; a request limit, not a dollar limit. |
| `XAI_MODEL` | Default `grok-4.7`. |
| `X402M_POLL_INTERVAL_MS` | 1,000–60,000; default 15,000. |
| `X402M_LEASE_MS` | 30,000–300,000; default 120,000, with heartbeat every 10 seconds or faster. |

Injected JWKs are validated before being written as
`/data/identity/agent.private.jwk` (file 600, directory 700). An existing different
identity is never overwritten. The journal is bound to the agent ID and public
key fingerprint and cannot silently be reused for another identity. Do not put
keys, tokens or private configuration into Docker build arguments or source.

## Recovery and activation

The first enabled initialization stores a permanent activation timestamp.
Requests with missing timestamps or `created_at` before that timestamp are
excluded from automated replies. Historical messages are left unacknowledged;
bounded pagination advances only past excluded history so a backlog does not
hide new work. Restarts preserve activation, inference budgets and saved replies.
A failed or ambiguous delivery retries the same saved content/request ID.

`responder-lease.sqlite` enforces a finite process lease and heartbeat. A held
SQLite execution transaction prevents another instance polling while an active
poll is paused, including after lease expiry. The reply journal is separate so
its saved reply commits before the network send. The successor can acquire the
lease after a crash and expiry; a graceful stop drains the current poll, releases
the lease and leaves the journal intact. SIGTERM stops new polls, allows 20
seconds to drain, then aborts outstanding network work before releasing state.

Health contains only fixed status/error classes and the last successful poll
timestamp. It exposes no agent ID, sender IDs, message bodies, key/token values
or provider errors. A poll failure clears readiness. This runtime signs scoped
agent-auth requests; it has no wallet-signing or payment authority. Its checks
do not demonstrate a funded transaction or a real xAI-generated reply.

Run the hosted fixture suite without real identities or provider calls:

```sh
node --test hosted/runtime.test.mjs
```

The existing desktop archive packager includes only top-level files. Adding
this folder leaves that archive unchanged and keeps its existing ORE exclusion.
