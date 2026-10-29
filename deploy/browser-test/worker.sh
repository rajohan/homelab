#!/bin/sh
set -eu
exec xvfb-run --server-num=99 --server-args="-screen 0 1024x768x24 -nolisten tcp" sh /source/deploy/browser-test/start.sh containment
