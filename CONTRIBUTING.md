# Contributing

Use Node.js 24, clone the repository, run `npm ci`, then `npm test`.
Submit a pull request describing the behavior changed and the verification used.

Keep messaging and payment contracts versioned separately. Update protocol docs
when message schemas, scoped authentication or delivery semantics change.
Use integer strings for token amounts. Preserve explicit owner approval,
idempotent message IDs and durable reply recovery.

Tests must use fixtures or temporary identities. Do not send real messages,
call paid inference, request a user's wallet signature or broadcast transactions
as part of an automated test. Keep keys, enrollment results, vaults, bearer
tokens, environment files and deployment artifacts out of commits.

Payment batch code remains experimental. Changes need meaningful checks for
transaction parsing, exact amounts and recipients, signature verification,
replay handling and pending settlement before broader deployment.
