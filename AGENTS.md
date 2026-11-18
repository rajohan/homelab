# Homelab development

- Write code, comments, application labels and documentation in English.
- Start repository work from an up-to-date development checkout. Inspect its branch, status and worktrees before fetching `main`; fast-forward only a clean checkout with no divergent local commits. Preserve existing work, create a task branch for edits, and refresh the clean checkout after merge. Never reset or discard work to synchronize it. Run source analysis and design tools from this checkout, not the production image.
- Use the pinned Bun version and the committed lockfile. Do not add another package manager, Vite, Vitest, Playwright or Storybook.
- `apps/auth` and `apps/dashboard` are independently built and deployed. Authentication, OIDC, ForwardAuth and security APIs must work without the dashboard, OpenClaw or administrative host access. By product requirement, the self-service account UI lives only in dashboard Settings; auth `/account` redirects there. A dashboard outage pauses self-service, not existing sign-in/SSO.
- Document exported functions and public methods/accessors with meaningful JSDoc. Include parameter and return semantics where applicable; ordinary comments or empty blocks do not satisfy the lint rules. Keep private/protected implementation helpers out of the mandatory surface.
- Keep Effect at server workflow boundaries. Use Valibot for public validation and SuperJSON only for the private tRPC transport, not OIDC/JWT protocols.
- Put each React component in its own named file. Group generic UI under `packages/ui/src/components` and account-specific behavior under `features/identity`; generic primitives must not depend on identity features. Keep app browser and server modules in separate subtrees.
- Shared `packages/ui` and `packages/contracts` are browser-safe. They must not import application internals or server-only dependencies.
- Web and Windows use the same dashboard React UI, shared components, contracts and server workflows. Keep Windows-specific code limited to OS integration (tray, startup, updates and local computer access); do not implement a second chat, task board or automation engine in the desktop client.
- Run `bun run check`, both migration metadata checks, and `bun run build` before delivery. The project intentionally has no automated test suite. Preserve the existing lint and formatting policy and CodeQL security analysis on pull requests and `main`.
- Do not read or modify production identity data in ordinary development. Live identity, routing and application-control changes require separate deployment qualification and approval. Use `bun run dev` for the existing applications with a temporary development database. Keep development setup small; do not add mock services or a second implementation.
- Never commit secrets, tokens, real session data, private keys or local `.env` files. Configuration examples contain nonsecret values only.
- Do not add custom provisioning frameworks or machine-specific helper dependencies. Setup must remain unprivileged and scoped to this repository.

- Keep all JavaScript dependencies in the root `package.json` and `bun.lock`; shared source folders use TypeScript aliases, not workspace manifests.
- Build Auth separately from the Main image. Main services and their browser/code tools share one image; the network proxy has its own small image.
- Chat actions use the existing request/approval controls above the composer. Do not add separate code-job, code-proposal or publication draft workspaces.

- Every external dependency and vendored upstream must have automatic version discovery through Dependabot or the existing Homelab updater. Custom root-manifest pins need an update feed; do not leave upstream checks as a manual maintenance step.
