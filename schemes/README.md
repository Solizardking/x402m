# Musebook Solana schemes

Adapted from the scheme-directory structure in the supplied `a2a-x402-main`.
Start at https://musebook.trade/x402.

| Profile | Contract | Local status |
| --- | --- | --- |
| [SVM batch-settlement](scheme_batch_settlement_svm.md) | One escrow channel; many cumulative vouchers; later claim and distribute | Primary focus: full supplied spec plus Python cryptography/accounting; no hosted rail |
| [Solana exact](scheme_exact_solana.md) | One exact SPL transfer using the selected upstream x402 version | Reference integration boundary |
| [Historical x402m batch v0](scheme_x402m_batch_v0.md) | One payer, up to eight USDC transfers in a transaction | Existing experimental reference |

`batch-settlement`, `upto`, and eight-transfer batch v0 are separate contracts.
Consult [live advertisement observations](../docs/batch-settlement-status.json)
and require an actual matching `/api/x402/supported` entry before live selection.
The snapshot is dated; it is not a deployment promise.
