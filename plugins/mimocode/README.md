# agent-reflex for MiMo Code

MiMo Code port of the `agent-reflex` OpenCode plugin: a small System One decision
model runs alongside the agent to safeguard shell commands, double-check edits, cap
tokens per task, prune history, and let the model sanity-check its own reasoning.

MiMo Code is Xiaomi's own agent, and it is **OpenCode-derived** — `@mimo-ai/plugin`
is nearly identical to `@opencode-ai/plugin`. So this port is the lowest-effort of the
set, and it is the **second** (after Pi) where the two features every shell-based port
lacks actually work: custom history pruning and per-request `maxTokens`. Install the
hook files into your MiMo Code hooks dir and create `agent-reflex.jsonc` alongside
them with your classifier settings.

## What it does

- **Shell guardrail** (`tool.execute.before`): scores a command for damage potential
  and blocks it (`output.cancel = true`) before it runs. A real block.
- **Post-edit double-check** (`tool.execute.after`): runs a language parser on the
  edited file and, on medium/high complexity, a System One bug check on the edited
  text. Findings are appended to the tool result (`output.output`) — inline, unlike
  Antigravity's one-turn delay.
- **Complexity classification** (`experimental.chat.system.transform`): scores each
  prompt *simple*/*medium*/*high*, stores the level for the session, and on
  medium/high adds a note suggesting a confidence check to the system prompt.
- **Per-request `maxTokens`** (`chat.params`): sets the generated-token cap per level
  (simple 8192 / medium 65536 / high 131072), matching the plugin's caps.
- **Custom history pruning** (`experimental.chat.messages.transform`, opt-in): when
  the history grows long, scores each old message and drops the redundant ones,
  preserving structural (tool call/result) messages and the recent tail.
- **Compaction guidance** (`experimental.session.compacting`): steers the compaction
  summary to keep architectural requirements, scope, and rules.
- **Confidence check** (`confidence_check` custom tool): scores the model's current
  line of thought and returns CONTINUE or RESTART.

## The one caveat: effort is `maxTokens`-only

MiMo Code's `chat.params` hook exposes `temperature`, `topP`, and `maxOutputTokens` —
but **not** `reasoning_effort` or `thinking`. MiMo's own reasoning knob is
`reasoning.effort` on the wire (`none`/`low`/`medium`/`high`), which is not reachable
from hooks. So on MiMo Code the plugin's "dynamic effort" feature is the **token cap
only**; it cannot change how hard the model thinks. (Pi, by contrast, exposes
`setThinkingLevel()` and does map effort properly.) The system-prompt confidence hint
is the only soft nudge toward more careful reasoning. This is a MiMo Code limitation,
not a plugin one.

## Configuration

Create `agent-reflex.jsonc` next to the hook files. Option names match the OpenCode
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

When `model` or `baseURL` is missing, every hook fails open: the shell command runs,
the edit passes, the cap is left alone, and the confidence check reports the
classifier is unavailable.

## Feature flags

| Flag | Effect |
|---|---|
| `AGENT_REFLEX_PRUNE=1` | Enable history pruning (`experimental.chat.messages.transform`). One classifier call per old message before every model request — real latency/token cost. Off by default. |

The guardrail, post-edit check, classification, `maxTokens` cap, and compaction
guidance are always on.

## Install

MiMo Code loads **file hooks** from `hooks/*.ts` (compiled with Bun.build, hot-reloaded).
The `plugin` array in config does NOT execute module code — a documented gotcha — so
this port ships as hook files, not a plugin entry. Copy them into your hooks dir:

- global: `~/.config/mimocode/hooks/` (or `~/.mimocode/hooks/`)
- project: `.mimocode/hooks/`

Files: `index.ts` (the hook module), `classifier.ts`, `check.ts`. The confidence tool
(`tools.ts`) goes in `.mimocode/tools/`.

## Layout

```
index.ts         the hook module (six hooks: chat.params, messages/system transform, tool.execute.before/after, session.compacting)
classifier.ts    config loader (agent-reflex.jsonc) + System One client + level map
check.ts         language parsers + edit excerpt (post-edit check)
tools.ts         confidence_check custom tool
test.ts          behavior tests (not installed)
```
