# Musebook Pay Kit harnesses

The six requested harnesses are adapted here from the supplied
`../pay-kit-main/harness`, retaining the [Solana Foundation MIT license](LICENSE).
Product context: https://musebook.trade/x402.

| Directory | Protocol / role |
| --- | --- |
| [kotlin-x402-client](kotlin-x402-client) | Kotlin exact HTTP payment client |
| [kotlin-x402-upto-client](kotlin-x402-upto-client) | Kotlin single-request metered channel client |
| [python-x402-client](python-x402-client) | Python exact HTTP payment client |
| [python-x402-upto-client](python-x402-upto-client) | Python single-request metered channel client |
| [python-session-client](python-session-client) | Python MPP session open / reserve / commit / close client |
| [python-server](python-server) | Loopback exact, upto, MPP charge and MPP session server |

MPP sessions, single-request upto and our cumulative
[SVM batch-settlement profile](../schemes/scheme_batch_settlement_svm.md) retain
separate wire contracts. These harnesses are interoperability tools, not additions
to the hosted Musebook payment advertisement. `/x402` is a product page, not a
paid-resource URL to pass into these clients.

## SDK source and installation

Python requires 3.11+ for Pay Kit. Keep its environment separate from the minimal
Musebook Python package: Pay Kit's Anchor/Solana dependencies constrain solders.
The supplied SDK is resolved by package layout instead of the outer `.git`
directory. Set `PAY_KIT_SOURCE_DIR` to its absolute root when moved.

```sh
uv sync --project harness --frozen --python 3.12
harness/.venv/bin/python -m pytest harness/tests harness/python-server/test_harness_adapter.py
```

Kotlin requires JDK 17 and Gradle 8.14.3+ compatible with Kotlin 2.3.21. Each
composite build includes the supplied `pay-kit-main/kotlin` SDK. Build sequentially
because both projects share that SDK's compiler output:

```sh
gradle -p harness/kotlin-x402-client --no-daemon -Pkotlin.compiler.execution.strategy=in-process installDist
gradle -p harness/kotlin-x402-upto-client --no-daemon -Pkotlin.compiler.execution.strategy=in-process installDist
MUSEBOOK_TEST_KOTLIN=1 harness/.venv/bin/python -m pytest -p no:pytest_anchorpy harness/tests
```

The Kotlin fixture cases skip when distributions are absent; the explicit test
flag requires both distributions and fails instead of skipping. Gradle output and
virtual environments are ignored by Git. Installed launchers live under each
project's `build/install/musebook-kotlin-...-harness-client/bin/`.

## Environment contracts

Exact Python/Kotlin clients use `X402_HARNESS_TARGET_URL`,
`X402_HARNESS_RPC_URL`, `X402_HARNESS_CLIENT_SECRET_KEY` (Solana JSON byte array),
`X402_HARNESS_NETWORK` (default devnet CAIP-2), and optional
`X402_HARNESS_PREFER_CURRENCIES`. Upto clients use the same target/key/network;
the challenge must supply current blockhash and slot. Exact and upto reject a challenge from a different configured network, including
the SDK selector's fallback to another advertised network. Clients refuse redirects.

The server chooses the protocol through `PAY_KIT_HARNESS_PROTOCOL` (`x402`,
`upto`, `mpp`, or `session`) and prints one JSON `ready` line with its loopback
port. x402 uses `X402_HARNESS_RPC_URL`, `X402_HARNESS_PAY_TO` and
`X402_HARNESS_FACILITATOR_SECRET_KEY`; upto additionally accepts
`X402_HARNESS_FEE_PAYER_SECRET_KEY`. MPP uses `MPP_HARNESS_RPC_URL`,
`MPP_HARNESS_PAY_TO`, `MPP_HARNESS_MINT`, `MPP_HARNESS_AMOUNT` and optional
`MPP_HARNESS_FEE_PAYER_SECRET_KEY`; session requires that fee payer key.
See the copied server for additional scenario variables.

The session client uses `MPP_HARNESS_TARGET_URL` and optional
`MPP_HARNESS_AMOUNT` (default 700), creates ephemeral fixture signers, and calls
sibling `/__402/session/deliveries`, `/commit`, and `/close` endpoints. The session
server intentionally performs wire-only setup validation with no broadcast or
settle-at-close. It must remain a fixture, not a production escrow gateway.

The adapted server generates an ephemeral sufficiently long challenge secret if
`MPP_HARNESS_SECRET_KEY` is absent, replacing the source's rejected short default.
A restart invalidates challenges using that ephemeral secret. Preserve explicit
private runtime secrets only when intentionally testing restart behavior.

## Verification and interpretation

The tests start local HTTP/RPC fixtures, create temporary unfunded keys, execute
both Python clients, verify payer signatures and exact transfer structure, check
upto canonical channel derivation, and run the real copied session server through
open/reserve/commit/close. Kotlin uses the same tests after installDist.
The RPC fixture accepts only getLatestBlockhash; it never sends a transaction.

Client `ok` means an HTTP success response. A successful fixture or settlement
header does not prove funded or confirmed settlement. Exact/upto server paths can
broadcast when pointed at a real configured RPC; none of the included tests does
so. No real key, funded wallet, provider credential or live payment was used.
The exact clients omit the reusable payment authorization from result output.

For x402m Agent Auth and cumulative channel accounting, continue to use the
[Python package](../python/x402m/README.md) and
[Musebook spec](../spec/v0.1/spec.md). Messaging approval does not grant spending.
