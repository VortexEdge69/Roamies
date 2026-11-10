#!/usr/bin/env bash
# Safe self-update for Jarvis Hub, run daily by jarvis-hub-update.timer (or by hand: sudo bash update.sh).
# Pulls the newest main, installs, runs the hub's tests against a throwaway copy, restarts, checks /health,
# and rolls back to the previous commit if anything fails. Your data and .env are never touched.
set -uo pipefail
APP=/opt/jarvis
HUB="$APP/server/jarvis-hub"
BRANCH="${BRANCH:-main}"
LOG() { echo "[jarvis-update] $*"; }

cd "$APP" || exit 1
OLD=$(sudo -u jarvis git rev-parse HEAD)
sudo -u jarvis git fetch --depth 1 origin "$BRANCH" -q || { LOG "fetch failed"; exit 0; }
NEW=$(sudo -u jarvis git rev-parse FETCH_HEAD)
[ "$OLD" = "$NEW" ] && { LOG "up to date ($OLD)"; exit 0; }
LOG "updating $OLD -> $NEW"

rollback() {
  LOG "FAILED: $1 — rolling back to $OLD"
  sudo -u jarvis git reset --hard -q "$OLD"
  sudo -u jarvis bash -c "cd '$HUB' && npm ci --omit=dev --no-audit --no-fund -q" || true
  systemctl restart jarvis-hub
  exit 1
}

sudo -u jarvis git reset --hard -q "$NEW"
sudo -u jarvis bash -c "cd '$HUB' && npm ci --no-audit --no-fund -q" || rollback "npm ci"
sudo -u jarvis bash -c "cd '$HUB' && HUB_ENV_FILE=/nonexistent npm test --silent" || rollback "tests"
sudo -u jarvis bash -c "cd '$HUB' && npm prune --omit=dev --no-audit --no-fund -q" || true
chown -R jarvis:jarvis /var/lib/jarvis-hub   # files left root-owned by manual commands lock the hub out
cp "$HUB/deploy/jarvis-hub.service" /etc/systemd/system/jarvis-hub.service && systemctl daemon-reload
systemctl restart jarvis-hub
for i in $(seq 1 15); do
  sleep 1
  curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && { LOG "updated to $NEW, healthy"; exit 0; }
done
rollback "health check"
