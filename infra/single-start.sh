#!/bin/sh
# Caddy takes the public port; the API listens on loopback only. The API runs in the foreground,
# so the container stops, and the host restarts it, if the API exits.
set -e
PUBLIC_PORT="${PORT:-8080}"
PORT="$PUBLIC_PORT" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
PORT=3000 HOST=127.0.0.1 exec node apps/api/dist/server.js
