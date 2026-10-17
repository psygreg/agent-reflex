# agent-reflex for Qwen Code

Qwen Code port of the `agent-reflex` OpenCode plugin: a small System One decision
model runs alongside the agent to safeguard shell commands, double-check edits,
and let the model sanity-check its own reasoning.

This is a Qwen Code extension (`qwen-extension.json` + `hooks/` + `scripts/` + a
`confidence` skill). Install it with `qwen extensions install <dir>` (or copy it to
`~/.qwen/extensions/agent-reflex/`), and create `agent-reflex.jsonc` in the plugin
root with your classifier settings.

## What it does

- **Shell guardrail** (`PreToolUse` on `run_shell_command`): scores a command for
  damage potential and denies it (`permissionDecision: "deny"`) when the score
  exceeds the threshold. A hard block, like Claude Code and Codex.
- **Post-edit double-check** (`PostToolUse` on `write_file`/`edit`/`notebook_edit`):
  runs a language parser on the edited file and, on medium/high complexity tasks, a
  System One bug check on the edited text. Findings are injected as tool-result
  context so the agent can fix problems. Qwen's `write_file` uses `file_path` +
  `content` and `edit` uses `file_path` + `old_string` + `new_string`; the hook
  reads both shapes.
- **Complexity classification** (`UserPromptSubmit`): scores each prompt
  *simple*/*medium*/*high* and, on medium/high, injects a note suggesting a
  confidence check.
- **Compaction guidance with fact extraction** (`PreCompact`): reads the
  conversation transcript (`transcript_path`), extracts the facts it established
  (goal, architecture, decisions, files, verification, and the other digest
  buckets) with the classifier, and steers Qwen Code's own summarizer via
  `custom_instructions` to preserve them. Falls back to enriched static guidance
  when the transcript is unavailable. Qwen Code supports the same `PreCompact`
  `custom_instructions` lever as Claude Code. Guidance only — it cannot choose what
  to keep, just what the summary preserves.
- **Confidence check** (`confidence` skill, invocable as `/agent-reflex:confidence`):
  scores the model's current line of thought and returns CONTINUE or RESTART.

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

When `model` or `baseURL` is missing, the hooks that need the classifier fail
open: the shell command runs, the edit passes, and the confidence check reports
the classifier is unavailable.

## Qwen Code-only compromises (features not portable here)

The OpenCode plugin uses the `http.request` and `context` hooks to rewrite the
model request itself. Qwen Code exposes neither, so two features stay OpenCode-only
(same as every non-OpenCode port):

- **Per-request dynamic effort and `maxTokens`.** No Qwen Code hook can rewrite
  the request or set a per-request token cap. The classifier still classifies
  complexity, but only to drive the confidence suggestion and post-edit check depth.
- **Decision-driven history compaction.** Hooks can inject context but cannot
  return a rewritten message list, so this plugin cannot select what to keep. Qwen
  Code owns compaction (`/compress`, `PreCompact`); the plugin approximates the
  digest step instead — `PreCompact` reads the transcript, extracts the same fact
  buckets, and biases the summary to preserve them.

If you need those features, use the OpenCode plugin (`plugins/opencode`).

## Layout

```
qwen-extension.json       manifest (name, version, description)
hooks/hooks.json          hook registration (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact)
scripts/common.sh         config + System One classifier client + helpers
scripts/guard.sh          shell guardrail (PreToolUse, denies dangerous commands)
scripts/check.sh          post-edit syntax + bug check (PostToolUse)
scripts/classify.sh       complexity classification (UserPromptSubmit)
scripts/compact.sh        compaction guidance (PreCompact custom_instructions)
scripts/confidence.sh     on-demand confidence check (skill)
skills/confidence/SKILL.md  the confidence skill
```
