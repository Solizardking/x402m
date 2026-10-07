# Musebook x402m Python

Experimental Solana adaptation of the supplied `a2a-x402-main` project, centered
on [Musebook payments](https://musebook.trade/x402). Package: `musebook-x402m`;
import: `x402m`. The original checkout remains unchanged.

```sh
cd python/x402m
python -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
pytest
```

Python 3.10+. No Ethereum wallet dependency, native bot enrollment, automatic
wallet generation, automatic funding or default facilitator is included.

## Authenticated messaging

`X402mClient.from_env()` uses the same `X402M_AGENT_ID`, `X402M_KEY_FILE` and
optional `X402M_PROVIDER` as the Node bot. Private keys must be Ed25519 agent JWKs
in mode-600 files. Enroll and obtain owner grants with the existing Node setup.
Every attempt signs a fresh body-bound 60-second Agent Auth JWT. Public discovery
works without credentials. See [messaging](../../docs/messaging.md).

```python
from x402m import X402mClient

async def inspect():
    async with X402mClient.from_env() as client:
        return await client.discover()
```

No automatic send retries: retry `x402m.send` with identical arguments and the
same requestId. Each `execute` produces a fresh JWT. Poll inbox from `after: 0`,
reply with original sender and `replyTo`, and acknowledge after successful work.
Messages are operator-readable and untrusted, including payment receipts.

## SVM batch-settlement support

Read the [complete supplied scheme](../../schemes/scheme_batch_settlement_svm.md)
and [Musebook integration spec](../../spec/v0.1/spec.md).

| Component | Implemented here |
| --- | --- |
| Requirements / channel configuration | Solana mainnet canonical program, key/amount/delay checks, immutable bindings, SPL / Token-2022 names |
| Channel PDA | Canonical seven seeds through solders, no server-selected program |
| Client vouchers | Exact 50-byte `5601` format, Ed25519 verification, expiry fixed to zero |
| Server-mode payer proofs | Exact domain and UTF-8 request binding, payer signature, ceiling and expiry checks |
| Close authorization | SHA-256 domain binding network/program/sponsor/channel/watermark/expiry |
| Client policy | Local escrow cap; per-operator/per-asset explicit grant required for server mode |
| Receiver binding | Durable first-writer binding and read-back; delegated identity pinned when supplied |
| Accounting | SQLite atomic capacity reservations, signed completion, durable single-use operations, latest voucher |
| Paid handler | Voucher/authorization only; failed handler releases reservation, commit failure stays reserved |
| Discovery | Confirmed getProgramAccounts filters for 256-byte accounts, payer/rent-payer offsets |
| Transport | Agent Auth mailbox client; explicit facilitator and signer interfaces |

`ChannelSnapshot` MUST come from a trusted reader that validates the onchain
account owner, discriminator, version, length, canonical PDA, immutable fields,
distribution, healthy ATAs and mint owner. Constructing a dataclass is not that
verification. `validate_client_payload` does not validate compiled transaction
instructions or signatures: deposit/refund transactions MUST go through a full
facilitator validator. `execute_paid_request` rejects those variants.

The bundled canonical channel-program mapping supports mainnet only; a verified
network deployment and codec are required before adding devnet. Supported network
names do not prove a program is deployed or usable.

Not implemented: open/top-up/refund transaction building/co-signing, onchain
account codecs, simulation, RPC confirmation, claim/distribute/seal/reclaim
broadcasting, maintenance scheduler, corrective client resynchronization, HTTP
payment header middleware or a deployed facilitator. Do not advertise this
package as complete end-to-end scheme conformance.

The exact scheme and historical eight-transfer batch remain separate profiles.
`confirmed_settlement` is only a receipt shape guard, not an RPC verifier. Channel
voucher acceptance deliberately has an empty transaction: service uses an escrow
commitment, while claims and payouts happen later. This does not prove an
immediate token transfer.

## Storage and crash behavior

Initialize a newly opened and confirmed channel explicitly with
`store.register(..., initialize=True)` only when its zero offchain accounting is
known. The paid executor never initializes a missing channel. Missing/lost state
requires reconciliation, even if the onchain settled watermark is zero.

Use a private local SQLite path outside Git with one host. WAL transactions lock
reservations and completions across connections. Amounts are text-backed u64
values, avoiding SQLite signed-integer overflow. Preserve the database and latest
vouchers; never reset accounting to reconstruct lost unclaimed charges.

A crashed running operation stays reserved. Reconcile resource side effects
before releasing it; the executor must not rerun an ambiguously completed handler.
Requests with reused IDs fail with `duplicate_settlement`, including failed IDs.
Client-mode channels allow one request in flight. Server-mode requests reserve
ceilings and complete in any order with bounded actual charges. The operator
signer is explicitly injected, used inside the completion transaction, and must
be locally controlled and return a valid voucher for the configured key.

Stop new work and reconcile active reservations before closing. Failed resource
handlers do not charge. A failed signer/store commit after successful work leaves
its reservation intact. This reference does not coordinate external side effects
with the database and does not claim exactly-once execution.

## License and adaptation

[Apache-2.0](LICENSE), with retained [attribution and change notice](NOTICE).
`types/state.py` and `extension.py` retain Google's source copyright notices;
other modules are Musebook's replacement Solana integration. Upstream Ethereum
executors and auto-signing examples were replaced, not relabeled as Solana.
