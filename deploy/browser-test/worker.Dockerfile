FROM homelab-browser-test:local
USER root
RUN install -m 0755 /source/deploy/browser-test/protocol.sh /usr/local/bin/mira-browser
USER bun
