#!/bin/sh
set -eu
# Install the namespace-only packet policy before any service listens.
/usr/sbin/nft --file /etc/mira-egress.nft
# The running proxy cannot alter its firewall or regain startup capabilities.
exec /usr/bin/setpriv --reuid=proxy --regid=proxy --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs /usr/sbin/squid -N -f /etc/squid/squid.conf
