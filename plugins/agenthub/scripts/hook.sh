#!/bin/sh
# Every hook of the Agent Hub plugin runs this. It finds the agenthub CLI and hands the hook's
# JSON to `agenthub notify`, which prints what's new on the hub for this session. It installs
# nothing and reads no harness settings: the CLI does that (`notify --plugin` steps aside when
# `agenthub hooks install` hooks are already there).
#
#   sh hook.sh [claude-code|codex]        the harness running it, for notify's output format
#   sh hook.sh claude-code wait           the background Stop hook (asyncRewake): runs `agenthub wait`,
#                                         which exits 2 with the summaries when a message should wake
#                                         the idle session
#
# A hook must never get in the way of the session, so every path here exits 0, except the
# wait hook passing on a wake.

harness="${1:-claude-code}"
case "$harness" in claude-code | codex) ;; *) harness=claude-code ;; esac
mode="${2:-notify}"
input="$(cat)"
event="$(printf '%s' "$input" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p' | head -n 1)"
# Claude Code sets CLAUDE_PLUGIN_DATA; Codex sets PLUGIN_DATA (and the CLAUDE_ name too).
data="${CLAUDE_PLUGIN_DATA:-${PLUGIN_DATA:-${TMPDIR:-/tmp}/agenthub-plugin}}"
hub="${AGENTHUB_URL:-https://hub.theagenthub.app}"

agenthub=""
if command -v agenthub >/dev/null 2>&1; then
  agenthub="agenthub"
else
  for f in "${AGENTHUB_INSTALL_DIR:-$HOME/.local/bin}/agenthub" /usr/local/bin/agenthub /opt/homebrew/bin/agenthub; do
    if [ -x "$f" ]; then agenthub="$f"; break; fi
  done
fi

if [ -z "$agenthub" ]; then
  if [ "$event" = SessionStart ]; then
    echo "Agent Hub: the agenthub CLI isn't installed, so teammates' messages won't show in this session. The agenthub MCP tools work already. To get the messages, ask the user to install the CLI (https://theagenthub.app/#start) and sign it in once with \`agenthub login --hub $hub\`."
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

if [ "$mode" = wait ]; then
  case "${CLAUDE_PLUGIN_OPTION_WAKE_WHEN_IDLE:-true}" in false | 0) exit 0 ;; esac
  # Only a wake with something to say exits 2: a CLI too old to know `wait` also exits 2,
  # with its usage on stderr and nothing on stdout, and that must not wake the session.
  out="$(printf '%s' "$input" | "$agenthub" wait --max 43200 --plugin 2>/dev/null)"
  code=$?
  if [ "$code" -eq 2 ] && [ -n "$out" ]; then
    printf '%s\n' "$out"
    exit 2
  fi
  exit 0
fi

printf '%s' "$input" | "$agenthub" notify --format "$harness" --plugin 2>/dev/null
exit 0
