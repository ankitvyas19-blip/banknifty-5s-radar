#!/usr/bin/env bash
# ==============================================================================
# Vultr Cloud Compute (Ubuntu 22.04 / 24.04) Startup & 1-Click Deploy Script
# Paste this entire file into Vultr's "Startup Script" box on https://console.vultr.com/deploy/
# OR run directly on your Vultr server via SSH:
#   curl -fsSL https://raw.githubusercontent.com/ankitvyas19-blip/banknifty-5s-radar/main/deploy-vultr.sh | sudo bash
# ==============================================================================
set -euo pipefail

APP_DIR="/opt/banknifty-radar"
REPO_URL="${REPO_URL:-https://github.com/ankitvyas19-blip/banknifty-5s-radar.git}"

echo "=== [1/4] Installing Docker & Git on Vultr Ubuntu VM ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "=== [2/4] Opening Firewall Ports 22 (SSH), 80 (HTTP), and 8080 ==="
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 8080/tcp || true
ufw --force enable || true

echo "=== [3/4] Cloning / Updating BankNifty 5s Scalp Radar ==="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
mkdir -p "$APP_DIR/data"

echo "=== [4/4] Building & Starting 24x7 Always-On Container ==="
docker compose up -d --build

PUBLIC_IP="$(curl -4 -fsSL https://ifconfig.me || hostname -I | awk '{print $1}')"
echo ""
echo "=================================================================="
echo "BankNifty 5s Scalp Radar is LIVE on Vultr!"
echo "Open in browser:  http://${PUBLIC_IP}"
echo "Health endpoint:  http://${PUBLIC_IP}/api/health"
echo "Persistent DB:    ${APP_DIR}/data/radar.sqlite"
echo "=================================================================="
