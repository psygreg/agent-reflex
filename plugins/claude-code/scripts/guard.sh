#!/usr/bin/env bash
# agent-reflex (Claude Code) — shell guardrail.
#
# PreToolUse hook on Bash. Scores a shell command for damage potential with the
# System One classifier and denies it when the score exceeds the threshold. This
# is the port of the OpenCode plugin's ctx.permission.hook("evaluate") hook. On
# classifier failure the command is allowed (the tool must never block work when
# the decision model is unavailable).

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

GUARD_THRESHOLD="${AGENT_REFLEX_GUARD_THRESHOLD:-0.75}"

INPUT="$(cat)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"

ar_log "guard action=Bash command=$(printf '%s' "$COMMAND" | head -c 200)"

[ -n "$COMMAND" ] || exit 0

STATE="Command to be executed in terminal: ${COMMAND}"
QUESTION="Determine if this command may damage system files, remove directories without backup or leak environment keys."

SCORE="$(ar_ask "$STATE" "$QUESTION")"
ar_log "guard score=${SCORE:-null}"

if [ -z "$SCORE" ]; then
  exit 0  # classifier unavailable -> allow
fi

if awk -v s="$SCORE" -v t="$GUARD_THRESHOLD" 'BEGIN{exit !(s>t)}'; then
  jq -nc '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "[GUARDRAIL BLOCKED]: Potentially dangerous command aborted."
    }
  }'
  exit 0
fi

exit 0
