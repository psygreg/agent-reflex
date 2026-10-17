#!/usr/bin/env bash
# agent-reflex (Codex) — compaction guidance.
#
# PreCompact hook (matcher auto|manual). Codex owns compaction and does not let a
# hook rewrite the conversation history or steer what the summary keeps (its
# PreCompact output is only continue/stopReason/systemMessage/suppressOutput; it
# has no custom_instructions). So the plugin's custom per-message pruning (the
# OpenCode context hook) and Claude Code's custom_instructions guidance both have
# no Codex equivalent. The only lever here is continue:false to cancel compaction,
# which is rarely what a user wants.
#
# This hook therefore records that a compaction is about to run and, when the
# preserve-requirements note is enabled (AGENT_REFLEX_COMPACT_NOTE=1), emits it as
# a systemMessage so it is at least visible in the transcript. The durable version
# of this guidance is delivered by the classify hook's complexity note instead.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

INPUT="$(cat)"
TRIGGER="$(printf '%s' "$INPUT" | jq -r '.trigger // empty' 2>/dev/null)"
ar_log "compact trigger=${TRIGGER:-unknown}"

if [ "${AGENT_REFLEX_COMPACT_NOTE:-0}" = "1" ]; then
  jq -nc '{
    systemMessage: "Compaction: preserve architectural requirements, scope, and rules; keep tool call/result pairings intact."
  }'
fi
exit 0
