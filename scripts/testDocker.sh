#!/usr/bin/env bash
set -euo pipefail

bun --no-env-file apps/dashboard/src/server/testing/dockerSmoke.ts
PYTHONDONTWRITEBYTECODE=1 python3 scripts/smokeDockerUpdate.py
