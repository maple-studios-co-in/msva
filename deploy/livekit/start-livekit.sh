#!/bin/sh
set -eu

: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}"
case "$LIVEKIT_API_KEY" in
  *[!A-Za-z0-9_-]*|'') echo "LIVEKIT_API_KEY must use the deployment-safe token alphabet" >&2; exit 64 ;;
esac
case "$LIVEKIT_API_SECRET" in
  *[!A-Za-z0-9_-]*|'') echo "LIVEKIT_API_SECRET must use the deployment-safe token alphabet" >&2; exit 64 ;;
esac
umask 077
mkdir -p /run/livekit
{
  printf '%s\n' 'port: 7880' 'bind_addresses: ["0.0.0.0"]' 'keys:'
  printf '  "%s": "%s"\n' "$LIVEKIT_API_KEY" "$LIVEKIT_API_SECRET"
  cat /etc/livekit/livekit.yaml.template
} > /run/livekit/livekit.yaml
exec /livekit-server --config /run/livekit/livekit.yaml
