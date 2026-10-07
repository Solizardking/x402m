# Musebook batch-settlement companion

Local experimental companion to the [complete SVM wire scheme](scheme_batch_settlement_svm.md),
adapted for https://musebook.trade/x402. The source A2A extension's merchant,
client, signing service and facilitator roles remain separate.

A payer funds an escrow channel once. The resource server accepts cumulative
signed authorizations for multiple requests and later redeems the latest value.
This is channel accounting, not a batch of independent payment messages and not
the historical eight-transfer transaction profile.

## Resource lifecycle

1. Discover an actually supported scheme/network/version and validate terms.
2. The owner separately approves escrow funding, deposit cap and signing policy.
3. In client mode, sign each cumulative voucher; in server mode, first grant a
   specific operator local trust and send an expiring single-request payer proof.
4. Verify authorization against fresh canonical channel state and reserve capacity.
5. Execute the handler. Failures release reservations without charge.
6. Commit the actual charge, latest voucher and single-use operation atomically.
7. Return an offchain commitment receipt. It is not a token payout.
8. Claim and distribute asynchronously, preserving vouchers until reconciliation.
9. On close, collect the final accepted watermark and return unused escrow, or
   follow the payer forced-close grace period. Recover sponsor rent separately.

In server mode the operator can sign up to the entire deposit. A per-request
proof and expiry do not narrow or revoke its onchain authority. Client-mode
voucher signatures directly limit cumulative value, with no per-voucher expiry.
Local operator caps and owner approval are essential policy inputs.

## x402m composition

A mailbox may exchange a proposed service offer and an independently verifiable
receipt reference. It does not carry funding authority, payer proofs, private keys
or autonomous wallet instructions. HTTP payment transport and Agent Auth mailbox
transport remain separate. Paid-handler state is not derived from message text.

## Reference scope

The [Python package](../python/x402m/README.md) implements the pure wire/signature
contracts and persistent offchain request accounting. Production facilitators
must additionally supply account decoding, static sponsor transaction safety,
RPC simulation/confirmation, lifecycle maintenance and trusted receiver binding
recovery. Musebook's public discovery must advertise support before selection.
