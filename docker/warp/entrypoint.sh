#!/bin/sh
set -eu

if [ "${WARP_ACCEPT_TOS:-no}" != "yes" ]; then
  echo "WARP is disabled until you explicitly accept Cloudflare's terms by setting WARP_ACCEPT_TOS=yes." >&2
  exit 64
fi

/usr/local/bin/warp-svc > /var/log/warp-svc.log 2>&1 &
service_pid=$!
trap 'kill "$service_pid" 2>/dev/null || true; wait "$service_pid" 2>/dev/null || true' TERM INT EXIT

attempt=0
until warp-cli --accept-tos status >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "WARP service did not become ready." >&2
    exit 1
  fi
  sleep 1
done

if ! warp-cli --accept-tos registration show >/dev/null 2>&1; then
  warp-cli --accept-tos registration new
fi

warp-cli --accept-tos tunnel protocol set MASQUE
warp-cli --accept-tos mode warp+doh
warp-cli --accept-tos connect

attempt=0
until /usr/local/bin/warp-healthcheck; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "WARP did not reach the Connected state." >&2
    exit 1
  fi
  sleep 1
done

wait "$service_pid"
