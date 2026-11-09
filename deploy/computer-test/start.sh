#!/bin/sh
set -eu
mkdir -p /tmp/mira-computer-fixture
openbox >/tmp/mira-computer-fixture/wm.log 2>&1 &
wm_pid=$!
for attempt in $(seq 1 300); do
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x' && break
    kill -0 "$wm_pid" 2>/dev/null || { cat /tmp/mira-computer-fixture/wm.log; exit 1; }
    sleep 0.1
done
xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x' || {
    echo 'The isolated window manager did not become ready within 30 seconds.' >&2
    cat /tmp/mira-computer-fixture/wm.log
    exit 1
}
python3 /source/deploy/computer-test/fixture.py >/tmp/mira-computer-fixture/fixture.log 2>&1 &
fixture_pid=$!
for attempt in $(seq 1 300); do
    test ! -s /tmp/mira-computer-fixture/state.json || break
    kill -0 "$fixture_pid" 2>/dev/null || { cat /tmp/mira-computer-fixture/fixture.log; exit 1; }
    sleep 0.1
done
test -s /tmp/mira-computer-fixture/state.json || { cat /tmp/mira-computer-fixture/fixture.log; exit 1; }
bun --no-env-file /source/apps/mira/src/server/testing/computerSmoke.ts
