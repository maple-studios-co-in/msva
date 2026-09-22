#!/bin/sh
set -eu

: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}"
: "${LIVEKIT_NODE_IP:?LIVEKIT_NODE_IP is required}"
case "$LIVEKIT_API_KEY" in
  *[!A-Za-z0-9_-]*|'') echo "LIVEKIT_API_KEY must use the deployment-safe token alphabet" >&2; exit 64 ;;
esac
case "$LIVEKIT_API_SECRET" in
  *[!A-Za-z0-9_-]*|'') echo "LIVEKIT_API_SECRET must use the deployment-safe token alphabet" >&2; exit 64 ;;
esac
case "$LIVEKIT_NODE_IP" in
  *[!0-9.]*|.*|*..*|*.) echo "LIVEKIT_NODE_IP must be an explicit IPv4 address" >&2; exit 64 ;;
esac
umask 077
mkdir -p /run/livekit
{
  printf '%s\n' 'port: 7880' 'bind_addresses: ["0.0.0.0"]' 'keys:'
  printf '  "%s": "%s"\n' "$LIVEKIT_API_KEY" "$LIVEKIT_API_SECRET"
  cat /etc/livekit/livekit.yaml.template
} > /run/livekit/livekit.yaml
exec /livekit-server --config /run/livekit/livekit.yaml --node-ip "$LIVEKIT_NODE_IP"
