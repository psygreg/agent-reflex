#!/usr/bin/env bash
# agent-reflex (Antigravity) — compaction guidance.
#
# PostInvocation hook. Antigravity owns compaction and exposes no hook to steer
# what the summary keeps (no PreCompact custom_instructions equivalent — that is a
# Claude Code/Qwen Code lever). Its on_compaction SDK hook exists but the hooks.json
# surface has no compaction event, and PostToolUse/PostInvocation cannot rewrite
# history. So the plugin's custom per-message pruning (the OpenCode context hook)
# and compaction steering both have no Antigravity equivalent.
#
# This hook is inert by default: it only logs the trigger. Set
# AGENT_REFLEX_COMPACT_NOTE=1 to append a preserve-requirements reminder to the
# pending check buffer so the next PreInvocation surfaces it alongside any edit
# findings. The durable version of the guidance lives in the classify hook's
# complexity note.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

INPUT="$(cat)"
CONV="$(printf '%s' "$INPUT" | jq -r '.conversationId // empty' 2>/dev/null)"
ar_log "compact post-invocation conv=${CONV:-unknown}"

if [ "${AGENT_REFLEX_COMPACT_NOTE:-0}" = "1" ]; then
  PENDING="$STATE_DIR/pending-${CONV:-default}"
  echo "[agent-reflex] Context compaction may run: preserve architectural requirements, scope, and rules; keep tool call/result pairings intact." >> "$PENDING"
fi

echo '{}'
exit 0
