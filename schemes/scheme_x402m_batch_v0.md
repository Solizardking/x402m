# Historical x402m-batch-v0

Musebook's original [payment reference](../docs/payments.md) and
[implementation](../cloudflare/x402batch.js) support one payer and up to eight
USDC TransferChecked instructions in one Solana transaction. This is not an
escrow channel and does not use cumulative vouchers. Its unsigned legacy-message
format is not normal serialized transaction output. Its verifier and storage
limitations remain those documented in the payment guide.

This adaptation does not expose those historical settlement routes or claim
that they are live. Use [SVM batch-settlement](scheme_batch_settlement_svm.md) for
the channel work requested here. Mixed-chain or multi-payer envelopes do not
become one atomic Solana batch.
