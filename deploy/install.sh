#!/usr/bin/env bash
set -euo pipefail

# install.sh — First-time setup for agent systemd deployment.
# Idempotent — safe to run multiple times.
# Must be run as root (or with sudo).

# --- Identity from identity.json ---
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_NAME=$(jq -r '.agentName' "$REPO_ROOT/identity.json" 2>/dev/null || echo "timothy")
AGENT_NAME_DISPLAY=$(jq -r '.agentNameDisplay' "$REPO_ROOT/identity.json" 2>/dev/null || echo "Timothy")
CONFIG_DIR=$(jq -r '.configDir' "$REPO_ROOT/identity.json" 2>/dev/null || echo ".timothy")
LOG_PREFIX=$(jq -r '.logPrefix' "$REPO_ROOT/identity.json" 2>/dev/null || echo "$AGENT_NAME")
SERVICE_PREFIX=$(jq -r '.servicePrefix' "$REPO_ROOT/identity.json" 2>/dev/null || echo "$AGENT_NAME")

AGENT_DIR="${AGENT_DIR:-/opt/$AGENT_NAME}"
AGENT_USER="${AGENT_USER:-$AGENT_NAME}"
AGENT_GROUP="${AGENT_GROUP:-$AGENT_NAME}"
DEPLOY_DIR="$AGENT_DIR/deploy"

echo "=== ${AGENT_NAME_DISPLAY} install ==="
echo "Directory: $AGENT_DIR"
echo "User:      $AGENT_USER"
echo ""

# --- Check root ---

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root (or with sudo)" >&2
    exit 1
fi

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

echo "Prerequisites OK (node v${node_version})"
echo ""

# --- Create user ---

if id "$AGENT_USER" &>/dev/null; then
    echo "User '$AGENT_USER' already exists."
else
    echo "Creating user '$AGENT_USER'..."
    useradd -r -m -s /bin/bash "$AGENT_USER"
    echo "User created."
fi
echo ""

# --- Create directories ---

echo "Ensuring directories exist..."

if [ ! -d "$AGENT_DIR" ]; then
    echo "  Creating $AGENT_DIR"
    mkdir -p "$AGENT_DIR"
    chown "$AGENT_USER:$AGENT_GROUP" "$AGENT_DIR"
fi

agent_home=$(eval echo "~$AGENT_USER")
agent_config_dir="$agent_home/$CONFIG_DIR"
if [ ! -d "$agent_config_dir" ]; then
    echo "  Creating $agent_config_dir"
    mkdir -p "$agent_config_dir"
    chown "$AGENT_USER:$AGENT_GROUP" "$agent_config_dir"
fi

echo "Directories OK."
echo ""

# --- Verify repo ---

if [ ! -f "$AGENT_DIR/package.json" ]; then
    echo "WARNING: No package.json found in $AGENT_DIR."
    echo "You need to clone the repo first:"
    echo ""
    echo "  sudo -u $AGENT_USER git clone <repo-url> $AGENT_DIR"
    echo ""
    echo "Then re-run this script."
    exit 1
fi

# --- Install dependencies ---

echo "Installing npm dependencies..."
sudo -u "$AGENT_USER" bash -c "cd $AGENT_DIR && npm install --production=false"
echo ""

# --- Build ---

echo "Building TypeScript..."
sudo -u "$AGENT_USER" bash -c "cd $AGENT_DIR && npm run build"
echo ""

# --- Make scripts executable ---

echo "Setting script permissions..."
chmod +x "$DEPLOY_DIR/deploy.sh"
chmod +x "$DEPLOY_DIR/timothy-git-sync.sh"
chmod +x "$DEPLOY_DIR/timothy-memory-watchdog.sh"
echo "Scripts marked executable."
echo ""

# --- Install systemd units (with template substitution) ---

# Template unit files use {{PLACEHOLDER}} markers that get replaced with
# values from identity.json at install time.

UNIT_FILES=(
    "timothy.service"
    "timothy-git-sync.service"
    "timothy-git-sync.timer"
    "timothy-memory-watchdog.service"
    "timothy-memory-watchdog.timer"
)

