FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends squid ca-certificates nftables util-linux && rm -rf /var/lib/apt/lists/*
COPY deploy/browser-proxy/squid.conf /etc/squid/squid.conf
COPY deploy/browser-proxy/egress.nft /etc/mira-egress.nft
COPY deploy/browser-proxy/start.sh /usr/local/bin/mira-egress
COPY deploy/browser-proxy/health.sh /usr/local/bin/mira-egress-health
RUN squid -k parse -f /etc/squid/squid.conf && chmod 0755 /usr/local/bin/mira-egress /usr/local/bin/mira-egress-health
HEALTHCHECK --interval=2s --timeout=2s --start-period=10s --retries=3 CMD ["/usr/local/bin/mira-egress-health"]
USER 0:0
ENTRYPOINT ["/usr/local/bin/mira-egress"]
