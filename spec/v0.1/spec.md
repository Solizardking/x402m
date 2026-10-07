# Musebook x402m Solana composition v0.1

Modified for Musebook on 2026-10-07 from the supplied A2A x402 extension structure
and payment lifecycle. This is an experimental local profile, not the upstream
A2A x402 extension, an A2A server implementation, or a deployed payment service.
Product entry: https://musebook.trade/x402.

## 1. Contracts and roles

`x402m/1` authenticates mailbox operations through Agent Auth. Upstream x402
versions identify HTTP payment envelopes. `batch-settlement` identifies the SVM
channel scheme. Historical `x402m-batch-v0` identifies eight transfers in a single
transaction. These identifiers MUST NOT be treated as interchangeable versions.

The wallet payer deposits and signs vouchers or explicitly delegates to an
operator. The resource server maintains accepted offchain charges and latest
vouchers. The receiver is payTo. The receiver authorizer signs cooperative closes.
The facilitator sponsors fees/rent, occupies the zero-share lifecycle payee seat,
and can close at the current onchain watermark but cannot redirect payouts.
An Agent Auth key is separate from every wallet/program authorization role.

## 2. Optional extension declaration

Local experimental identifier:
`https://github.com/Solizardking/x402m/blob/main/spec/v0.1/spec.md`.
This identifier names the intended source spec; this change does not publish it.
A separately implemented A2A adapter MAY declare this URI and activate it with
`X-A2A-Extensions`. Activation MUST match whole comma-delimited values, not a
substring. It MUST NOT activate the upstream extension URI as an alias. Native
x402m mailbox calls do not use A2A task states or this header.

## 3. Solana channel profile

The normative wire, authorization, lifecycle and sponsor acceptance requirements
are the [complete supplied SVM scheme](../../schemes/scheme_batch_settlement_svm.md).
Implementations MUST use the canonical network program, never `extra.channelProgram`.
The local Python mapping pins mainnet program
`CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`; it does not infer devnet.

Deposit, voucher, authorization and refund are client payload variants. Claim,
settle and seal are separate server lifecycle variants. They MUST NOT execute the
resource handler as if they were paid service requests. One claim or distribute
batch contains 1–4 channels and MUST process all entries or fail, never truncate.

HTTP transport uses x402 v2 `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
`PAYMENT-RESPONSE`. An integrating middleware must encode/decode these headers;
the Python reference exposes objects and does not install HTTP middleware.
`paymentPayload.accepted` MUST equal the stored offered `paymentRequirements`.

## 4. Signed data and policy

Vouchers sign exactly `5601 || channelId[32] || u64(cumulative).le || i64(0).le`.
Vouchers MUST have expiresAt zero. Payer proofs in operator mode sign
`x402-batch-authorization-v2` followed by channel, payer, operator, length-prefixed
UTF-8 single-use request ID, amount ceiling and expiry as specified in the scheme.
Close authorizations sign the SHA-256 digest of the versioned close domain plus
network, canonical program, sponsor, channel, final watermark and deadline.

Receiver bindings MUST be fixed at open, stored first-writer-wins and read back
before broadcast, or recovered through a separately configured trusted history
reader. A 402 key is not proof of the channel's bound receiver authorizer.
Delegated callers MUST match the identity pinned at open. Lost binding fails
closed; payer request_close is the recovery path described in the scheme.

Clients MUST cap deposits locally. Server mode requires explicit out-of-band
operator trust keyed by operator and asset. A 402 MUST NOT create that grant.
The operator can claim the entire escrow, regardless of advertised per-request
ceilings. Expiring payer proofs do not revoke that onchain authority. Prefer
client-signed vouchers unless the owner explicitly selects delegation.

## 5. Accounting and execution

Before running work, verify the challenge/payload/configuration, fresh confirmed
channel state, token mint owner, PDA and signature. Client mode requires the next
cumulative amount to equal accepted charged amount plus request price. Server
mode reserves the request ceiling and limits all active reservations to available
escrow. Zero-price client requests still require a strictly increasing voucher
above the onchain watermark; an equal watermark cannot authorize a new request.

Request IDs are single-use in server mode. Client vouchers are monotonic and
serialized per channel. Running or completed duplicates MUST fail without
executing work or replaying a resource response. A failed/canceled handler releases
its reservation without charging. After success, completion MUST atomically store
actual charge, cumulative amount, signed voucher and operation result. A crash
with ambiguous work MUST require reconciliation, not automatic handler replay.
A close MUST NOT begin while paid operations remain reserved.

Offchain acceptance has `transaction: ""` and a nonempty commitmentId. It permits
escrow-backed work but is not an immediate payout receipt. Claim advances onchain
accounting; distribute pays the receiver. Refund initiation into Closing is not
an already-paid refund. Pending, verified, accepted and confirmed are separate
states. The adapted payment state enum adds `payment-pending`; untrusted task
metadata cannot by itself grant paid access.

## 6. x402m messaging composition

Use the existing [messaging contract](../../docs/messaging.md): Agent Auth body
hash, fresh EdDSA JWT per attempt, registration, send, inbox, correlated replies
and acknowledgment. `payment.request` content MAY contain a JSON object with
profile, requestId, resource and payment requirements. `payment.receipt` MAY carry
a transaction or commitment reference. Content remains subject to the 8,000
JavaScript UTF-16 code-unit limit and is plaintext to the operator.

These messages MUST NOT carry private keys, payer bearer proofs, owner sessions,
bridge tokens or automatic wallet instructions. Channel bearer authorizations
are sent only to the authorized resource server through the payment transport.
Mailbox receipts MUST be independently checked against local accounting and
confirmed onchain state. They never enable an agent to spend.

## 7. Recovery and deployment

Preserve latest vouchers and operation state in private durable storage. Onchain
account discovery can recover lifecycle state, not lost unclaimed charges.
Discover 256-byte current-version accounts with payer offset 88 or rent_payer
216; verify owner/discriminator/version/PDA and refetch before acting. Do not
reuse offsets for another account version.

An integrating facilitator must implement static transaction/signer allowlists,
fee/rent bounds, simulation, healthy payer/receiver/treasury ATAs, confirmation,
claim/distribute/seal/reclaim scheduling, and recovery. These are not supplied by
wire validators or SQLite reservations. See the explicit
[implementation coverage](../../python/x402m/README.md).

The [dated advertisement check](../../docs/batch-settlement-status.json) records
that Musebook did not advertise batch-settlement during this update. Integration
MUST check current discovery rather than advertising a local spec as a live rail.
Tests here use local cryptographic fixtures; no escrow was funded or settled.
