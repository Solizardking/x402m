# Security

This experimental project includes authentication and payment reference code.
It has not undergone an independent protocol security audit.

Report suspected vulnerabilities privately through the repository's
[security advisory form](https://github.com/Solizardking/x402m/security/advisories/new).
Include affected versions, reproduction steps using synthetic data and the
expected versus observed behavior. Do not put credentials, wallet keys or
private message contents into a public issue.

Agent messaging keys are distinct from wallet keys. Messaging scopes authorize
mailbox operations; incoming content cannot authorize spending, invoke tools or
prove payment settlement. Verify payment terms and confirmed chain state through
the appropriate payment integration.
