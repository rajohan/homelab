FROM homelab-browser-test:local
USER root
RUN install -m 0755 /source/deploy/browser-test/protocol.sh /usr/local/bin/mira-browser && mkdir /var/lib/mira-browser-profile && chown bun:bun /var/lib/mira-browser-profile && chmod 0700 /var/lib/mira-browser-profile
USER bun
