# agent-reflex for Claude Code

Claude Code port of the `agent-reflex` OpenCode plugin: a small System One
decision model runs alongside the agent to safeguard shell commands, double-check
edits, and let the model sanity-check its own reasoning.

This is a Claude Code plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json` +
`scripts/` + a `confidence` skill). Install it from a marketplace or load the
directory directly. After installing, create `agent-reflex.jsonc` next to the
plugin (in the plugin root) with your classifier settings.

## What it does

- **Shell guardrail** (`PreToolUse` on Bash): scores a command for damage
  potential and denies it when the score exceeds the threshold.
- **Post-edit double-check** (`PostToolUse` on Edit|Write): runs a language
  parser on the edited file and, on medium/high complexity tasks, a System One
  bug check on the lines around the edit. Failures are fed back to the agent to
  fix; a second failure on the same file asks the user how to proceed.
- **Complexity classification** (`UserPromptSubmit`): scores each prompt
  *simple*/*medium*/*high* and, on medium/high, suggests a confidence check.
- **Compaction guidance** (`PreCompact`): steers Claude Code's own compaction to
  keep architectural requirements, scope, and rules.
- **Confidence check** (`/confidence` skill): scores the model's current line of
  thought and returns CONTINUE or RESTART.

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

## OpenCode-only features (not portable to Claude Code)

The OpenCode plugin uses the `http.request` and `context` hooks to rewrite the
model request itself. Claude Code does not expose those, so two features have no
equivalent here and are intentionally omitted:

- **Per-request dynamic effort and `maxTokens`.** The OpenCode plugin rewrites
  every request's effort/thinking fields and token cap based on the classified
  complexity. Claude Code sets the effort level once per session (via `/effort`,
  `CLAUDE_CODE_EFFORT_LEVEL`, or the model picker); hooks cannot change it
  mid-session or per request (model/effort changes require the manual `/model`
  picker — see claude-code issue #30806). The classifier still classifies
  complexity here, but only to drive the confidence suggestion and the post-edit
  check depth, not the request.
- **Custom history pruning.** The OpenCode plugin prunes old messages from the
  request before each model call. Claude Code owns compaction and does not let a
  hook rewrite the conversation history, so this plugin can only bias compaction
  via `PreCompact` `custom_instructions`.

If you need those two features, use the OpenCode plugin (`plugins/opencode`).

## Layout

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             hook registration (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact)
scripts/common.sh            config + System One classifier client + helpers
scripts/guard.sh             shell guardrail (PreToolUse)
scripts/check.sh             post-edit syntax + bug check (PostToolUse)
scripts/classify.sh          complexity classification (UserPromptSubmit)
scripts/compact.sh           compaction guidance (PreCompact)
scripts/confidence.sh        on-demand confidence check (skill)
skills/confidence/SKILL.md   the /confidence command
```
