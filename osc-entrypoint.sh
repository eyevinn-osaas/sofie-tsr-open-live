#!/bin/bash
set -e

# The gateway has no inbound API. OSC provides $PORT, the gateway reads HEALTH_PORT.
export HEALTH_PORT="${PORT:-${HEALTH_PORT:-8080}}"

# Stable device id for registration in Sofie Core.
if [ -z "$DEVICE_ID" ] && [ -n "$OSC_HOSTNAME" ]; then
  export DEVICE_ID="${OSC_HOSTNAME%%.*}"
fi

export LOG_LEVEL="${LOG_LEVEL:-info}"

for v in CORE_HOST DEVICE_ID DEVICE_TOKEN; do
  if [ -z "${!v}" ]; then
    echo "osc-entrypoint: warning: $v is not set" >&2
  fi
done

exec "$@"
