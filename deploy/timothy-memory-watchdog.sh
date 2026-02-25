#!/usr/bin/env bash
set -euo pipefail

# memory-watchdog.sh — Checks the agent's memory usage and heartbeat health.
# Reads ~/<configDir>/status.json; restarts the service if RSS > 800MB or heartbeat stale.

# --- Identity from identity.json ---
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_NAME=$(jq -r '.agentName' "$REPO_ROOT/identity.json" 2>/dev/null || echo "timothy")
AGENT_NAME_DISPLAY=$(jq -r '.agentNameDisplay' "$REPO_ROOT/identity.json" 2>/dev/null || echo "Timothy")
CONFIG_DIR=$(jq -r '.configDir' "$REPO_ROOT/identity.json" 2>/dev/null || echo ".timothy")
LOG_PREFIX=$(jq -r '.logPrefix' "$REPO_ROOT/identity.json" 2>/dev/null || echo "$AGENT_NAME")

STATUS_FILE="${AGENT_STATUS_FILE:-$HOME/$CONFIG_DIR/status.json}"
MEMORY_THRESHOLD_MB="${AGENT_MEMORY_THRESHOLD_MB:-800}"
STALE_THRESHOLD_SEC="${AGENT_STALE_THRESHOLD_SEC:-300}"
SERVICE_NAME="${AGENT_SERVICE_NAME:-$AGENT_NAME}"
# Set to "user" for systemctl --user, anything else for system-level
SYSTEMD_SCOPE="${AGENT_SYSTEMD_SCOPE:-system}"

restart_service() {
    if [ "$SYSTEMD_SCOPE" = "user" ]; then
        systemctl --user restart "$SERVICE_NAME"
    else
        systemctl restart "$SERVICE_NAME"
    fi
}

# Check status file exists
if [ ! -f "$STATUS_FILE" ]; then
    echo "${LOG_PREFIX}-watchdog: WARNING — status file not found at $STATUS_FILE"
    echo "${LOG_PREFIX}-watchdog: ${AGENT_NAME_DISPLAY} may not be running or has never started"
    exit 1
fi

# Parse status.json with jq
if ! command -v jq &>/dev/null; then
    echo "${LOG_PREFIX}-watchdog: ERROR — jq is required but not installed" >&2
    exit 1
fi

status=$(jq -r '.status // empty' "$STATUS_FILE")
memory_mb=$(jq -r '.memory_mb // empty' "$STATUS_FILE")
last_heartbeat=$(jq -r '.last_heartbeat // empty' "$STATUS_FILE")
pid=$(jq -r '.pid // empty' "$STATUS_FILE")

echo "${LOG_PREFIX}-watchdog: status=$status pid=$pid memory_mb=$memory_mb last_heartbeat=$last_heartbeat"

# If status is "stopped", nothing to watch
if [ "$status" = "stopped" ]; then
    echo "${LOG_PREFIX}-watchdog: ${AGENT_NAME_DISPLAY} is stopped, nothing to check"
    exit 0
fi

action_taken=0

# Check heartbeat staleness
if [ -n "$last_heartbeat" ]; then
    heartbeat_epoch=$(date -d "$last_heartbeat" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${last_heartbeat%%.*}" +%s 2>/dev/null || echo "")
    now_epoch=$(date +%s)

    if [ -n "$heartbeat_epoch" ]; then
        age_sec=$(( now_epoch - heartbeat_epoch ))
        echo "${LOG_PREFIX}-watchdog: heartbeat age=${age_sec}s (threshold=${STALE_THRESHOLD_SEC}s)"

        if [ "$age_sec" -gt "$STALE_THRESHOLD_SEC" ]; then
            echo "${LOG_PREFIX}-watchdog: WARNING — heartbeat stale (${age_sec}s > ${STALE_THRESHOLD_SEC}s), process may be hung"
            echo "${LOG_PREFIX}-watchdog: restarting $SERVICE_NAME..."
            restart_service
            echo "${LOG_PREFIX}-watchdog: restart issued for stale heartbeat"
            action_taken=1
        fi
    else
        echo "${LOG_PREFIX}-watchdog: WARNING — could not parse last_heartbeat timestamp"
    fi
else
    echo "${LOG_PREFIX}-watchdog: WARNING — no last_heartbeat in status file"
fi

# Check memory (only if we haven't already restarted)
if [ "$action_taken" -eq 0 ] && [ -n "$memory_mb" ]; then
    # Compare as integers (truncate decimals) for portability
    memory_int=${memory_mb%%.*}

    if [ "$memory_int" -ge "$MEMORY_THRESHOLD_MB" ]; then
        echo "${LOG_PREFIX}-watchdog: WARNING — memory ${memory_mb}MB exceeds threshold ${MEMORY_THRESHOLD_MB}MB"
        echo "${LOG_PREFIX}-watchdog: restarting $SERVICE_NAME..."
        restart_service
        echo "${LOG_PREFIX}-watchdog: restart issued for high memory"
        action_taken=1
    else
        echo "${LOG_PREFIX}-watchdog: memory ${memory_mb}MB is within threshold (${MEMORY_THRESHOLD_MB}MB)"
    fi
fi

if [ "$action_taken" -eq 1 ]; then
    exit 1
fi

echo "${LOG_PREFIX}-watchdog: all checks passed"
exit 0
