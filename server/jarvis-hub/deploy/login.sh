#!/usr/bin/env bash
# Sign Jarvis's brain in with your Claude subscription (Pro/Max) through a link — no API key.
#
#   sudo bash /opt/jarvis/server/jarvis-hub/deploy/login.sh                  open a claude.ai link, get a token
#   sudo bash /opt/jarvis/server/jarvis-hub/deploy/login.sh --paste          already have an sk-ant-oat… token
#   sudo bash /opt/jarvis/server/jarvis-hub/deploy/login.sh --token sk-ant-oat01-…
#
# The link flow runs Claude Code's `claude setup-token`. It shows a link; open it, sign in, approve, and the page
# shows a CODE. Paste that code at "Paste code here if prompted" (not the token). Claude Code then prints a token
# starting with sk-ant-oat; paste that once more when this script asks. The token is saved to the hub's .env
# (chmod 600) and the hub restarts. It lasts about a year; run this again to renew.
#
# Stuck prompt? Claude Code's prompt ignores Ctrl+C. Open a second SSH session and run
#   sudo pkill -f 'claude setup-token'
# then in the stuck window type  reset  and press Enter. This script also gives up by itself after 10 minutes.
set -uo pipefail

HUB="${JARVIS_HUB_DIR:-/opt/jarvis/server/jarvis-hub}"
ENV="${JARVIS_ENV_FILE:-$HUB/.env}"
TTY=/dev/tty
WORK=""

restore_terminal() {
  # Undo anything a killed full-screen prompt left behind: raw mode, hidden cursor, bracketed paste.
  if [ -w "$TTY" ]; then
    stty sane <"$TTY" 2>/dev/null || true
    printf '\033[?2004l\033[?25h' >"$TTY" 2>/dev/null || true
  fi
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap restore_terminal EXIT
trap 'echo; echo "Cancelled."; exit 130' INT TERM

# Pasted text can arrive wrapped in bracketed-paste markers (ESC[200~ … ESC[201~) or carry other escape
# sequences and stray keys; keep only what a token can contain.
clean_token() {
  printf '%s' "$1" \
    | sed -E $'s/\x1b\\[[0-9;?]*[A-Za-z~]//g; s/\\^\\[\\[[0-9;?]*[A-Za-z~]//g' \
    | tr -cd 'A-Za-z0-9_-'
}

ask_token() {
  local raw tok
  for _ in 1 2 3; do
    printf '\033[?2004l' >"$TTY"   # bracketed paste off, so the paste arrives as plain text
    printf '\nPaste the token that starts with sk-ant-oat (input hidden, then Enter): ' >"$TTY"
    IFS= read -rs raw <"$TTY" || true
    echo >"$TTY"
    tok=$(clean_token "$raw")
    if [[ "$tok" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]]; then printf '%s' "$tok"; return 0; fi
    if [ -n "$raw" ]; then echo "That isn't a Claude token (it should start with sk-ant-oat). Try again, or Ctrl+C to stop." >"$TTY"; fi
  done
  return 1
}

save_token() {
  local tok="$1"
  touch "$ENV"
  # One line per key: drop old values, then append (sed with a token in the pattern is avoided on purpose).
  grep -vE '^(CLAUDE_CODE_OAUTH_TOKEN|HUB_PROVIDER)=' "$ENV" >"$ENV.tmp" || true
  { cat "$ENV.tmp"; echo "HUB_PROVIDER=claude"; echo "CLAUDE_CODE_OAUTH_TOKEN=$tok"; } >"$ENV"
  rm -f "$ENV.tmp"
  chmod 600 "$ENV"
  id jarvis >/dev/null 2>&1 && chown jarvis:jarvis "$ENV"
  if systemctl restart jarvis-hub 2>/dev/null; then
    sleep 2
    if curl -fsS http://127.0.0.1:8787/health 2>/dev/null | grep -q '"brain":true'; then
      echo "Signed in. Jarvis's brain now uses your Claude subscription."
    else
      echo "Token saved, but the hub isn't reporting a brain yet. Check: journalctl -u jarvis-hub -n 30"
    fi
  else
    echo "Token saved to $ENV. Restart the hub to use it: systemctl restart jarvis-hub"
  fi
}

claude_bin() {
  local arch libc=""
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) return 1 ;; esac
  ldd --version 2>&1 | grep -qi musl && libc=-musl
  local b="$HUB/node_modules/@anthropic-ai/claude-agent-sdk-linux-$arch$libc/claude"
  [ -x "$b" ] && printf '%s' "$b"
}

main() {
  [ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
  [ -r "$TTY" ] && [ -w "$TTY" ] || { echo "Needs an interactive terminal (an SSH session)."; exit 1; }

  case "${1:-}" in
    --token)
      local tok; tok=$(clean_token "${2:-}")
      [[ "$tok" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] || { echo "That isn't a Claude token."; exit 1; }
      save_token "$tok"; return ;;
    --paste)
      local tok; tok=$(ask_token) || { echo "No token saved."; exit 1; }
      save_token "$tok"; return ;;
  esac

  local CLAUDE; CLAUDE=$(claude_bin) || { echo "Claude Code isn't installed with the hub; run the installer again."; exit 1; }
  WORK=$(mktemp -d /tmp/jarvis-login.XXXXXX)

  cat >"$TTY" <<'MSG'

=== Sign Jarvis in with your Claude account ===
1. Open the link below on your phone or laptop and sign in to claude.ai, then approve.
2. The page shows a CODE. Paste that code at "Paste code here if prompted" and press Enter.
   (Paste the code from the page, not a token.)
3. A token starting with sk-ant-oat appears. Copy it; this script asks for it next.
   Stuck? Second SSH window:  sudo pkill -f 'claude setup-token'   then type  reset  here.

MSG
  # Run Claude Code as root, attached straight to this terminal. Going through another sudo (sudo -u …) puts it
  # behind a second pseudo-terminal, where keystrokes and pastes never reach it. It saves nothing: its settings go
  # to a throwaway folder that is deleted afterwards.
  HOME="$WORK" CLAUDE_CONFIG_DIR="$WORK" timeout --foreground 600 "$CLAUDE" setup-token <"$TTY" >"$TTY" 2>&1
  local rc=$?
  restore_terminal_keep() { stty sane <"$TTY" 2>/dev/null || true; printf '\033[?2004l\033[?25h' >"$TTY"; }
  restore_terminal_keep
  [ "$rc" = 124 ] && echo "The sign-in timed out after 10 minutes." >"$TTY"

  local tok; tok=$(ask_token) || { echo "No token saved. Run this again, or use --paste if you have a token."; exit 1; }
  save_token "$tok"
}

main "$@"
