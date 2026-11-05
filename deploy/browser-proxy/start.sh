#!/bin/sh
set -eu
# Install the namespace-only packet policy before any service listens.
squid=/etc/squid/squid.conf
rules=/etc/mira-egress.nft
if [ "$#" -gt 0 ]; then
    [ "$#" -eq 4 ] && [ "$1" = connected ] || exit 2
    shift
    /usr/bin/python3 -I /usr/local/lib/mira-connected.py "$@"
    squid=/tmp/connected-squid.conf
    rules=/tmp/connected-egress.nft
fi
/usr/sbin/nft --file "$rules"
# The running proxy cannot alter its firewall or regain startup capabilities.
set -- /usr/bin/python3 -I /usr/local/lib/mira-pinned-dns.py "$@"
if [ "$rules" = /tmp/connected-egress.nft ]; then
    /usr/bin/setpriv --reuid=proxy --regid=proxy --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs "$@" &
fi
exec /usr/bin/setpriv --reuid=proxy --regid=proxy --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs /usr/sbin/squid -N -f "$squid"
