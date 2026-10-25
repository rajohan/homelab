FROM oven/bun:1.4.4 AS build
WORKDIR /source
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun build --target=bun apps/mira/src/server/sandbox/harness.ts --outfile=/output/daytona-check.js
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
