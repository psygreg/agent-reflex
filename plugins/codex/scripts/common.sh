#!/usr/bin/env bash
# agent-reflex (Codex) — shared library. Sourced by each hook script.
#
# Ported from the OpenCode plugin plugins/opencode/index.ts. The classifier is a
# System One decision model asked through the System One shape
# (model, state, questions -> answers.q.noul) at <baseURL>/systemone. Configuration
# is read from ${PLUGIN_ROOT}/agent-reflex.jsonc (same option names as the
# OpenCode plugin: provider/baseURL/model/apiKey/fallbackModel/debugLog).

set -uo pipefail

# Codex sets PLUGIN_ROOT (and CLAUDE_PLUGIN_ROOT for compatibility) to the
# installed plugin root. Fall back to the script's parent directory.
PLUGIN_ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
CONFIG_FILE="${PLUGIN_ROOT}/agent-reflex.jsonc"
STATE_DIR="${AGENT_REFLEX_STATE_DIR:-${TMPDIR:-/tmp}/agent-reflex-$$}"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# ---- config ----
# Strips // line comments and trailing commas so jq can parse JSONC, then reads
# the option. Empty when unset.
ar_config() {
  local key="$1"
  [ -f "$CONFIG_FILE" ] || { echo ""; return 0; }
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CONFIG_FILE" "$key" <<'PY' 2>/dev/null || echo ""
import json, re, sys
path, key = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
# Strip // comments only when // begins a token (not inside a URL like https://).
s = re.sub(r'(^|[^:\"])//.*', r'\1', s, flags=re.M)
# Strip trailing commas before } or ].
s = re.sub(r',(\s*[}\]])', r'\1', s)
try:
    v = json.loads(s).get(key)
    print("" if v is None else v)
except Exception:
    print("")
PY
  else
    # Minimal fallback: no comment support, just trailing commas.
    sed -E -e 's/,([[:space:]]*[}\]])/\1/g' "$CONFIG_FILE" 2>/dev/null \
      | jq -r --arg k "$key" '.[$k] // empty' 2>/dev/null || echo ""
  fi
}

# Resolves ${env:NAME} placeholders (the OpenCode convention) to the environment.
ar_resolve_env() {
  local v="$1" name
  if [[ "$v" =~ ^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$ ]]; then
    name="${BASH_REMATCH[1]}"
    echo "${!name}"
  else
    echo "$v"
  fi
}

ar_base_url() {
  local preset base provider
  base="$(ar_config baseURL)"
  if [ -n "$base" ]; then echo "${base%/}"; return 0; fi
  provider="$(ar_config provider)"
  case "$provider" in
    llamacpp)  echo "http://127.0.0.1:8080/v1" ;;
    ollama)    echo "http://127.0.0.1:11434/v1" ;;
    lmstudio)  echo "http://127.0.0.1:1234/v1" ;;
    typesafe)  echo "https://api.typesafe.ai/v1" ;;
    openrouter) echo "https://openrouter.ai/api/v1" ;;
    vercel)    echo "https://ai-gateway.vercel.sh/typesafe/v1" ;;
    opencode)  echo "https://opencode.ai/zen/v1" ;;
    *)         echo "" ;;
  esac
}

# ---- classifier ----
# ask_system_one STATE QUESTION MODEL -> prints P(YES) in [0,1] or nothing on failure.
ar_ask_model() {
  local state="$1" question="$2" model="$3" base key body
  base="$(ar_base_url)"; [ -n "$base" ] || return 1
  key="$(ar_resolve_env "$(ar_config apiKey)")"

  body="$(jq -nc --arg m "$model" --arg s "$state" --arg q "$question" \
    '{model:$m, state:$s, questions:{q:{type:"noul", instructions:$q}}}')"

  local hdr=(-H "Content-Type: application/json")
  [ -n "$key" ] && hdr+=(-H "Authorization: Bearer ${key}")

  local resp
  resp="$(curl -sS --max-time "${AGENT_REFLEX_TIMEOUT:-20}" "${hdr[@]}" \
    -d "$body" "${base}/systemone" 2>/dev/null)" || return 1

  echo "$resp" | jq -r '.answers.q.noul // empty' 2>/dev/null \
    | awk '/^[0-9]*\.?[0-9]+$/ {v=$1; if(v<0)v=0; if(v>1)v=1; print v; found=1} END{exit !found}'
}

# ask_system_one STATE QUESTION -> falls back to fallbackModel when the primary rejects.
ar_ask() {
  local state="$1" question="$2" model fallback val
  model="$(ar_config model)"
  [ -n "$model" ] || return 1

  val="$(ar_ask_model "$state" "$question" "$model")"
  if [ -n "$val" ]; then echo "$val"; return 0; fi

  fallback="$(ar_config fallbackModel)"
  if [ -n "$fallback" ] && [ "$fallback" != "$model" ]; then
    ar_log "Classifier model \"$model\" unavailable, retrying with \"$fallback\"."
    val="$(ar_ask_model "$state" "$question" "$fallback")"
    if [ -n "$val" ]; then echo "$val"; return 0; fi
  fi
  return 1
}

# ---- logging ----
ar_log() {
  local dbg; dbg="$(ar_config debugLog)"
  [ -n "$dbg" ] || return 0
  printf '%s %s\n' "$(date -Iseconds)" "$1" >> "$dbg" 2>/dev/null || true
}

# ---- JSON helpers ----
ar_json_string() { jq -Rs . <<<"$1"; }

# Emits hookSpecificOutput.additionalContext for an event (the supported path).
ar_add_context() {
  local event="$1" text="$2"
  jq -nc --arg e "$event" --arg t "$text" \
    '{hookSpecificOutput:{hookEventName:$e, additionalContext:$t}}'
}
