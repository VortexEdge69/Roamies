#!/usr/bin/env bash
# Jarvis Hub installer for Ubuntu 22.04 / 24.04. Run as root on the VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/VortexEdge69/Roamies/main/server/jarvis-hub/deploy/install.sh -o install.sh
#   sudo bash install.sh jarvis.vecrahost.in
#
# Installs Node 22, Caddy (HTTPS), the hub as a systemd service, and a firewall. Safe to run again to update.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${2:-https://github.com/VortexEdge69/Roamies.git}"
BRANCH="${BRANCH:-main}"
APP=/opt/jarvis
HUB="$APP/server/jarvis-hub"
DATA=/var/lib/jarvis-hub

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo bash install.sh <domain>)"; exit 1; }
[ -n "$DOMAIN" ] || { echo "Usage: sudo bash install.sh <domain> [git-repo-url]"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || echo "Warning: written for Ubuntu, you have $ID $VERSION_ID. Continuing."

echo "==> Packages"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> User and folders"
id jarvis >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin jarvis
mkdir -p "$DATA" && chown jarvis:jarvis "$DATA" && chmod 700 "$DATA"

echo "==> Code"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --depth 1 origin "$BRANCH" && git -C "$APP" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi
chown -R jarvis:jarvis "$APP"
sudo -u jarvis bash -c "cd '$HUB' && npm ci --omit=dev --no-audit --no-fund"

if [ ! -f "$HUB/.env" ]; then
  cp "$HUB/.env.example" "$HUB/.env"
  sed -i "s#^HUB_DATA_DIR=.*#HUB_DATA_DIR=$DATA#" "$HUB/.env"
  chown jarvis:jarvis "$HUB/.env"; chmod 600 "$HUB/.env"
  NEW_ENV=1
fi

echo "==> Service"
cp "$HUB/deploy/jarvis-hub.service" /etc/systemd/system/jarvis-hub.service
systemctl daemon-reload
systemctl enable jarvis-hub
systemctl restart jarvis-hub

echo "==> HTTPS for $DOMAIN"
CF=/etc/caddy/Caddyfile
if ! grep -q "^$DOMAIN" "$CF" 2>/dev/null; then
  if grep -q "^:80" "$CF" 2>/dev/null; then cp "$CF" "$CF.default.bak"; : > "$CF"; fi
  sed "s/jarvis.example.com/$DOMAIN/" "$HUB/deploy/Caddyfile.example" >> "$CF"
fi
caddy validate --config "$CF" --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -8

sleep 2
curl -fsS http://127.0.0.1:8787/health && echo

cat <<MSG

Jarvis Hub is installed at https://$DOMAIN

Next:
  1. Add your API keys:   sudo nano $HUB/.env     (ANTHROPIC_API_KEY, GROQ_API_KEY)
                          sudo systemctl restart jarvis-hub
  2. Add your devices (each prints a token, shown once):
       cd $HUB && sudo -u jarvis node src/cli.mjs add desktop desktop
       cd $HUB && sudo -u jarvis node src/cli.mjs add phone phone
       cd $HUB && sudo -u jarvis node src/cli.mjs add pendant pendant
  3. Desktop: save ~/.gg/sidekick/hub.json  {"url":"https://$DOMAIN","token":"jh_..."}  and restart Roamies.
     Phone: open https://$DOMAIN in Chrome, paste the phone token, then menu → Add to Home screen.
  Logs: journalctl -u jarvis-hub -f
MSG
[ "${NEW_ENV:-0}" = 1 ] && echo "(A fresh .env was created from .env.example.)"
