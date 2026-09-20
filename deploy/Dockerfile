FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
ARG APP
RUN test "$APP" = "dashboard" || test "$APP" = "auth"
RUN bun run build "$APP"
RUN mkdir /output && cp -a "apps/$APP/dist/." /output/

FROM oven/bun:1.4.2-slim AS runtime
ARG APP
RUN if [ "$APP" = dashboard ]; then apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /output/ ./
USER bun
CMD ["bun", "--no-env-file", "index.js"]
