#!/usr/bin/env bash
# agent-reflex (Qwen Code) — compaction guidance.
#
# PreCompact hook (matcher auto|manual). Qwen Code owns compaction and does not
# expose the message list to rewrite, so the plugin's decision-driven compaction
# (the OpenCode context hook) cannot drop or reorder messages here. But PreCompact
# receives transcript_path (the conversation's JSONL), so the classifier CAN read the
# history, extract the facts it established (the same DIGEST_BUCKETS extraction as the
# OpenCode port), and steer Qwen Code's summarizer via custom_instructions to keep
# those facts. This is the documented Qwen Code approximation of HOOK 1a: it guides
# what the summary preserves rather than choosing what to keep. Fails open to enriched
# static guidance when the transcript is missing/unreadable (transcript_path is written
# asynchronously and can be empty on some versions).

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

INPUT="$(cat)"
TRIGGER="$(printf '%s' "$INPUT" | jq -r '.trigger // empty' 2>/dev/null)"
TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"
ar_log "compact trigger=${TRIGGER:-unknown} transcript=${TRANSCRIPT:-none}"

# Static guidance (also the fallback when there is no transcript to extract from):
# mirrors the 11 digest buckets so an agent-side summary preserves the same kinds of
# fact the other ports extract explicitly.
STATIC_GUIDANCE="When summarizing, preserve these facts from the conversation if present: the overall task goal; architectural structure and chosen design; requirements and scope; named constraints, rules, and standards; defined or changed APIs/data shapes; decisions and their rationale; specific files or modules created or changed; commands to build/test/lint/run and how correctness was verified; prior findings, bug causes, and established facts; environment/config details (versions, paths, ports, env vars); and open questions, TODOs, and next steps. Keep tool call/result pairings intact. Drop redundant conversational turns."

