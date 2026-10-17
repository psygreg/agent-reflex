#!/usr/bin/env bash
# agent-reflex (Claude Code) — compaction guidance.
#
# PreCompact hook (matcher auto|manual). Claude Code owns compaction and does not
# expose the message history to rewrite, so the plugin's custom per-message
# pruning (the OpenCode context hook) has no equivalent here. What this hook can
# do is steer Claude Code's own compaction via custom_instructions so the summary
# keeps the requirements, scope, and rules a coding agent must not lose. This is
# the documented Claude Code approximation of HOOK 1a.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

INPUT="$(cat)"
TRIGGER="$(printf '%s' "$INPUT" | jq -r '.trigger // empty' 2>/dev/null)"
ar_log "compact trigger=${TRIGGER:-unknown}"

jq -nc '{
  hookSpecificOutput: {
    hookEventName: "PreCompact",
    custom_instructions: "When summarizing, preserve architectural requirements, scope definitions, and crucial rules the agent must remember to code. Keep tool call/result pairings intact. Drop redundant conversational turns."
  }
}'
exit 0
