#!/usr/bin/env bash
# agent-reflex (Antigravity) — post-edit syntax and bug check (two-phase).
#
# Antigravity's PostToolUse hook cannot inject context the model sees (its stdout
# is only {}; see antigravity-cli#808), and the payload omits the successful tool
# output. So this runs in two phases:
#   check   (PostToolUse): run the syntax + bug check on the edited file and
#           append findings to a pending file. The file is re-read from disk
#           (already written by the time PostToolUse fires).
#   deliver (PreInvocation): read the pending file and surface the findings to the
#           model via injectSteps, then clear it. Feedback is delayed by one model
#           invocation instead of arriving inline with the edit.
#
# Port of the OpenCode plugin's ctx.tool.hook("execute.after") hook.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

MODE="${1:-check}"
SEMANTIC_THRESHOLD="${AGENT_REFLEX_SEMANTIC_THRESHOLD:-0.75}"
CONTEXT_LINES="${AGENT_REFLEX_CONTEXT_LINES:-40}"
MAX_CHARS="${AGENT_REFLEX_MAX_CHARS:-8000}"

INPUT="$(cat)"
CONV="$(printf '%s' "$INPUT" | jq -r '.conversationId // empty' 2>/dev/null)"
PENDING="$STATE_DIR/pending-${CONV:-default}"

# ---- deliver phase: PreInvocation ----
if [ "$MODE" = "deliver" ]; then
  [ -s "$PENDING" ] || { echo '{}'; exit 0; }
  NOTES_TEXT="$(cat "$PENDING")"
  rm -f "$PENDING"
  jq -nc --arg t "$NOTES_TEXT" '{injectSteps:[{ephemeralMessage:$t}]}'
  exit 0
fi

# ---- check phase: PostToolUse ----
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.toolCall.name // empty' 2>/dev/null)"
FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.toolCall.args.TargetFile // .toolCall.args.FilePath // .toolCall.args.file_path // empty' 2>/dev/null)"
EDITED="$(printf '%s' "$INPUT" | jq -r '.toolCall.args.ReplacementContent // .toolCall.args.CodeContent // .toolCall.args.TargetContent // empty' 2>/dev/null)"

ar_log "check tool=${TOOL_NAME} file=${FILE_PATH}"

[ -n "$FILE_PATH" ] && [ -f "$FILE_PATH" ] || { echo '{}'; exit 0; }

# ---- syntax check (returns errors, empty when clean, "none" when no parser) ----
find_syntax_errors() {
  local file="$1" ext
  ext="${file##*.}"; ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  case "$ext" in
    ts|tsx|js|jsx|mjs|cjs)
      if command -v node >/dev/null 2>&1 && node -e "require.resolve('typescript')" >/dev/null 2>&1; then
        node - "$file" <<'NODE'
const ts = require('typescript'); const fs = require('fs');
const file = process.argv[2];
const res = ts.transpileModule(fs.readFileSync(file,'utf8'), {fileName:file, reportDiagnostics:true});
const out = (res.diagnostics||[]).map(d => {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  if (d.file && d.start !== undefined) { const {line} = d.file.getLineAndCharacterOfPosition(d.start); return `line ${line+1}: ${msg}`; }
  return msg;
});
if (out.length) console.log(out.join('\n'));
NODE
        return 0
      fi
      echo "none"; return 0 ;;
    json) node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$file" 2>&1 || true; return 0 ;;
    sh|bash) bash -n "$file" 2>&1 || true; return 0 ;;
    zsh) zsh -n "$file" 2>&1 || true; return 0 ;;
    py) python3 -m py_compile "$file" 2>&1 || true; return 0 ;;
    rb) ruby -c "$file" 2>&1 || true; return 0 ;;
    php) php -l "$file" 2>&1 || true; return 0 ;;
    pl) perl -c "$file" 2>&1 || true; return 0 ;;
    lua) luac -p "$file" 2>&1 || true; return 0 ;;
    go) gofmt -e "$file" 2>&1 >/dev/null || true; return 0 ;;
    *) echo "none"; return 0 ;;
  esac
}

