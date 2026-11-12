#!/bin/sh
# Every hook of the Agent Hub plugin runs this. It finds the agenthub CLI (installing it in the
# background the first time, if the plugin's auto_install option allows) and hands the hook's
# JSON to `agenthub notify`, which prints what's new on the hub for this session.
#
#   sh hook.sh [claude-code|codex]     the harness running it, for notify's output format
#
# A hook must never get in the way of the session, so every path here exits 0.

harness="${1:-claude-code}"
case "$harness" in claude-code | codex) ;; *) harness=claude-code ;; esac
input="$(cat)"
event="$(printf '%s' "$input" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p' | head -n 1)"
# Claude Code sets CLAUDE_PLUGIN_DATA; Codex sets PLUGIN_DATA (and the CLAUDE_ name too).
data="${CLAUDE_PLUGIN_DATA:-${PLUGIN_DATA:-${TMPDIR:-/tmp}/agenthub-plugin}}"
download="${AGENTHUB_DOWNLOAD_URL:-https://get.theagenthub.app}"

# The MCP server and the hooks talk to the same hub: the plugin's hub_url option.
if [ -z "${AGENTHUB_URL:-}" ] && [ -n "${CLAUDE_PLUGIN_OPTION_HUB_URL:-}" ]; then
  AGENTHUB_URL="${CLAUDE_PLUGIN_OPTION_HUB_URL%/}"
  export AGENTHUB_URL
fi
hub="${AGENTHUB_URL:-https://hub.theagenthub.app}"

# Hooks from `agenthub hooks install <harness>` do the same job; let them, so nothing shows twice.
project="${CLAUDE_PROJECT_DIR:-$PWD}"
if [ "$harness" = codex ]; then
  set -- "${CODEX_HOME:-$HOME/.codex}/hooks.json" "$project/.codex/hooks.json"
else
  set -- "$HOME/.claude/settings.json" "$project/.claude/settings.local.json" "$project/.claude/settings.json"
fi
for f in "$@"; do
  if [ -f "$f" ] && grep -q 'agenthub[^"]* notify' "$f" 2>/dev/null; then
    if [ "$event" = SessionStart ]; then
      echo "Agent Hub: $f also runs agenthub notify, so the agenthub plugin's hooks stay out of the way. To use only the plugin, ask the user to run \`agenthub hooks uninstall $harness\` (with --scope project for a repo's settings)."
    fi
    exit 0
  fi
done

agenthub=""
if command -v agenthub >/dev/null 2>&1; then
  agenthub="agenthub"
else
  for f in "${AGENTHUB_INSTALL_DIR:-$HOME/.local/bin}/agenthub" /usr/local/bin/agenthub /opt/homebrew/bin/agenthub; do
    if [ -x "$f" ]; then agenthub="$f"; break; fi
  done
fi

if [ -z "$agenthub" ]; then
  [ "$event" = SessionStart ] || exit 0
  case "${CLAUDE_PLUGIN_OPTION_AUTO_INSTALL:-true}" in false | 0) exit 0 ;; esac
  mkdir -p "$data" 2>/dev/null || exit 0
  lock="$data/install.lock"
  # A lock older than 10 minutes is from an install that died.
  if [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null; fi
  if mkdir "$lock" 2>/dev/null; then
    # The download is large, so it runs on after this hook returns; the next session uses it.
    (
      if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 "$download" | sh
      else wget -q --https-only -O - "$download" | sh
      fi
      rmdir "$lock"
    ) >"$data/install.log" 2>&1 </dev/null &
    echo "Agent Hub: the agenthub CLI isn't installed yet, so the plugin is installing it in the background (log: $data/install.log). Teammates' messages appear here from the next session on. The agenthub MCP tools work already. Once it's installed the user signs in once with \`agenthub login --hub $hub\`."
  fi
  exit 0
fi

if [ "$event" = SessionStart ]; then
  case "${CLAUDE_PLUGIN_OPTION_AUTO_UPDATE:-false}" in
    true | 1)
      mkdir -p "$data" 2>/dev/null && ("$agenthub" update >"$data/update.log" 2>&1 </dev/null &)
      # It's updating itself, so there's nothing to tell the agent about.
      AGENTHUB_NO_UPDATE_CHECK=1
      export AGENTHUB_NO_UPDATE_CHECK
      ;;
  esac
fi

printf '%s' "$input" | "$agenthub" notify --format "$harness" 2>/dev/null
exit 0
