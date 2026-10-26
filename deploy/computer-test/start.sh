#!/bin/sh
set -eu
mkdir -p /tmp/mira-computer-fixture
openbox >/tmp/mira-computer-fixture/wm.log 2>&1 &
for attempt in $(seq 1 100); do
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x' && break
    sleep 0.1
done
xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x'
python3 /source/deploy/computer-test/fixture.py >/tmp/mira-computer-fixture/fixture.log 2>&1 &
for attempt in $(seq 1 100); do
    test ! -s /tmp/mira-computer-fixture/state.json || break
    sleep 0.1
done
test -s /tmp/mira-computer-fixture/state.json || { cat /tmp/mira-computer-fixture/fixture.log; exit 1; }
bun --no-env-file /source/apps/mira/src/server/testing/computerSmoke.ts
