# agent-reflex for Hermes

Hermes port of the `agent-reflex` OpenCode plugin: a small System One decision
model runs alongside the agent to safeguard shell commands, double-check edits,
and let the model sanity-check its own reasoning.

This is a Hermes plugin (`plugin.yaml` + `classifier.py` + `syntax.py` +
`__init__.py`). Install it into `~/.hermes/plugins/agent-reflex/`, enable it under
`plugins.enabled` in `~/.hermes/config.yaml` (the installer does both), and create
`agent-reflex.jsonc` in the plugin root with your classifier settings.

## What it does

- **`safe_run` command wrapper** (the guardrail): a shell-execution tool that
  scores a command for damage potential with the classifier and either blocks it
  (returns an error) or runs it by delegating to Hermes's built-in `terminal` tool.
  Use `safe_run` instead of the plain `terminal` tool to get commands checked
  before they execute. See "Why a wrapper" below.
- **Post-edit double-check** (`post_tool_call`): after a file edit (`patch`,
  `write_file`, …) it runs a language parser on the file and, on medium/high
  complexity tasks, a System One bug check on the edited text. Findings are
  injected back to the agent to fix.
- **Complexity classification** (`pre_llm_call`): scores each prompt
  *simple*/*medium*/*high*, stores it for the session, and on medium/high injects
  a note suggesting a confidence check. This is the cleanest of all the ports —
  `pre_llm_call` can return context to append to the turn.
- **Confidence check** (`confidence_check` tool and `/confidence` command): scores
  the model's current line of thought and returns CONTINUE or RESTART.

## Why a wrapper (the Hermes guardrail compromise)

The shell ports (Claude Code, Codex) block a dangerous command in a `PreToolUse`
hook. Hermes's `pre_tool_call` hook **cannot block** — its return value is ignored
(it is a fire-and-forget observer, good for warnings only). To get a real block,
this port delivers the guardrail as a command-execution wrapper tool:

- The model calls `safe_run` with a command. The wrapper scores it, and:
  - score above the threshold → returns `{"error": "[GUARDRAIL BLOCKED] …"}` and
    never runs it (a real block);
  - otherwise → delegates to the built-in `terminal` tool via `ctx.dispatch_tool`,
    so approvals, credentials, and task context are preserved.
- A `pre_tool_call` hook prints a warning whenever a command runs through the
  plain `terminal` tool instead of `safe_run`, nudging the model toward the
  guarded path.

The compromise: enforcement depends on the model choosing `safe_run`. A model
that calls `terminal` directly bypasses the guardrail (it only gets a warning).
For hard enforcement, disable the `terminal` toolset so `safe_run` is the only
command path, or use Hermes's `terminal` backend sandbox (`docker`/`ssh`) as the
real boundary. The guardrail is best-effort by design, matching the plugin's
"never block work when the classifier is down" fail-open behavior.

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
open: commands run, edits pass, and the confidence check reports the classifier is
unavailable.

## Hermes-only compromises (features not portable here)

The OpenCode plugin rewrites the model request itself (`http.request`) and prunes
history (`context`). Hermes exposes neither, so:

- **Per-request dynamic effort and `maxTokens`.** Impossible. No Hermes hook can
  touch the request or set a per-request token cap. The classifier still classifies
  complexity, but only to drive the confidence suggestion and post-edit check depth.
- **Custom history pruning.** Only partial. `pre_llm_call` receives
  `conversation_history`, so the classifier could read it — but the hook can only
  return `{"context": …}` to append text; it cannot return a pruned message list.
  So Hermes can see history but cannot drop tokens. Real pruning is impossible.
- **Compaction guidance.** No compaction hook exists; Hermes does context
  compression internally and does not expose what it keeps. Weaker than Claude
  Code's `PreCompact custom_instructions`, comparable to Codex.

If you need those features, use the OpenCode plugin (`plugins/opencode`).

## Layout

```
plugin.yaml        manifest (name, version, description)
classifier.py      config loader (agent-reflex.jsonc) + System One client
syntax.py          language parsers + edit excerpt (post-edit check)
__init__.py        register(ctx): safe_run tool, hooks, confidence tool/command
```
