#!/usr/bin/env bash
# Sign Jarvis's brain in with your Claude subscription (Pro/Max) through a link — no API key.
# Runs Claude Code's `claude setup-token`: it shows a link, you open it on any device, sign in to claude.ai,
# approve, and it prints a long-lived token (about a year). The token is saved to the hub's .env (chmod 600)
# and the hub restarts. Run again any time to renew:  sudo bash /opt/jarvis/server/jarvis-hub/deploy/login.sh
set -euo pipefail
main() {
  local HUB=/opt/jarvis/server/jarvis-hub ENV=/opt/jarvis/server/jarvis-hub/.env CFG=/var/lib/jarvis-hub/claude
  [ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
  [ -r /dev/tty ] || { echo "Needs an interactive terminal (an SSH session)."; exit 1; }
  local CLAUDE
  CLAUDE=$(ls "$HUB"/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude 2>/dev/null | head -1 || true)
  [ -x "$CLAUDE" ] || { echo "Claude Code wasn't installed with the hub; run the installer again."; exit 1; }
  mkdir -p "$CFG" && chown jarvis:jarvis "$CFG" && chmod 700 "$CFG"

  cat <<'MSG'

=== Sign Jarvis in with your Claude account ===
1. A link appears below. Open it on your phone or laptop and sign in to claude.ai.
2. Approve access. If the page shows a code, paste it back here.
3. A token starting with sk-ant-oat appears at the end. Copy it; you'll paste it once more.

MSG
  sudo -u jarvis env HOME="$CFG" CLAUDE_CONFIG_DIR="$CFG" "$CLAUDE" setup-token </dev/tty >/dev/tty 2>&1 || true

  local TOKEN=""
  for _ in 1 2 3; do
    printf "\nPaste the token shown above (input hidden): " >/dev/tty
    IFS= read -rs TOKEN </dev/tty; echo >/dev/tty
    TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
    [[ "$TOKEN" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] && break
    echo "That doesn't look like a Claude token (it starts with sk-ant-)." >/dev/tty; TOKEN=""
  done
  [ -n "$TOKEN" ] || { echo "No token saved. Run this again when ready."; exit 1; }

  touch "$ENV"
  if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV"; then sed -i "s#^CLAUDE_CODE_OAUTH_TOKEN=.*#CLAUDE_CODE_OAUTH_TOKEN=$TOKEN#" "$ENV"
  else echo "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" >> "$ENV"; fi
  # The subscription is the brain now; an API key left in .env would take priority, so switch explicitly.
  if grep -q '^HUB_PROVIDER=' "$ENV"; then sed -i 's#^HUB_PROVIDER=.*#HUB_PROVIDER=claude#' "$ENV"; else echo "HUB_PROVIDER=claude" >> "$ENV"; fi
  chown jarvis:jarvis "$ENV"; chmod 600 "$ENV"
  systemctl restart jarvis-hub 2>/dev/null || true
  echo "Signed in. Jarvis's brain now uses your Claude subscription."
}
main "$@"
