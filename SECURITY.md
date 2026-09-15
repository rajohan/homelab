# Security Policy

## Scope and current status

Homelab contains a dashboard and a separately deployable auth application. The identity preview implements account security, OIDC and ForwardAuth, but existing production Authelia remains authoritative until a separate, approved cutover. See [the security model](docs/identity-security.md).

Treat this unreleased identity preview as development software, not a production authentication replacement. Do not expose development listeners or connect production identity data without the documented review and deployment gates.

Security reports are welcome for application code, dependencies, build and release workflows, deployment definitions, and documented trust boundaries. The repository does not grant permission to test the owner's running homelab, accounts, or third-party services.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

[Report a vulnerability privately](https://github.com/rajohan/homelab/security/advisories/new).

If that form is unavailable, contact the repository owner, [@rajohan](https://github.com/rajohan), through an existing private channel or request a private contact method without disclosing the vulnerability. Do not post exploit details, credentials, access tokens, private hostnames, or personal data in public issues or pull requests.

Include the affected commit or release, the relevant configuration without secrets, expected and actual behavior, the security impact, and minimal reproduction steps. Use an isolated environment you control. Share only the data needed to reproduce the problem.

Do not access other users' data, run destructive tests, or publish a working exploit before coordinating with the maintainer. If a credential has been exposed, revoke it through its provider; removing a public message alone does not invalidate it.

## Supported versions and response

Security maintenance targets the current `main` branch and the latest published release, when one exists. Older snapshots are not maintained as separate security branches. Update to a current verified build before assuming an old issue remains unresolved.

This is a small personal project with no guaranteed response or remediation deadline. The maintainer will assess valid reports, coordinate a fix and disclosure when appropriate, and credit the reporter with their consent.

## Contributor requirements

Keep credentials out of Git, browser bundles, test fixtures, logs, and CI artifacts. Use synthetic test data and preserve independent auth/dashboard trust boundaries. A health response is not evidence that authentication is implemented or safe to replace Authelia.
