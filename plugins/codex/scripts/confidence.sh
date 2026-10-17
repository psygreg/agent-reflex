#!/usr/bin/env bash
# agent-reflex (Codex) — on-demand confidence check.
#
# Invoked by the /confidence skill. Reads the model's current line of thought
# from stdin, asks the System One classifier to score it, and prints a confidence
# percentage plus a CONTINUE/RESTART verdict. Port of the OpenCode plugin's
# systemone_check_confidence tool.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

THOUGHT="$(cat)"
if [ -z "$THOUGHT" ]; then
  echo "No thought provided. Pass your current reasoning on stdin."
  exit 0
fi

# Threshold by session complexity level (default simple). Claude Code hooks do
# not expose the active level to arbitrary skills, so read the session-scoped
# state file when present; fall back to the simple threshold.
LEVEL=""
for f in "$STATE_DIR"/level-*; do
  [ -f "$f" ] && LEVEL="$(cat "$f")"
done
THRESHOLD="$(awk -v l="$LEVEL" 'BEGIN{ if(l=="medium"||l=="high") print "0.85"; else print "0.75" }')"

STATE="AI line of thought:
${THOUGHT}"
QUESTION="Does this line of thought seem direct, correct and without hesitation or redundant loops?"

CONF="$(ar_ask "$STATE" "$QUESTION")"

if [ -z "$CONF" ]; then
  echo "System One confidence check unavailable. Continue with your current approach."
  exit 0
fi

PCT="$(awk -v c="$CONF" 'BEGIN{printf "%.1f", c*100}')"
THRESH_PCT="$(awk -v t="$THRESHOLD" 'BEGIN{printf "%d", t*100}')"
ar_log "confidence=${CONF} threshold=${THRESHOLD}"

if awk -v c="$CONF" -v t="$THRESHOLD" 'BEGIN{exit !(c<t)}'; then
  echo "Confidence ${PCT}% is below the ${THRESH_PCT}% threshold. Verdict: RESTART. Discard this line of thought and solve the problem again, focusing on the cleanest, most direct solution."
else
  echo "Confidence ${PCT}%. Verdict: CONTINUE."
fi
exit 0
