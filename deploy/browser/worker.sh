#!/bin/sh
set -eu
exec xvfb-run --server-num=99 --auth-file=/tmp/mira-browser.xauth --server-args="-screen 0 1280x800x24 -nolisten tcp" sh /opt/mira-browser/start.sh
