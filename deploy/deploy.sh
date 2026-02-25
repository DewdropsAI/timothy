#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — Pull latest code, install deps, rebuild, and restart the agent.
# Idempotent — safe to run multiple times.
# Run as the agent user (or with appropriate permissions).

# --- Identity from identity.json ---
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_NAME=$(jq -r '.agentName' "$REPO_ROOT/identity.json" 2>/dev/null || echo "timothy")
AGENT_NAME_DISPLAY=$(jq -r '.agentNameDisplay' "$REPO_ROOT/identity.json" 2>/dev/null || echo "Timothy")

AGENT_DIR="${AGENT_DIR:-/opt/$AGENT_NAME}"
SERVICE_NAME="${AGENT_SERVICE_NAME:-$AGENT_NAME}"

echo "=== ${AGENT_NAME_DISPLAY} deploy ==="
echo "Directory: $AGENT_DIR"
echo ""

# --- Prerequisites ---

check_command() {
    if ! command -v "$1" &>/dev/null; then
        echo "ERROR: $1 is required but not found" >&2
        exit 1
    fi
}

check_command git
check_command npm
check_command node
check_command systemctl
check_command jq

# Check Node.js version >= 24
node_version=$(node --version | sed 's/^v//')
node_major=$(echo "$node_version" | cut -d. -f1)
if [ "$node_major" -lt 24 ]; then
    echo "ERROR: Node.js >= 24.0.0 required (found v${node_version})" >&2
    exit 1
fi

if [ ! -d "$AGENT_DIR" ]; then
    echo "ERROR: ${AGENT_NAME_DISPLAY} directory not found at $AGENT_DIR" >&2
    echo "Run install.sh first for initial setup." >&2
    exit 1
fi

cd "$AGENT_DIR"

# --- Pull latest code ---

echo "Pulling latest code..."
git pull --ff-only
echo ""

# --- Install dependencies ---

echo "Installing dependencies..."
npm install --production=false
echo ""

# --- Build TypeScript ---

echo "Building TypeScript..."
npm run build
echo ""

# --- Restart service ---

echo "Restarting ${SERVICE_NAME}.service..."
if systemctl is-active --quiet "$SERVICE_NAME"; then
    sudo systemctl restart "$SERVICE_NAME"
    echo "Service restarted."
else
    echo "Service was not running. Starting..."
    sudo systemctl start "$SERVICE_NAME"
    echo "Service started."
fi
echo ""

# --- Status ---

echo "=== Post-deploy status ==="
systemctl status "$SERVICE_NAME" --no-pager || true
echo ""
echo "=== Deploy complete ==="
