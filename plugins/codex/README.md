# agent-reflex for Codex

Codex port of the `agent-reflex` OpenCode plugin: a small System One decision
model runs alongside the agent to safeguard shell commands, double-check edits,
and let the model sanity-check its own reasoning.

This is a Codex plugin (`.codex-plugin/plugin.json` + `hooks/hooks.json` +
`scripts/` + a `confidence` skill). Install it from a plugin source or load the
directory. After installing, create `agent-reflex.jsonc` in the plugin root with
your classifier settings, and trust the hooks via `/hooks` in the Codex CLI
(Codex skips non-managed hooks until reviewed).

## What it does

- **Shell guardrail** (`PreToolUse` on Bash): scores a command for damage
  potential and denies it when the score exceeds the threshold.
- **Post-edit double-check** (`PostToolUse` on Edit|Write/`apply_patch`): runs a
  language parser on each edited file and, on medium/high complexity tasks, a
  System One bug check on the added lines. Codex edits files through
  `apply_patch`, so the hook parses the edited paths from the V4A patch.
  Failures are fed back to the agent to fix; a second failure on the same file
  asks the user how to proceed.
- **Complexity classification** (`UserPromptSubmit`): scores each prompt
  *simple*/*medium*/*high* and, on medium/high, suggests a confidence check.
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

## Codex-only compromises (features not portable here)

The OpenCode plugin uses the `http.request` and `context` hooks to rewrite the
model request itself, and Claude Code adds a `PreCompact` `custom_instructions`
lever. Codex exposes neither, so three features are reduced or omitted:

- **Per-request dynamic effort and `maxTokens`.** The OpenCode plugin rewrites
  every request's effort/thinking fields and token cap from the classified
  complexity. Codex has no hook to touch the request or set a per-request token
  cap; `model_reasoning_effort` is a session-level config value. The classifier
  still classifies complexity here, but only to drive the confidence suggestion
  and the post-edit check depth. (Same limitation as Claude Code.)
- **Custom history pruning.** The OpenCode plugin prunes old messages before each
  model call. Codex owns compaction and offers no hook to rewrite history or steer
  what the summary keeps.
- **Compaction guidance.** Claude Code can bias compaction via `PreCompact`
  `custom_instructions`. Codex's `PreCompact` output is only
  `continue`/`stopReason`/`systemMessage`/`suppressOutput` — there is no way to
  tell the summarizer what to preserve. The only lever is `continue:false` to
  cancel compaction, which is rarely desirable. So this port's `PreCompact` hook
  is inert by default (it just logs the trigger) and, with
  `AGENT_REFLEX_COMPACT_NOTE=1`, surfaces a preserve-requirements reminder as a
  `systemMessage`. This is the weakest of the three ports for compaction.

If you need those features, use the OpenCode plugin (`plugins/opencode`).

## Codex hook notes

- Hooks are experimental in Codex and require trust review: run `/hooks` in the
  CLI to review and trust the bundled hook definitions before they run. For
  automation, `--dangerously-bypass-hook-trust` skips persisted trust.
- File edits arrive via `apply_patch`, so the post-edit check parses the V4A
  patch (`*** Update File:` / `*** Add File:` headers) to find edited paths. A
  direct `tool_input.file_path` is used when a tool supplies one.
- Matchers use Codex tool names: `Bash`, and `Edit|Write|apply_patch` for edits.

## Layout

```
.codex-plugin/plugin.json   manifest (declares ./hooks/hooks.json)
hooks/hooks.json             hook registration (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact)
scripts/common.sh            config + System One classifier client + helpers
scripts/guard.sh             shell guardrail (PreToolUse)
scripts/check.sh             post-edit syntax + bug check (PostToolUse, apply_patch-aware)
scripts/classify.sh          complexity classification (UserPromptSubmit)
scripts/compact.sh           compaction trigger logger (PreCompact)
scripts/confidence.sh        on-demand confidence check (skill)
skills/confidence/SKILL.md   the /confidence command
```
