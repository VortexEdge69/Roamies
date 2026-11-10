#!/usr/bin/env bash
# Jarvis Hub: one-command install for Ubuntu 22.04 / 24.04. Run on the VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/VortexEdge69/Roamies/main/server/jarvis-hub/deploy/install.sh | sudo bash -s -- jarvis.vecrahost.in
#
# During install it shows a claude.ai link to sign Jarvis's brain in with your Claude subscription (no API key).
# Optional: GROQ_API_KEY=gsk_… (free) before `bash` turns on voice; ANTHROPIC_API_KEY=… uses an API key instead.
#
# Installs Node 22, Caddy (automatic HTTPS), the hub as a systemd service, a firewall, and a daily safe
# self-update that rolls back on failure. Creates device tokens for desktop, phone and pendant on first run.
# Safe to run again: it updates the code and keeps your .env, data and tokens.
set -euo pipefail

# Everything runs inside main(), so a `curl | bash` install is fully read before any step runs.
main() {

DOMAIN="${1:-${DOMAIN:-}}"
REPO="${REPO:-https://github.com/VortexEdge69/Roamies.git}"
BRANCH="${BRANCH:-main}"
APP=/opt/jarvis
HUB="$APP/server/jarvis-hub"
DATA=/var/lib/jarvis-hub

[ "$(id -u)" = 0 ] || { echo "Run as root: … | sudo bash -s -- <domain>"; exit 1; }
[ -n "$DOMAIN" ] || { echo "Usage: … | sudo bash -s -- <domain>"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || echo "Warning: written for Ubuntu, this is $ID $VERSION_ID. Continuing."
export DEBIAN_FRONTEND=noninteractive

echo "==> Checking DNS for $DOMAIN"
IP=$(curl -fsS4 --max-time 10 https://api.ipify.org || true)
DNS=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ -n "$IP" ] && [ "$DNS" != "$IP" ]; then
  echo "   Warning: $DOMAIN points to '${DNS:-nothing}', this server is $IP. HTTPS will fail until the A record points here."
fi

echo "==> Packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https >/dev/null

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "   node $(node -v)"

USE_NGINX=0
if systemctl is-active --quiet nginx 2>/dev/null; then USE_NGINX=1; fi
echo "==> Web server: $([ $USE_NGINX = 1 ] && echo 'nginx is already running, using it (no Caddy)' || echo Caddy)"
if [ "$USE_NGINX" = 0 ] && ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> User and folders"
id jarvis >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin jarvis
mkdir -p "$DATA" && chown -R jarvis:jarvis "$DATA" && chmod 700 "$DATA"

echo "==> Code"
if [ -d "$APP/.git" ]; then
  sudo -u jarvis git -C "$APP" fetch --depth 1 -q origin "$BRANCH"
  sudo -u jarvis git -C "$APP" reset --hard -q FETCH_HEAD
else
  mkdir -p "$APP" && chown jarvis:jarvis "$APP"
  sudo -u jarvis git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi
sudo -u jarvis bash -c "cd '$HUB' && npm ci --omit=dev --no-audit --no-fund -q"

echo "==> Settings"
ENV="$HUB/.env"
if [ ! -f "$ENV" ]; then
  cp "$HUB/.env.example" "$ENV"
  sed -i "s#^HUB_DATA_DIR=.*#HUB_DATA_DIR=$DATA#" "$ENV"
fi
setenv() { [ -n "$2" ] || return 0; if grep -q "^$1=" "$ENV"; then sed -i "s#^$1=.*#$1=$2#" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; echo "   set $1"; }
setenv ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}"
setenv GROQ_API_KEY "${GROQ_API_KEY:-}"
setenv OPENAI_API_KEY "${OPENAI_API_KEY:-}"
setenv HUB_USER_NAME "${HUB_USER_NAME:-}"
chown jarvis:jarvis "$ENV"; chmod 600 "$ENV"

echo "==> Brain sign-in"
if ! grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)=.+' "$ENV"; then
  if [ -r /dev/tty ] && [ "${SKIP_LOGIN:-0}" != 1 ]; then
    bash "$HUB/deploy/login.sh" || echo "   Sign-in skipped. Later: sudo bash $HUB/deploy/login.sh"
  else
    echo "   No terminal here. Later: sudo bash $HUB/deploy/login.sh"
  fi
