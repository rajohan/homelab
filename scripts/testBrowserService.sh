#!/usr/bin/env bash
set -euo pipefail

bun run build mira
PYTHONDONTWRITEBYTECODE=1 python3 scripts/smokeBrowserService.py