excerpt_around_edit() {
  local content="$1" edited="$2"
  if [ -z "$edited" ]; then printf '%s' "$content" | cut -c1-"$MAX_CHARS"; return 0; fi
  local idx; idx="$(awk -v c="$content" -v e="$edited" 'BEGIN{print index(c,e)}')"
  if [ "$idx" = "0" ]; then printf '%s' "$content" | cut -c1-"$MAX_CHARS"; return 0; fi
  python3 - "$content" "$edited" "$CONTEXT_LINES" "$MAX_CHARS" <<'PY' 2>/dev/null || printf '%s' "$content" | cut -c1-"$MAX_CHARS"
import sys
content, edited, ctx, mx = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
i = content.find(edited)
lines = content.split("\n")
first = content[:i].count("\n")
last = first + edited.count("\n")
lo = max(0, first - ctx); hi = min(len(lines), last + ctx + 1)
print("\n".join(lines[lo:hi])[:mx], end="")
PY
}

ERRORS="$(find_syntax_errors "$FILE_PATH")"
NOTES=()

if [ "$ERRORS" != "none" ] && [ -n "$ERRORS" ]; then
  COUNT="$(printf '%s\n' "$ERRORS" | grep -c .)"
  NOTES+=("[Syntax check]: ${FILE_PATH} has ${COUNT} syntax error(s). Fix them before continuing:
$(printf '%s\n' "$ERRORS" | sed 's/^/- /')")
else
  LEVEL="$(cat "$STATE_DIR/level-${CONV:-default}" 2>/dev/null || echo "")"
  if [ "$LEVEL" = "medium" ] || [ "$LEVEL" = "high" ]; then
    CONTENT="$(cat "$FILE_PATH" 2>/dev/null || echo "")"
    EXCERPT="$(excerpt_around_edit "$CONTENT" "$EDITED")"
    STATE="Excerpt of edited file ${FILE_PATH}. It contains only the edited code plus ${CONTEXT_LINES} lines on each side, so code outside it is not shown:
${EXCERPT}"
    QUESTION="Does this code contain a bug that would prevent it from running or produce a wrong result? Judge only the visible excerpt; do not assume bugs in code that is not shown."
    BUG="$(ar_ask "$STATE" "$QUESTION")"
    if [ -n "$BUG" ]; then
      CORRECT="$(awk -v b="$BUG" 'BEGIN{printf "%.4f", 1-b}')"
      if awk -v c="$CORRECT" -v t="$SEMANTIC_THRESHOLD" 'BEGIN{exit !(c<t)}'; then
        PCT="$(awk -v c="$CORRECT" 'BEGIN{printf "%d", c*100}')"
        NOTES+=("[System One check]: The edit to ${FILE_PATH} is only ${PCT}% confident to be correct (threshold $(awk -v t="$SEMANTIC_THRESHOLD" 'BEGIN{printf "%d", t*100}')%). Review it before continuing.")
      fi
    fi
  fi
fi

if [ "${#NOTES[@]}" -eq 0 ]; then
  rm -f "$STATE_DIR/fail-${CONV:-default}-$(printf '%s' "$FILE_PATH" | tr '/ ' '__')" 2>/dev/null || true
  echo '{}'
  exit 0
fi

# Retry-once / then-ask-the-user escalation (per conversation+file).
FAIL_KEY="$STATE_DIR/fail-${CONV:-default}-$(printf '%s' "$FILE_PATH" | tr '/ ' '__')"
FAILS="$(cat "$FAIL_KEY" 2>/dev/null || echo 0)"
if [ "$FAILS" = "0" ]; then
  echo 1 > "$FAIL_KEY"
  NOTES+=("Retry once: fix the problem above, then edit the file again.")
else
  rm -f "$FAIL_KEY"
  NOTES+=("The check still fails after one retry. Stop and ask the user how to proceed before editing this file again.")
fi

# Queue the findings for the next PreInvocation to deliver.
{
  echo "[agent-reflex post-edit check] (surfaced after the edit because Antigravity's PostToolUse cannot inject context)"
  printf '%s\n\n' "${NOTES[@]}"
} >> "$PENDING"

echo '{}'
exit 0