else
  echo "   already set"
fi

echo "==> Services"
mkdir -p "$DATA/claude" && chown jarvis:jarvis "$DATA/claude" && chmod 700 "$DATA/claude"
cp "$HUB/deploy/jarvis-hub.service" "$HUB/deploy/jarvis-hub-update.service" "$HUB/deploy/jarvis-hub-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q jarvis-hub jarvis-hub-update.timer
systemctl restart jarvis-hub
systemctl start jarvis-hub-update.timer

echo "==> HTTPS"
if [ "$USE_NGINX" = 1 ]; then
  if grep -rqs "server_name[^;]*$DOMAIN" /etc/nginx/sites-enabled /etc/nginx/conf.d; then
    echo "   nginx already serves $DOMAIN; check it matches $HUB/deploy/nginx-jarvis.conf (WebSocket headers, no auth_basic)"
  else
    echo "   Add the nginx site:  sed 's/jarvis.vecrahost.in/$DOMAIN/g' $HUB/deploy/nginx-jarvis.conf | sudo tee /etc/nginx/sites-available/jarvis"
    echo "   then: sudo ln -sf /etc/nginx/sites-available/jarvis /etc/nginx/sites-enabled/ && sudo certbot --nginx -d $DOMAIN && sudo nginx -t && sudo systemctl reload nginx"
  fi
else
CF=/etc/caddy/Caddyfile
if ! grep -q "^$DOMAIN" "$CF" 2>/dev/null; then
  if grep -qE "^:80" "$CF" 2>/dev/null; then cp "$CF" "$CF.default.bak"; : > "$CF"; fi
  sed "s/jarvis.example.com/$DOMAIN/" "$HUB/deploy/Caddyfile.example" >> "$CF"
fi
caddy validate --config "$CF" --adapter caddyfile >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

echo "==> Firewall"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8787/health >/dev/null || { echo "The hub didn't start: journalctl -u jarvis-hub -n 50"; exit 1; }

# First install: one token per device. Shown once; saved nowhere but here.
TOKENS=""
if [ "$(sudo -u jarvis node "$HUB/src/cli.mjs" list)" = "No devices." ]; then
  for d in "desktop desktop" "phone phone" "pendant pendant"; do
    set -- $d
    T=$(cd "$HUB" && sudo -u jarvis node src/cli.mjs add "$1" "$2" | grep -o 'jh_[A-Za-z0-9_-]*')
    TOKENS="$TOKENS$1=$T\n"
  done
fi

echo
echo "================================================================"
echo " Jarvis Hub is running:  https://$DOMAIN"
echo "================================================================"
if [ -n "$TOKENS" ]; then
  DESK=$(printf "$TOKENS" | sed -n 's/^desktop=//p'); PHONE=$(printf "$TOKENS" | sed -n 's/^phone=//p'); PEND=$(printf "$TOKENS" | sed -n 's/^pendant=//p')
  cat <<MSG

 Device tokens (shown ONCE, copy them now):

   desktop  $DESK
   phone    $PHONE
   pendant  $PEND

 Phone (Jarvis app): open this link on the phone to pair in one tap:
   jarvis://pair?url=https://$DOMAIN&token=$PHONE
 Phone (browser instead): https://$DOMAIN/#token=$PHONE

 Desktop (Roamies): save this as %USERPROFILE%\\.gg\\sidekick\\hub.json (Windows)
   or ~/.gg/sidekick/hub.json (Mac), then restart Roamies:
   {"url":"https://$DOMAIN","token":"$DESK","name":"desktop"}
MSG
fi
grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)=.+' "$ENV" || echo -e "\n Sign the brain in:  sudo bash $HUB/deploy/login.sh   (opens a claude.ai link, no API key)"
grep -qE '^(GROQ_API_KEY|STT_API_KEY|OPENAI_API_KEY)=.+' "$ENV" || echo " Add a speech key: GROQ_API_KEY=… in the same file (free at console.groq.com)"
cat <<MSG

 More devices:   cd $HUB && sudo -u jarvis node src/cli.mjs add <name> <kind>
 Revoke one:     cd $HUB && sudo -u jarvis node src/cli.mjs remove <name>
 Logs:           journalctl -u jarvis-hub -f
 Updates:        automatic, daily, with rollback (journalctl -u jarvis-hub-update)
MSG
}

main "$@" </dev/null
