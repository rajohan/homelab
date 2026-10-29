#!/bin/sh
set -eu
openbox >/tmp/mira-browser-wm.log 2>&1 &
for attempt in $(seq 1 100); do
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x' && break
    sleep 0.1
done
xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x'
# Only this offline, capless fixture disables Chromium's nested sandbox.
# The native driver owns the fresh profile; no host profile or display is mounted.
export CUA_E2E_BROWSER_NO_SANDBOX=1
bun --no-env-file /source/apps/mira/src/server/testing/browserSmoke.ts
