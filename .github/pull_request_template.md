## Summary

Describe the change and why it is needed. Link the related issue when applicable.

## Behavior and regression coverage

Describe the behavior before and after, including failure paths. For a bug fix, identify the test that reproduces the issue. For UI changes, include a screenshot when helpful.

## Verification

Record results, or explain why a check does not apply. Never include credentials or private production data.

- [ ] `bun run check`
- [ ] `bun run test:coverage` (includes unit and component tests)
- [ ] `bun run test:integration`
- [ ] `bun run build`
- [ ] `bun run test:smoke`

## Risk and deployment

- [ ] No secrets, generated runtime data, or machine-specific paths were committed.
- [ ] Auth and dashboard remain independently deployable; browser packages contain no server-only code.
- [ ] Any security, configuration, data migration, or compatibility changes are documented.
- [ ] The PR title uses `type(scope): description`, with breaking changes identified when applicable.

Describe any rollout, rollback, or manual acceptance steps. A merged PR is not approval to change production identity data or deploy to the homelab.

## Reviewer notes

Highlight uncertain assumptions, relevant tradeoffs, and any AI-assisted changes that need particular review.

For sensitive vulnerabilities, use the private reporting process in the [security policy](https://github.com/rajohan/homelab/security/policy), not this template.
