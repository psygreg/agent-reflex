#!/usr/bin/env bash
# agent-reflex (Antigravity) — shell guardrail.
#
# PreToolUse hook on run_command. Scores a shell command for damage potential
# with the System One classifier and denies it (decision: "deny", a hard block)
# when the score exceeds the threshold. Port of the OpenCode plugin's
# ctx.permission.hook("evaluate") hook. On classifier failure the command is
# allowed (the tool must never block work when the decision model is unavailable).

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

GUARD_THRESHOLD="${AGENT_REFLEX_GUARD_THRESHOLD:-0.75}"

INPUT="$(cat)"
# Antigravity PreToolUse payload: toolCall.name + toolCall.args.{CommandLine,Cwd,...}
COMMAND="$(printf '%s' "$INPUT" | jq -r '.toolCall.args.CommandLine // .toolCall.args.commandLine // empty' 2>/dev/null)"

ar_log "guard action=run_command command=$(printf '%s' "$COMMAND" | head -c 200)"

[ -n "$COMMAND" ] || { echo '{"decision":"allow"}'; exit 0; }

STATE="Command to be executed in terminal: ${COMMAND}"
QUESTION="Determine if this command may damage system files, remove directories without backup or leak environment keys."

SCORE="$(ar_ask "$STATE" "$QUESTION")"
ar_log "guard score=${SCORE:-null}"

if [ -z "$SCORE" ]; then
  echo '{"decision":"allow"}'  # classifier unavailable -> allow
  exit 0
fi

if awk -v s="$SCORE" -v t="$GUARD_THRESHOLD" 'BEGIN{exit !(s>t)}'; then
  jq -nc '{
    decision: "deny",
    reason: "[GUARDRAIL BLOCKED]: Potentially dangerous command aborted."
  }'
else
  echo '{"decision":"allow"}'
fi
exit 0
