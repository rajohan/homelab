#!/bin/sh
set -eu
exec xvfb-run --server-num=99 --server-args="-screen 0 1024x768x24 -nolisten tcp" sh /opt/mira-browser/start.sh
