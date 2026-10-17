#!/usr/bin/env bash
# agent-reflex (Antigravity) — complexity classification.
#
# PreInvocation hook. Scores the current user prompt with the System One
# classifier, stores the level for the conversation (used by the post-edit check
# and the confidence check), and for medium/high injects a note suggesting a
# confidence check via injectSteps. Port of the OpenCode plugin's context-hook
# complexity stage. Antigravity has no UserPromptSubmit hook and PreInvocation
# carries no prompt field, so the latest user message is read from the transcript.
# The OpenCode plugin additionally sets event.options.maxTokens per level; no
# Antigravity hook sets the per-request token cap, so that stays OpenCode-only.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

INPUT="$(cat)"
CONV="$(printf '%s' "$INPUT" | jq -r '.conversationId // empty' 2>/dev/null)"
TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcriptPath // empty' 2>/dev/null)"

# Latest user message from the transcript (one JSON object per line). Falls back
# to empty when there is no transcript yet (first turn) — then skip classification.
PROMPT=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  PROMPT="$(jq -rs '
    [ .[] | select(.role == "user" or .type == "user") | (.content // .text // empty) ]
    | last // "" | tostring
  ' "$TRANSCRIPT" 2>/dev/null | head -c 20000)"
fi

[ -n "$PROMPT" ] || { echo '{}'; exit 0; }

classify_level() {
  awk -v s="$1" 'BEGIN{ if(s>0.80) print "high"; else if(s>0.50) print "medium"; else print "simple" }'
}

STATE="User prompt: ${PROMPT}"
QUESTION="Does this prompt require deep logic thinking, complex algorithms or mathematical/concurrence bugs?"

SCORE="$(ar_ask "$STATE" "$QUESTION")"
[ -n "$SCORE" ] || { echo '{}'; exit 0; }  # classifier unavailable -> skip tuning

LEVEL="$(classify_level "$SCORE")"
echo "$LEVEL" > "$STATE_DIR/level-${CONV:-default}" 2>/dev/null || true
ar_log "classify score=${SCORE} level=${LEVEL}"

PCT="$(awk -v s="$SCORE" 'BEGIN{printf "%d", s*100}')"

if [ "$LEVEL" = "simple" ]; then
  echo '{}'  # no injection for simple tasks
  exit 0
fi

jq -nc --arg m "This is a ${LEVEL} complexity task (${PCT}%). Before committing to a solution, consider running the confidence check with your current plan and follow its verdict." \
  '{injectSteps:[{ephemeralMessage:$m}]}'
exit 0
