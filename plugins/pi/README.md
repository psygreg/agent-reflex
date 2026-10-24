# agent-reflex for Pi

Pi port of the `agent-reflex` OpenCode plugin: a small System One decision model
runs alongside the agent to safeguard shell commands, double-check edits, tune
effort per task, compact history, and let the model sanity-check its own reasoning.

Pi is the most extensible agent this plugin ports to, and the **only one** where
the two OpenCode-only features on every other port actually work: dynamic effort
and decision-driven history compaction. Install it into `~/.pi/agent/extensions/agent-reflex/`
(the installer does this), and create `agent-reflex.jsonc` in the plugin root with
your classifier settings.

## What it does

- **Dynamic thinking effort** (`before_agent_start`): classifies each prompt
  *simple*/*medium*/*high* and sets Pi's native thinking level
  (`off`/`low`/`high`) with `pi.setThinkingLevel()`. Pi translates the unified
  level to each model's native wire field via its own `thinkingLevelMap`, so this
  replaces the OpenCode plugin's hand-rolled per-vendor dialects (GLM, MiMo,
  Gemini, Qwen, Kimi, Grok, MiniMax…). This is the plugin's headline feature and it works
  at full fidelity here.
- **Decision-driven history compaction** (`context`, opt-in): when the history
  grows long, keeps the recent messages verbatim (a keep-window that widens with
  complexity), keeps a bounded set of load-bearing older messages, and folds the
  rest into a compact structured digest of the facts they established — so detail
  is compressed rather than discarded. Structural (tool call/result) messages are
  scored like any other and only survive when load-bearing. The `context` event
  receives a deep copy of the message list and can return a rewritten one — the
  one capability no other non-OpenCode agent exposes.
- **Shell guardrail** (`tool_call`): scores a command for damage potential and
  blocks it (`{ block: true }`) before it runs. A real block, like Claude
  Code/Codex/Qwen Code/Antigravity.
- **Post-edit double-check** (`tool_result`): runs a language parser on the edited
  file and, on medium/high complexity, a System One bug check on the edited text.
  Findings are appended to the tool result so the agent can fix problems.
- **Complexity classification** (`before_agent_start`): also injects a note
  suggesting a confidence check on medium/high.
- **Tool exposure** (`before_agent_start`): decides which tool *groups* the
  task needs (tools are judged by purpose — web, shell, edit, read, agents,
  other — one question per group, not per tool) and narrows the active set with
  `pi.setActiveTools()`, so the request carries fewer tool schemas and saves
  input tokens; a kept group keeps its whole family of tools. The always-keep
  set is the common core (read/search/edit/shell/task) plus `reflex_run`, so the
  model keeps the direct tools it reaches for constantly and only the long tail
  (web, exec,
  subagents…) is trimmed to what the task clearly needs or the model already used
  this session. Everything stays exposed if the classifier is
  unavailable. Disable with `AGENT_REFLEX_TOOLS=0`.
- **Tool dispatch** (`reflex_run` tool): an optional fallback for when the model
  cannot decide which underlying tool a task needs. It asks the decision model
  which tool to use (a `choice` decision), runs it via `ctx.executeTool`, and
  returns its real output. The model calls tools directly whenever it already
  knows which one fits and reaches for `reflex_run` only when the correct tool is
  unclear. The shell guardrail runs before dispatch. Tool dispatch uses the same
  configured classifier model.
- **Confidence check** (`confidence_check` tool and `/confidence` command): scores
  the model's current line of thought and returns CONTINUE or RESTART.

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
open: the shell command runs, the edit passes, effort is left alone, and the
confidence check reports the classifier is unavailable.

## Feature flags

Two features carry real cost or override provider defaults, so they are opt-in:

| Flag | Effect |
|---|---|
| `AGENT_REFLEX_PRUNE=1` | Enable decision-driven history compaction (`context`). One classifier call per old message plus one batched digest call per model request — real latency and token cost. Off by default. |
| `AGENT_REFLEX_MAXTOKENS=1` | Set the request token cap per level (`before_provider_request`), matching the plugin's `maxTokens` (simple 8192, medium 65536, high 131072). Overrides the provider's own cap. Off by default. |
| `AGENT_REFLEX_TOOLS=0` | Disable tool exposure. When set to `0` (or `all`), every tool stays exposed. On by default (`auto`); makes one classifier batch call per prompt to score the tool groups. |

The effort tuning, guardrail, post-edit check, and confidence check are always on.

## Level mapping

Complexity maps to Pi's thinking level as `simple→off`, `medium→low`,
`high→high` — the "simple disables thinking" convention used for the MiMo and
Qwen ports. Pi clamps the level to the active model's `thinkingLevelMap`, so a
model that cannot reach `off` (some reasoning models are always on) falls to its
nearest supported level rather than erroring.

## Pi-only notes

- **Effort and pruning are fully portable here** — the two features every other
  non-OpenCode port documents as impossible. Pi's `setThinkingLevel()` and the
  `context` event's `{ messages }` return make them native.
- **Per-model effort dialects are delegated to Pi.** The OpenCode plugin maintains
  hand-rolled rewrites (`applyZaiLevel`, `applyMimoLevel`, `applyGeminiLevel`, …);
  on Pi that layer is `thinkingLevelMap`, which Pi already keeps per-model correct.
- **Pruning cost.** The `context` handler scores each old message with the
  classifier before every model request. That is faithful to the OpenCode plugin
  but can be slow on long histories — hence the `AGENT_REFLEX_PRUNE=1` gate. A
  future improvement is to batch or cache scores.
- Extensions run in-process with full permissions (like Hermes), so there is no
  sandbox boundary beyond what you add.

## Layout

```
index.ts         the extension factory (registers events, the tool, the command)
classifier.ts    config loader (agent-reflex.jsonc) + System One client
check.ts         language parsers + edit excerpt (post-edit check)
test.ts          behavior tests (not installed)
```
