#!/usr/bin/env bash
set -euo pipefail

docker build -f deploy/computer-test/Dockerfile -t homelab-computer-test:local .
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --tmpfs /home/bun:rw,nosuid,nodev,size=32m,uid=1000,gid=1000 --memory 768m --cpus 2 homelab-computer-test:local
