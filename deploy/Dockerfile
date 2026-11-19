FROM oven/bun:1.4.4 AS build
WORKDIR /source
COPY .bun-version .bun-revision ./
COPY scripts/installBun.ts ./scripts/installBun.ts
RUN bun --no-env-file scripts/installBun.ts /opt/bun
ENV PATH=/opt/bun/bin:$PATH
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
ARG APP
RUN test "$APP" = auth || test "$APP" = homelab
RUN if [ "$APP" = auth ]; then bun run build auth; else bun run build dashboard mira; fi
RUN mkdir /output && if [ "$APP" = auth ]; then cp -a apps/auth/dist/. /output/; else cp -a apps/dashboard/dist/. /output/ && cp -a apps/mira/dist /output/mira; fi
RUN mkdir -p /browser /tools && if [ "$APP" = homelab ]; then \
    bun --no-env-file scripts/buildBrowser.ts /browser && \
    bun build --target=bun apps/mira/src/server/sandbox/harness.ts --outfile=/tools/daytona-check.js && \
    bun build --target=bun apps/mira/src/server/sandbox/localHarness.ts --outfile=/tools/local-check.js && \
    bun --no-env-file -e 'import {daytonaCheckProfile} from "./apps/mira/src/server/sandbox/profile.ts"; await Bun.write("/tools/profile.json", JSON.stringify(daytonaCheckProfile));'; fi

FROM oven/bun:1.4.4-slim AS runtime
COPY --from=build /opt/bun/bin/bun /usr/local/bin/bun
ARG APP
# Debian packages are updated by the managed image rebuild; JavaScript uses the root lockfile.
ARG PACKAGES_WEEK
RUN if [ "$APP" = homelab ]; then echo "$PACKAGES_WEEK" >/dev/null && apt-get update && apt-get install -y --no-install-recommends \
    openssh-client git ca-certificates python3 chromium x11vnc xvfb openbox xauth x11-utils \
    libxkbcommon0 libwayland-client0 libdbus-1-3 libatspi2.0-0 && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /app
ENV NODE_ENV=production HOMELAB_MIRA_SANDBOX_PROFILE=homelab-check-v2
COPY --from=build --chown=bun:bun /output/ ./
COPY --from=build /browser/ /opt/mira-browser/
COPY --from=build /tools/ /opt/homelab/
COPY deploy/browser/start.sh deploy/browser/vnc.py deploy/browser/proxy-policy.json /opt/mira-browser/
COPY deploy/browser/worker.sh /usr/local/bin/mira-browser
COPY deploy/start.sh /usr/local/bin/homelab
RUN chmod 0755 /usr/local/bin/mira-browser /usr/local/bin/homelab && \
    chmod -R a+rX,a-w /opt/mira-browser && \
    mkdir -p /var/lib/mira/codex /var/lib/mira/files /var/empty/mira /var/lib/mira-browser-profile /tmp/homelab-mira && \
    chown -R bun:bun /var/lib/mira /var/empty/mira /var/lib/mira-browser-profile /tmp/homelab-mira && \
    chmod 700 /var/lib/mira/codex /var/lib/mira/files /var/empty/mira /var/lib/mira-browser-profile
USER bun
ENTRYPOINT ["/usr/local/bin/homelab"]
CMD ["bun", "--no-env-file", "index.js"]
