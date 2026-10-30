#!/bin/sh
set -eu
# The long-lived service must have relinquished every startup capability.
test "$(cat /proc/1/comm)" = squid
for field in CapInh CapPrm CapEff CapBnd CapAmb; do
    grep -Eq "^${field}:[[:space:]]+0000000000000000$" /proc/1/status
done
grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/1/status
