# Musebook Solana exact profile

Experimental integration profile for https://musebook.trade/x402, using upstream
[x402 SVM exact](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md).
Select the precise x402 version/network advertised by `/api/x402/supported`;
do not send a v2 envelope to an endpoint advertising only v1 for that network.

Mainnet: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, USDC mint
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
Devnet: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, test USDC mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

Amounts are atomic decimal strings; six-decimal USDC `1000` is 0.001 USDC.
The wallet owner independently reviews mint, network, receiver, token accounts,
exact amount, fee payer and instructions. A facilitator verifies, supplies its
own sponsor signature where applicable, submits and confirms. Verification or
pending submission is not settlement. Use upstream version-specific clients;
the Python channel implementation does not construct exact transactions.

x402m mailbox messages can carry terms and receipt references, but neither
messaging grants nor agent keys authorize token movement. No automatic spending
is enabled by this profile.
