# Homelab development

- Write code, comments, application labels and documentation in English.
- Use the pinned Bun version and the committed lockfile. Do not add another package manager, Vite, Vitest, Playwright or Storybook.
- `apps/auth` and `apps/dashboard` are independently built and deployed. Auth must not depend on the dashboard, OpenClaw or administrative host access.
- Keep Effect at server workflow boundaries. Use Valibot for public validation and SuperJSON only for the private tRPC transport, not OIDC/JWT protocols.
- Shared `packages/ui` and `packages/contracts` are browser-safe. They must not import application internals or server-only dependencies.
- Unit tests use `*.test.ts`; Happy DOM component tests use `*.test.tsx`; real HTTP integration tests use `*.integration.test.ts`. Run them with `bun run test` and `bun run test:integration` so DOM emulation cannot replace backend network primitives.
- Run `bun run check`, `bun run test`, `bun run test:integration`, `bun run build` and `bun run test:smoke` before delivery.
- Do not read or modify production identity data in ordinary development. The identity implementation must not replace production Authelia until separately qualified and approved.
- Never commit secrets, tokens, real session data, private keys or local `.env` files. Configuration examples contain nonsecret values only.
- Do not add custom provisioning frameworks or machine-specific helper dependencies. Setup must remain unprivileged and scoped to this repository.
