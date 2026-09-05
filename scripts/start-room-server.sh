#!/bin/sh
set -eu
umask 077

if [ -n "${AGENT_ROOM_TRUST_STORE_B64:-}" ] && [ -n "${AGENT_ROOM_TRUST_STORE_JSON:-}" ]; then
  echo "trust_store_configuration_invalid: AGENT_ROOM_TRUST_STORE_B64 and AGENT_ROOM_TRUST_STORE_JSON are mutually exclusive" >&2
  exit 1
fi
if [ -n "${AGENT_ROOM_TRUST_STORE_B64:-}" ] && [ -n "${AGENT_ROOM_TRUST_STORE:-}" ]; then
  echo "trust_store_configuration_invalid: AGENT_ROOM_TRUST_STORE_B64 and AGENT_ROOM_TRUST_STORE are mutually exclusive" >&2
  exit 1
fi
if [ -n "${AGENT_ROOM_TRUST_STORE_JSON:-}" ] && [ -n "${AGENT_ROOM_TRUST_STORE:-}" ]; then
  echo "trust_store_configuration_invalid: AGENT_ROOM_TRUST_STORE_JSON and AGENT_ROOM_TRUST_STORE are mutually exclusive" >&2
  exit 1
fi

if [ -n "${AGENT_ROOM_TRUST_STORE_B64:-}" ] || [ -n "${AGENT_ROOM_TRUST_STORE_JSON:-}" ]; then
  AGENT_ROOM_TRUST_STORE="${TMPDIR:-/tmp}/agent-room-trust-store.json"
  if [ -n "${AGENT_ROOM_TRUST_STORE_B64:-}" ]; then
    printf '%s' "$AGENT_ROOM_TRUST_STORE_B64" | base64 -d > "$AGENT_ROOM_TRUST_STORE"
  else
    printf '%s' "$AGENT_ROOM_TRUST_STORE_JSON" > "$AGENT_ROOM_TRUST_STORE"
  fi
  chmod 600 "$AGENT_ROOM_TRUST_STORE"
  export AGENT_ROOM_TRUST_STORE
fi

node packages/room-persistence/dist/migrate.js --allow-remote
exec node apps/room-server/dist/index.js
