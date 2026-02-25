# Agent Deployment (systemd)

Systemd units for running the agent as a persistent service on a Linux VPS. All identity values (agent name, paths, service names) are read from `identity.json` at the repo root.

## Prerequisites

- Linux server with systemd
- Node.js >= 24.0.0
- npm
- jq (for identity config and memory watchdog)
- git
- Claude Code CLI (authenticated via `claude setup-token`)

## Units Overview

| Unit | Type | Purpose |
|------|------|---------|
| `timothy.service` | Service | Main agent process (Telegram bot) |
| `timothy-git-sync.service` + `.timer` | Timer | Commits and pushes workspace changes every 30 minutes |
| `timothy-memory-watchdog.service` + `.timer` | Timer | Restarts the agent if RSS exceeds 800 MB or heartbeat is stale |

## Scripts

| Script | Purpose |
|--------|---------|
| `install.sh` | First-time setup: creates user, installs units (with template substitution from `identity.json`), enables and starts everything |
| `deploy.sh` | Updates: pulls code, installs deps, rebuilds, restarts service |
| `timothy-git-sync.sh` | Called by the git-sync timer to commit and push workspace changes |
| `timothy-memory-watchdog.sh` | Called by the watchdog timer to check RSS and heartbeat health |

## Identity Configuration

All deploy scripts and systemd units are parameterized via `identity.json` at the repo root:

```json
{
  "agentName": "timothy",
  "agentNameDisplay": "Timothy",
  "configDir": ".timothy",
  "logPrefix": "timothy",
  "servicePrefix": "timothy"
}
```

- **Shell scripts** read `identity.json` with `jq` at runtime, falling back to `"timothy"` defaults
- **Systemd units** use `{{PLACEHOLDER}}` template markers that `install.sh` substitutes via `sed` at install time

## Quick Start

### First-time setup

```bash
# Clone the repo
sudo mkdir -p /opt/timothy
sudo chown $USER:$USER /opt/timothy
git clone https://github.com/dewdropsai/timothy.git /opt/timothy

# Configure environment
cp /opt/timothy/.env.example /opt/timothy/.env
vim /opt/timothy/.env   # Set TELEGRAM_BOT_TOKEN

# Run the install script (as root)
sudo /opt/timothy/deploy/install.sh
```

The install script will:
1. Read identity from `identity.json`
2. Create the agent user and group (if they don't exist)
3. Create the config directory (e.g. `~/.timothy/`)
4. Install npm dependencies and build TypeScript
5. Copy systemd unit files to `/etc/systemd/system/` with template substitution
6. Install sudoers rule granting the agent user full passwordless sudo access
7. Reload the systemd daemon
8. Enable and start all units
9. Print status and next-step instructions

### Deploy an update

```bash
# As the agent user
/opt/timothy/deploy/deploy.sh

# Or with sudo
sudo -u timothy /opt/timothy/deploy/deploy.sh
```

The deploy script will:
1. Read identity from `identity.json`
2. `git pull --ff-only`
3. `npm install`
4. `npm run build`
5. Restart the service
6. Print post-deploy status

## Environment Variables

Scripts accept environment variable overrides. Variable names use the `AGENT_` prefix:

| Variable | Default | Used by |
|----------|---------|---------|
| `AGENT_DIR` | `/opt/<agentName>` | deploy.sh, install.sh, git-sync |
| `AGENT_USER` | `<agentName>` | install.sh |
| `AGENT_GROUP` | `<agentName>` | install.sh |
| `AGENT_SERVICE_NAME` | `<agentName>` | deploy.sh, watchdog |
| `AGENT_STATUS_FILE` | `~/<configDir>/status.json` | watchdog |
| `AGENT_MEMORY_THRESHOLD_MB` | `800` | watchdog |
| `AGENT_STALE_THRESHOLD_SEC` | `300` | watchdog |
| `AGENT_SYSTEMD_SCOPE` | `system` | watchdog |

## Operations

### Check status

```bash
systemctl status timothy.service
systemctl status timothy-git-sync.timer
systemctl status timothy-memory-watchdog.timer
```

### View logs

```bash
# Follow live logs
journalctl -u timothy -f

# Logs from the last hour
journalctl -u timothy --since "1 hour ago"

# Git-sync logs
journalctl -u timothy-git-sync -f

# Watchdog logs
journalctl -u timothy-memory-watchdog -f
```

### Restart

```bash
sudo systemctl restart timothy.service
```

### Stop everything

```bash
sudo systemctl stop timothy.service
sudo systemctl stop timothy-git-sync.timer
sudo systemctl stop timothy-memory-watchdog.timer
```

## Service Details

### Main service

- Runs `npm start` (which runs `tsx src/index.ts`)
- Restarts automatically on crash (`Restart=always`, `RestartSec=5`)
- Memory capped at 1 GB (`MemoryMax=1G`)
- Watchdog timeout of 120 seconds (`WatchdogSec=120`)
- Loads environment from `<AGENT_DIR>/.env` (optional, the `-` prefix means the file is not required)
- Logs to the systemd journal under the identity's `logPrefix`
- Security hardening: read-only filesystem access except for `workspace/` and `~/<configDir>/`

### Git-sync (timer)

- Fires 5 minutes after boot, then every 30 minutes
- Runs `timothy-git-sync.sh` which checks for workspace changes, commits, and pushes
- Only commits if there are actual changes (no empty commits)
- Push failures are logged but don't prevent the next cycle
- 120-second timeout for git operations

### Memory watchdog (timer)

- Fires 2 minutes after boot, then every 5 minutes
- Reads `~/<configDir>/status.json` written by the agent's heartbeat (every 30 seconds)
- Restarts the service if RSS exceeds 800 MB (configurable via `AGENT_MEMORY_THRESHOLD_MB`)
- Restarts the service if heartbeat is stale for more than 300 seconds (configurable via `AGENT_STALE_THRESHOLD_SEC`)
- Requires `jq` for JSON parsing

## Troubleshooting

**Service won't start:**
```bash
journalctl -u timothy -n 50 --no-pager
```

**Permission errors:**
Ensure the workspace is writable by the agent user:
```bash
sudo chown -R timothy:timothy /opt/timothy/workspace
```

**Watchdog kills the process:**
The `WatchdogSec=120` setting expects the process to remain responsive. If the agent is consistently being killed by the watchdog, check for long-running Claude CLI invocations or memory pressure.

**Git-sync fails:**
Ensure the agent user has git configured and SSH keys or tokens set up for push access:
```bash
sudo -u timothy git -C /opt/timothy config user.name "Timothy"
sudo -u timothy git -C /opt/timothy config user.email "timothy@example.com"
```

**Watchdog can't restart the service:**
The watchdog and deploy scripts use `systemctl restart`. The install script creates a sudoers file granting full passwordless sudo. If that file is missing:
```bash
sudo visudo -f /etc/sudoers.d/timothy
# Add: timothy ALL=(ALL) NOPASSWD: ALL
```

**Watchdog reports "jq not found":**
```bash
sudo apt install jq   # Debian/Ubuntu
sudo dnf install jq   # Fedora/RHEL
```
