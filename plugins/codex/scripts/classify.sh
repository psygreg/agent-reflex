#!/usr/bin/env bash
# agent-reflex (Codex) — complexity classification.
#
# UserPromptSubmit hook. Scores the prompt with the System One classifier, stores
# the level for the session (used by the post-edit check and the /confidence
# command), and for medium/high injects a note suggesting a confidence check.
# This is the port of the OpenCode plugin's context-hook complexity stage. The
# OpenCode plugin additionally sets event.options.maxTokens per level; Codex has
# no hook to set the per-request token cap, so that part is documented as an
# OpenCode-only feature (see the plugin README).

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

INPUT="$(cat)"
PROMPT="$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)"
SESSION="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)"

[ -n "$PROMPT" ] || exit 0

# classify_complexity SCORE -> simple|medium|high (cut-offs match the plugin).
classify_level() {
  awk -v s="$1" 'BEGIN{ if(s>0.80) print "high"; else if(s>0.50) print "medium"; else print "simple" }'
}

STATE="User prompt: ${PROMPT}"
QUESTION="Does this prompt require deep logic thinking, complex algorithms or mathematical/concurrence bugs?"

SCORE="$(ar_ask "$STATE" "$QUESTION")"
[ -n "$SCORE" ] || exit 0  # classifier unavailable -> skip tuning

LEVEL="$(classify_level "$SCORE")"
echo "$LEVEL" > "$STATE_DIR/level-${SESSION:-default}" 2>/dev/null || true
ar_log "classify score=${SCORE} level=${LEVEL}"

PCT="$(awk -v s="$SCORE" 'BEGIN{printf "%d", s*100}')"

if [ "$LEVEL" = "simple" ]; then
  # No context injection needed for simple tasks; keep the hook silent.
  exit 0
fi

ar_add_context "UserPromptSubmit" "This is a ${LEVEL} complexity task (${PCT}%). Before committing to a solution, consider running the /confidence command with your current plan and follow its verdict."
exit 0
