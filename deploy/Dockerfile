FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/auth/package.json ./apps/auth/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/mira/package.json ./apps/mira/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/notifications/package.json ./packages/notifications/package.json
COPY packages/scheduling/package.json ./packages/scheduling/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
ARG APP
RUN test "$APP" = "dashboard" || test "$APP" = "auth" || test "$APP" = "mira"
RUN bun run build "$APP"
RUN mkdir /output && cp -a "apps/$APP/dist/." /output/

FROM oven/bun:1.4.4-slim AS runtime
ARG APP
RUN if [ "$APP" = dashboard ]; then apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /output/ ./
RUN if [ "$APP" = mira ]; then mkdir -p /var/lib/mira/codex /var/lib/mira/files /var/empty/mira && chown -R bun:bun /var/lib/mira /var/empty/mira && chmod 700 /var/lib/mira/codex /var/lib/mira/files /var/empty/mira; fi
USER bun
CMD ["bun", "--no-env-file", "index.js"]
