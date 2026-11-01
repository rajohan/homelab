#!/usr/bin/env bash
set -euo pipefail

docker build -f deploy/browser-test/Dockerfile -t homelab-browser-test:local .
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --tmpfs /home/bun:rw,nosuid,nodev,size=128m,uid=1000,gid=1000 --memory 1536m --cpus 2 homelab-browser-test:local
bun --no-env-file apps/mira/src/server/testing/browserContainerSmoke.ts
docker build -f deploy/browser-test/worker.Dockerfile -t homelab-browser-worker-test:local .
bun --no-env-file apps/mira/src/server/testing/browserWorkerSmoke.ts
