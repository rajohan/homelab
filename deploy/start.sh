#!/bin/sh
set -eu
# Existing Compose installations launch Mira and the browser host from their app directory.
# Worker, migrations and Auth retain their existing commands in /app.
if [ "$#" -eq 3 ] && [ "$1" = bun ] && [ "$2" = --no-env-file ]; then
    case "$3" in
        hostCli.js) cd /app/mira ;;
        index.js) if [ -n "${HOMELAB_MIRA_CONFIG:-}" ]; then cd /app/mira; fi ;;
    esac
fi
exec "$@"