install_unit() {
    local src="$1"
    local dest="$2"

    if [ ! -f "$src" ]; then
        echo "  WARNING: $src not found, skipping" >&2
        return
    fi

    # Substitute all template placeholders
    sed \
        -e "s|{{AGENT_NAME}}|${AGENT_NAME}|g" \
        -e "s|{{AGENT_NAME_DISPLAY}}|${AGENT_NAME_DISPLAY}|g" \
        -e "s|{{AGENT_DIR}}|${AGENT_DIR}|g" \
        -e "s|{{AGENT_USER}}|${AGENT_USER}|g" \
        -e "s|{{AGENT_GROUP}}|${AGENT_GROUP}|g" \
        -e "s|{{CONFIG_DIR}}|${CONFIG_DIR}|g" \
        -e "s|{{LOG_PREFIX}}|${LOG_PREFIX}|g" \
        -e "s|{{SERVICE_PREFIX}}|${SERVICE_PREFIX}|g" \
        "$src" > "$dest"
}

echo "Installing systemd unit files..."
for unit in "${UNIT_FILES[@]}"; do
    src="$DEPLOY_DIR/$unit"
    dest="/etc/systemd/system/$unit"
    install_unit "$src" "$dest"
    echo "  Installed $unit"
done
echo ""

echo "Reloading systemd daemon..."
systemctl daemon-reload
echo ""

# --- Sudoers for agent user ---
# Full sudo access — agent needs to manage services, install packages, etc.

SUDOERS_FILE="/etc/sudoers.d/$AGENT_NAME"
SUDOERS_CONTENT="# Full sudo access for $AGENT_NAME user
$AGENT_USER ALL=(ALL) NOPASSWD: ALL"

echo "Installing sudoers rules for $AGENT_USER..."
echo "$SUDOERS_CONTENT" > "$SUDOERS_FILE"
chmod 0440 "$SUDOERS_FILE"
# Validate the sudoers file
if visudo -cf "$SUDOERS_FILE" &>/dev/null; then
    echo "  Sudoers file installed at $SUDOERS_FILE"
else
    echo "  ERROR: Invalid sudoers syntax, removing $SUDOERS_FILE" >&2
    rm -f "$SUDOERS_FILE"
    exit 1
fi
echo ""

# --- Enable units ---

echo "Enabling units..."
systemctl enable timothy.service
systemctl enable timothy-git-sync.timer
systemctl enable timothy-memory-watchdog.timer
echo ""

# --- Start units ---

echo "Starting units..."
systemctl start timothy.service
systemctl start timothy-git-sync.timer
systemctl start timothy-memory-watchdog.timer
echo ""

# --- Status ---

echo "=== Status ==="
echo ""
echo "--- timothy.service ---"
systemctl status timothy.service --no-pager || true
echo ""
echo "--- timothy-git-sync.timer ---"
systemctl status timothy-git-sync.timer --no-pager || true
echo ""
echo "--- timothy-memory-watchdog.timer ---"
systemctl status timothy-memory-watchdog.timer --no-pager || true
echo ""

# --- Reminder ---

echo "=== Install complete ==="
echo ""
echo "Next steps:"
echo "  1. Set up the environment file:"
echo "     sudo -u $AGENT_USER cp $AGENT_DIR/.env.example $AGENT_DIR/.env"
echo "     sudo -u $AGENT_USER vim $AGENT_DIR/.env"
echo "     (Set TELEGRAM_BOT_TOKEN and any other variables)"
echo ""
echo "  2. Configure git for the $AGENT_NAME user (needed for git-sync):"
echo "     sudo -u $AGENT_USER git -C $AGENT_DIR config user.name \"${AGENT_NAME_DISPLAY}\""
echo "     sudo -u $AGENT_USER git -C $AGENT_DIR config user.email \"${AGENT_NAME}@example.com\""
echo ""
echo "  3. Set up Claude Code CLI authentication:"
echo "     sudo -u $AGENT_USER claude setup-token"
echo ""
echo "  4. Restart the service after configuring .env:"
echo "     sudo systemctl restart timothy.service"
echo ""
echo "  5. Check logs:"
echo "     journalctl -u $AGENT_NAME -f"
