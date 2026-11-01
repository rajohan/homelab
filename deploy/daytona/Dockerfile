FROM oven/bun:1.4.4 AS build
WORKDIR /source
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
RUN bun build --target=bun apps/mira/src/server/sandbox/harness.ts --outfile=/output/daytona-check.js
RUN bun build --target=bun apps/mira/src/server/sandbox/localHarness.ts --outfile=/output/local-check.js
RUN bun --no-env-file -e 'import {daytonaCheckProfile} from "./apps/mira/src/server/sandbox/profile.ts"; await Bun.write("/output/profile.json", JSON.stringify(daytonaCheckProfile));'

FROM postgres:18-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /output/ /opt/homelab/
RUN mkdir -p /tmp/homelab-mira && chown postgres:postgres /tmp/homelab-mira
ENV HOMELAB_MIRA_SANDBOX_PROFILE=homelab-check-v2
ENV PATH=/usr/local/bin:/usr/lib/postgresql/18/bin:/usr/bin:/bin
USER postgres
WORKDIR /tmp/homelab-mira
ENTRYPOINT ["bun", "--no-env-file", "/opt/homelab/daytona-check.js"]