# Extract the recent tail of the transcript into "ROLE: text" lines. Claude Code
# transcripts are JSONL; a message line has .message.role and .message.content (an
# array of {type:"text",text} parts, or a bare string). Bounded to the last 40
# entries and 12000 chars so the classifier call stays small.
extract_tail() {
  [ -f "$TRANSCRIPT" ] || return 1
  tail -n 40 "$TRANSCRIPT" 2>/dev/null | jq -r '
    select(type == "object") |
    (.message.role // .type // "unknown") as $role |
    (.message.content // .content // "") as $c |
    (if ($c | type) == "string" then $c
     elif ($c | type) == "array" then [$c[] | (.text // .content // empty)] | join(" ")
     else "" end) as $text |
    select(($text | length) > 0) |
    "[" + ($role | ascii_upcase) + "]: " + $text
  ' 2>/dev/null | tail -c 12000
}

# DIGEST_BUCKETS: "key<TAB>description<TAB>keyword,keyword,...". Mirrors the OpenCode
# port so all agents extract the same kinds of fact.
BUCKETS=(
  $'goal\tThe overall task goal, objective, or problem being solved\tgoal,objective,task is,we need to,trying to,aim,problem is'
  $'architecture\tArchitectural structure, module boundaries, or a chosen design/approach\tarchitect,design,structure,module,component,pattern,layer,service,pipeline'
  $'requirements\tFunctional or non-functional requirements, scope, or acceptance criteria\trequirement,must,should,needs to,scope,acceptance,criteria,expected'
  $'constraints\tNamed constraints, rules, standards, or must/must-not decisions to honor\tconstraint,rule,standard,must not,do not,never,policy,convention,limit'
  $'interfaces\tDefined or changed APIs, data shapes, schemas, contracts, or key signatures\tapi,interface,schema,contract,signature,function,type,endpoint,param,returns'
  $'decisions\tA decision that was made and its rationale\tdecided,decision,chose,we will use,going with,instead of,because,rationale,tradeoff'
  $'files\tSpecific files or modules that were created, changed, or are central to the work\tfile,folder,directory,path,module,created,edited,added,renamed,.ts,.js,.py,.json,.md'
  $'verification\tCommands to build/test/lint/run, or how correctness was verified\ttest,run,build,lint,command,npm,bun,pytest,verify,check,passing,failing,suite'
  $'state\tPrior findings, bug causes, error messages, or facts established about the code\tbug,error,issue,cause,found,because,fails,broken,root cause,exception,traceback'
  $'environment\tEnvironment or configuration details — versions, paths, ports, env vars, dependencies\tversion,config,environment,port,env,dependency,install,path,node,python,docker'
  $'pending\tOpen questions, TODOs, or next steps agreed but not yet completed\ttodo,next,later,pending,open question,remaining,still need,follow up,unresolved'
)

# Build the batched choice questions: for each bucket, pick the single most
# representative matching sentence from the tail (up to 6 candidates), or "none".
build_questions() {
  local tail_text="$1"
  printf '%s' "$tail_text" | jq -Rs . >/dev/null 2>&1 || { echo "{}"; return 1; }

  # Split the tail into sentences, one per line, via jq.
  local sentences
  sentences="$(printf '%s' "$tail_text" | jq -Rs 'split("\n") | map(select(length > 20 and length < 400)) | .[:80]' 2>/dev/null)"

  local questions="{}"
  local entry key desc kw
  for entry in "${BUCKETS[@]}"; do
    IFS=$'\t' read -r key desc kw <<<"$entry"
    # Candidate sentences matching any keyword (case-insensitive), up to 6.
    local matches
    matches="$(jq -nc --argjson s "$sentences" --arg kw "$kw" '
      ($kw | split(",")) as $words |
      [$s[] | select(. as $x | any($words[]; ($x | ascii_downcase) | contains(.)))] | .[:6]
    ' 2>/dev/null)"
    local count
    count="$(printf '%s' "$matches" | jq 'length' 2>/dev/null || echo 0)"
    [ "${count:-0}" -gt 0 ] || continue

    # criteria: {v0: sentence, ..., none: "..."}
    local criteria
    criteria="$(printf '%s' "$matches" | jq -c 'to_entries | map({("v" + (.key|tostring)): .value}) | add + {none: "None of these capture it."}' 2>/dev/null)"
    [ -n "$criteria" ] || continue

    questions="$(jq -nc --argjson q "$questions" --arg k "$key" --arg d "$desc" --argjson c "$criteria" \
      '$q + {($k): {instructions: ("From this earlier conversation, which statement best captures " + $d + "? Pick the single most representative one, or \"none\"."), criteria: $c}}')"
  done
  printf '%s' "$questions"
}

INSTRUCTIONS="$STATIC_GUIDANCE"
TAIL="$(extract_tail || true)"
if [ -n "${TAIL:-}" ]; then
  QUESTIONS="$(build_questions "$TAIL")"
  if [ -n "$QUESTIONS" ] && [ "$QUESTIONS" != "{}" ]; then
    ANSWERS="$(ar_ask_choice_many "$TAIL" "$QUESTIONS")"
    [ -n "${ANSWERS:-}" ] || ANSWERS="{}"
    # Resolve each chosen key (e.g. "v2") back to its sentence via the question's own
    # criteria, and render one "- bucket: sentence" line per extracted fact.
    LINES="$(jq -nr --argjson q "$QUESTIONS" --argjson a "$ANSWERS" '
      ($a | to_entries | map(select(.value != "none"))) as $picks |
      [$picks[] | .key as $k | .value as $v |
        (if ($v | test("^v[0-9]+$")) then ($q[$k].criteria[$v] // empty) else empty end) as $sentence |
        select(($sentence | length) > 0) |
        "- " + $k + ": " + $sentence
      ] | join("\n")
    ' 2>/dev/null)"
    if [ -n "${LINES:-}" ]; then
      INSTRUCTIONS="$(printf 'When summarizing, you MUST preserve these specific facts established earlier in this conversation:\n%s\n\nAlso keep tool call/result pairings intact and drop redundant conversational turns.' "$LINES")"
      ar_log "compact: extracted facts from transcript"
    fi
  fi
fi

jq -nc --arg i "$INSTRUCTIONS" '{
  hookSpecificOutput: {
    hookEventName: "PreCompact",
    custom_instructions: $i
  }
}'
exit 0
