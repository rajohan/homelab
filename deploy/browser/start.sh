#!/bin/sh
set -eu
openbox >/tmp/mira-browser-wm.log 2>&1 &
for attempt in $(seq 1 100); do
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x' && break
    sleep 0.1
done
xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x' >/dev/null
# The capless, offline container is the process boundary. Chromium's nested
# namespace sandbox is unavailable under the fixed host container policy.
export CUA_DRIVER_BROWSER_NO_SANDBOX=1
exec bun --no-env-file /opt/mira-browser/worker.js
