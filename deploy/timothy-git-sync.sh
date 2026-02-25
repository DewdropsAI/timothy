#!/usr/bin/env bash
set -euo pipefail

# git-sync.sh — Commits and pushes workspace/ changes on a timer.
# workspace/ is the agent's persistent mind; this script keeps it safe in git.

# --- Identity from identity.json ---
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_NAME=$(jq -r '.agentName' "$REPO_ROOT/identity.json" 2>/dev/null || echo "timothy")
LOG_PREFIX=$(jq -r '.logPrefix' "$REPO_ROOT/identity.json" 2>/dev/null || echo "$AGENT_NAME")

AGENT_DIR="${AGENT_DIR:-/opt/$AGENT_NAME}"
cd "$AGENT_DIR"

echo "${LOG_PREFIX}-git-sync: checking for workspace changes in $AGENT_DIR"

# Check for any uncommitted changes in workspace/
if [ -z "$(git status --porcelain workspace/)" ]; then
    echo "${LOG_PREFIX}-git-sync: no workspace changes, nothing to do"
    exit 0
fi

echo "${LOG_PREFIX}-git-sync: workspace changes detected, committing..."

git add workspace/

git commit -m "chore(workspace): auto-sync memory"

echo "${LOG_PREFIX}-git-sync: pushing to remote..."

if git push; then
    echo "${LOG_PREFIX}-git-sync: push succeeded"
else
    echo "${LOG_PREFIX}-git-sync: ERROR — push failed (network issue?), will retry next cycle" >&2
    exit 1
fi
