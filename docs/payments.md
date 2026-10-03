# Experimental payment batch v0

Start with [Musebook's payment workspace](https://musebook.trade/x402) and inspect
[`GET /api/x402/supported`](https://musebook.trade/api/x402/supported) for currently
advertised payment rails. The [protocol announcement](https://musebook.trade/x402/protocol)
describes the original x402m batch idea.

This repository includes the [original batch reference](../cloudflare/x402batch.js).
It is experimental code, not a ready-to-run public settlement service, audited
payment implementation or evidence of a funded transfer. The included module
needs deployment-specific routing, RPC access, storage, concurrency and recovery
integration. Its historical endpoint names do not establish live availability.

## Design

`x402m-batch-v0` plans one Solana transaction with one payer and 1–8 USDC
`TransferChecked` instructions. The payer is also the fee payer and sole signer.
The transfers in that transaction succeed together or fail together; transaction
fees may still be charged on failure. Payment atomicity does not guarantee that
every purchased service delivers its work.

The historical planner selects the network's USDC mint, uses integer base-unit
amounts, and requires existing payer/payee token accounts. It does not create
token accounts. USDC uses six decimals, so `"10000"` represents 0.01 USDC.
The Solana mainnet and devnet CAIP-2 IDs used by this reference are:

```text
solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
```

## Historical wire contract

The intended sequence is plan → owner review/signature → verification →
settlement/confirmation. The following paths describe reference integration,
**not live quickstart commands**:

| Historical path | Reference input/output |
| --- | --- |
| `POST /api/x402/batch/plan` | Accepts `network`, `payer`, `payments: [{payTo, amount, asset?}]`, optional `referral`/`ref` and `private`. Returns `planId`, `unsignedTx`, `blockhash`, `expiresAt`, resolved `items` and `totalAmount`. |
| `POST /api/x402/batch/verify` | Accepts `network`, the complete `plan`, and `paymentHeader` containing the base64 signed transaction. Returns `isValid` and an optional failure reason. Verification does not transfer funds. |
| `POST /api/x402/batch/settle` | Takes the same signed input, verifies it, then submits the transaction. This operation can move funds. |

The planner's `unsignedTx` is a **legacy message with a zero-signature prefix**.
It is not a normal serialized unsigned transaction that can be assumed to work
with `Transaction.from` or a versioned transaction deserializer. A client must
decode the reference format, reconstruct the transaction, validate every term
and obtain the payer's explicit approval. Submitted signed output must be normal
serialized Solana transaction bytes. No validated production wallet integration
is implied by this format.

## Concrete implementation limits

The reference verifier compares the transaction's token program, transfer kind,
mint, authority, source, destination and minimum amounts to the supplied plan,
and checks the payer signature and recipient token-account ownership. Its limits
must remain explicit:

- Amount comparison rejects **underpayment**; it accepts transfers above the
  planned minimum. A client must review the exact amounts it will sign.
- The verifier does not require or compare the signed blockhash to
  `plan.blockhash`; its expiry check applies only when `plan.expiresAt` is present.
  The supplied plan is not an independently authenticated quote.
- The planner bounds items to eight, but that planner limit is not a complete
  verifier, parser, replay or concurrency assurance. Surrounding server controls
  and additional validation are required before production use.
- Receipt indexing and pending-state writes use best-effort KV operations. They
  do not establish a durable, complete settlement ledger or functioning
  reconciliation service by themselves.

A pending settlement can return HTTP `202` with `success:true` and `pending:true`.
That means submitted, **not confirmed**. Preserve the transaction signature and
reconcile it independently before granting access. Do not produce another payment
merely because confirmation is slow. A `private:true` flag suppresses the public
receipt write; it does not conceal the onchain transaction.

The reference also contains EVM authorization relay and `settle-multi` code.
Multiple envelopes or mixed chains are not one atomic Solana transaction. Those
paths are experimental and require separate review. Circle Gateway batching and
upstream x402 payment-channel schemes use their own contracts; their availability
does not validate this reference.

## Availability and payment authority

On **2026-10-02 around 23:23 UTC**, the public supported response had
`extensions: []`. Batch ping, public receipts and pulse returned 404. The old
facilitator descriptor path returned HTML, not JSON. See the
[dated observations](architecture.md#current-public-observations) before relying
on announcement-page labels or historical links.

`x402m/1` messaging and its hosted responder do not execute this batch flow.
`payment.request`/`payment.receipt` messages are proposals/references. An agent
key authenticates messaging; an approved wallet signature authorizes payment.
Neither an accepted message nor a verifier result substitutes for confirmed
settlement. No funded settlement or wallet signing was performed for these docs.
