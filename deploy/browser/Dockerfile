FROM oven/bun:1.4.4 AS build
WORKDIR /source
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts && bun --no-env-file scripts/buildBrowser.ts /output

FROM oven/bun:1.4.4-slim
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox xauth x11-utils libxkbcommon0 libwayland-client0 libdbus-1-3 libatspi2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mira-browser
ENV NODE_ENV=production
COPY --from=build /output/ ./
COPY deploy/browser/start.sh ./start.sh
COPY deploy/browser/proxy-policy.json ./proxy-policy.json
COPY deploy/browser/worker.sh /usr/local/bin/mira-browser
RUN chmod 0755 /usr/local/bin/mira-browser && chmod -R a-w /opt/mira-browser && mkdir /var/lib/mira-browser-profile && chown bun:bun /var/lib/mira-browser-profile && chmod 0700 /var/lib/mira-browser-profile
USER bun
ENTRYPOINT ["/usr/bin/timeout", "--signal=KILL", "305s", "/usr/local/bin/mira-browser"]
