# agent-reflex for Antigravity

Antigravity port of the `agent-reflex` OpenCode plugin: a small System One decision
model runs alongside the agent to safeguard shell commands, double-check edits, and
let the model sanity-check its own reasoning.

This is an Antigravity plugin (`plugin.json` + `hooks/hooks.json` + `scripts/` + a
`confidence` skill). Install it into the global plugin dir
(`~/.gemini/config/plugins/agent-reflex/`) or the workspace `.agents/plugins/`, and
create `agent-reflex.jsonc` in the plugin root with your classifier settings.

## What it does

- **Shell guardrail** (`PreToolUse` on `run_command`): scores a command for damage
  potential and denies it (`decision: "deny"`, a hard block) when the score exceeds
  the threshold. On classifier failure the command is allowed.
- **Post-edit double-check** (`PostToolUse` on `write_to_file` /
  `replace_file_content` / `multi_replace_file_content`): runs a language parser on
  the edited file and, on medium/high complexity tasks, a System One bug check on
  the edited text. Findings are delivered to the model on the next invocation (see
  "The one-turn delay" below).
- **Complexity classification** (`PreInvocation`): scores the current prompt
  *simple*/*medium*/*high* (read from the transcript) and, on medium/high, injects a
  note suggesting a confidence check.
- **Confidence check** (`confidence` skill): scores the model's current line of
  thought and returns CONTINUE or RESTART.

## The one-turn delay (the Antigravity post-edit compromise)

Antigravity's `PostToolUse` hook **cannot inject context the model sees** — its
stdout contract is an empty `{}`, and its payload omits the successful tool output
(an open upstream request: antigravity-cli#808). So the post-edit check runs in two
phases instead of feeding findings back inline with the edit:

1. `PostToolUse` runs the syntax/bug check and appends findings to a per-conversation
   pending file (the edited file is re-read from disk, since the payload has no
   output).
2. `PreInvocation` (the next model call) delivers those findings via `injectSteps`
   and clears the file.

This means the model sees a syntax error or bug warning one turn after the edit
rather than as part of the edit's tool result. It is the closest approximation
available until Antigravity adds `PostToolUse` context injection. Everything else
(guardrail, classification, confidence) is unaffected.

## Configuration

Create `agent-reflex.jsonc` in the plugin root. Option names match the OpenCode
plugin:

```jsonc
{
  "provider": "llamacpp",          // llamacpp | ollama | lmstudio | typesafe | openrouter | vercel | opencode | custom
  "baseURL": "http://127.0.0.1:8080/v1",  // optional; overrides the preset
  "model": "liquid-d1",            // REQUIRED classifier model
  "apiKey": "{env:MY_API_KEY}",    // optional; {env:NAME} is resolved
  "fallbackModel": "jev-1.13",     // optional; retried when the primary rejects
  "debugLog": "/tmp/agent-reflex.log"  // optional
}
```

When `model` or `baseURL` is missing, the hooks that need the classifier fail open:
the shell command runs, the edit passes, and the confidence check reports the
classifier is unavailable.

## Antigravity-only compromises (features not portable here)

The OpenCode plugin rewrites the model request itself (`http.request`) and prunes
history (`context`). Antigravity exposes neither, so:

- **Per-request dynamic effort and `maxTokens`.** Impossible. No Antigravity hook
  can touch the request or set a per-request token cap. The classifier still
  classifies complexity, but only to drive the confidence suggestion and post-edit
  check depth.
- **Custom history pruning.** Impossible. Hooks can inject context (`injectSteps`)
  but cannot return a pruned message list. Antigravity owns compaction; the plugin
  can only add a preserve-requirements reminder, not drop messages.
- **Compaction steering.** No `PreCompact` `custom_instructions` lever exists (that
  is Claude Code/Qwen Code). The `compact.sh` hook is inert by default; set
  `AGENT_REFLEX_COMPACT_NOTE=1` to queue a preserve-requirements reminder alongside
  edit findings. Weaker than Claude Code/Qwen Code, comparable to Codex.

If you need those features, use the OpenCode plugin (`plugins/opencode`).

## Layout

```
plugin.json        manifest (name, description, schema)
hooks/hooks.json   hook registration (PreToolUse, PostToolUse, PreInvocation x2, PostInvocation)
scripts/common.sh  config + System One classifier client + helpers
scripts/guard.sh   shell guardrail (PreToolUse, decision: deny)
scripts/check.sh   post-edit syntax + bug check (PostToolUse check / PreInvocation deliver)
scripts/classify.sh  complexity classification (PreInvocation)
scripts/compact.sh   compaction note (PostInvocation, inert by default)
scripts/confidence.sh  on-demand confidence check (skill)
skills/confidence/SKILL.md  the confidence skill
```
