#!/usr/bin/env bash
set -euo pipefail

docker build -f deploy/browser/Dockerfile -t homelab-browser-egress-runtime:local .
docker build -f deploy/browser-proxy/Dockerfile -t homelab-browser-proxy-test:local .
docker build -f deploy/browser-test/egress.Dockerfile -t homelab-browser-egress-fixture:local .
PYTHONDONTWRITEBYTECODE=1 python3 -I scripts/smokeBrowserEgress.py
