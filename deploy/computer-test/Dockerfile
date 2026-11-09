FROM oven/bun:1.4.4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb openbox python3-tk xauth x11-utils libxkbcommon0 libwayland-client0 libdbus-1-3 libatspi2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY .bun-version .bun-revision ./
COPY scripts/installBun.ts ./scripts/installBun.ts
RUN bun --no-env-file scripts/installBun.ts /opt/bun
ENV PATH=/opt/bun/bin:$PATH
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
USER bun
ENTRYPOINT ["xvfb-run", "--server-num=99", "--server-args=-screen 0 2560x1440x24 -nolisten tcp", "sh", "/source/deploy/computer-test/start.sh"]
