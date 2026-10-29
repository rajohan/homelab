FROM oven/bun:1.4.4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox xauth x11-utils libxkbcommon0 libwayland-client0 libdbus-1-3 libatspi2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts && install -m 0755 /source/deploy/browser-test/worker.sh /usr/local/bin/mira-browser
USER bun
ENTRYPOINT ["xvfb-run", "--server-num=99", "--server-args=-screen 0 1024x768x24 -nolisten tcp", "sh", "/source/deploy/browser-test/start.sh"]
