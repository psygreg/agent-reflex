# agent-reflex
Plugin for coding agent workflow optimization and safeguarding using any system one decision model, from Jev to self-hosted LM Studio, Ollama or llama.cpp.

### Goals
- Safeguard against potentially dangerous shell commands
- Improve token efficiency
- Deliver more reliable solutions to tasks

### Requirement
The plugin needs a System One decision model as its classifier, served at
`<baseURL>/systemone` — local llama.cpp (0.6 onwards), Ollama (0.35 onwards) or
LM Studio (0.4.26 onwards), or TypeSafe Jev and other System One models through
the TypeSafe API, OpenRouter, the Vercel AI Gateway or OpenCode Zen. Every
feature below is driven by this classifier.

### Features
- **Decision-driven history compaction**: keeps the recent messages verbatim (keep-window widens with complexity), keeps a bounded set of load-bearing older messages, and folds the rest into a compact structured digest so their detail is compressed rather than discarded
- **Dynamic thinking effort level**: qualifies each prompt as *low*, *medium* or *high* complexity, setting `maxTokens` and switching reasoning effort when the agent uses the default effort setting. A non-default model variant or explicit effort option takes precedence. The request dialect is detected per request from the model actually being requested, so multimodel setups — including one gateway proxying many models — never send a foreign field; models without a wired dialect stay untouched and can still use other features of the plugin. Wired dialects: Anthropic, llama.cpp, Ollama, OpenAI GPT reasoning models, Z.ai GLM (GLM-5.2 onwards), Xiaomi MiMo (MiMo-V2.5 onwards), Google Gemini (Gemini 3 onwards), Qwen (Qwen3.5 onwards and the qwen-plus/qwen-max aliases), Moonshot Kimi (kimi-k2.7+/kimi-k3), xAI Grok (grok-4.3 onwards) and MiniMax (MiniMax-M3 onwards)
- **Confidence level tool**: automatically suggested for *medium* and *high* complexity tasks, allows the LLM to check the confidence of its current line of thinking before finalizing a response and correct itself along the way if needed
- **Tool exposure**: for each prompt the classifier decides which tools the task actually needs and the model is given only those, so the request carries fewer tool schemas and saves input tokens. In OpenCode, the always-keep set is the common core (read/search/edit/shell/task) plus `reflex_run`, `systemone_check_confidence` and `systemone_reveal_tools`. If a needed tool was trimmed, the latter lists the agent's tool pool and restores all tool schemas for the current user request. Falls back to exposing everything if the classifier is unavailable
- **Decision-model tool dispatch** (`reflex_run`): an optional fallback tool for when the model cannot decide which underlying tool a task needs. It asks the decision model which tool to use (a `choice` decision), runs it, and returns its real output. The model calls tools directly whenever it already knows which one fits and reaches for `reflex_run` only when the correct tool is unclear. Tool dispatch uses the same configured classifier model as the rest of the plugin
- **Syntax checks**: up to two-step checks after `edit` and `write` tool calls using parsers and the decision model
- **Shell guardrail**: blocks commands that may damage a repository or remove files without backup; the check runs before dispatch through `reflex_run` as well

### Agent support

Eight agents are supported. The classifier config is shared across all of them
(`agent-reflex.jsonc`, same option names), so the classifier questions are answered
once. Dynamic effort needs the plugin to rewrite the model request, and history
compaction needs it to rewrite the message list — both only reach agents whose hook
API allows that rewrite.

| Agent | Shell guardrail | Post-edit checks | Classify + confidence | Compaction guidance | Dynamic effort | History compaction | Tool exposure | Tool dispatch | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **OpenCode** | ✅ hard block | ✅ inline | ✅ | ✅ built-in | ✅ full (per-model dialects) | ✅ decision-driven | ✅ | ✅ (`reflex_run`) | Reference implementation and the only agent where everything works. |
| **Pi** | ✅ hard block | ✅ inline | ✅ | ✅ via `context` | ✅ full (`setThinkingLevel`) | ✅ opt-in decision-driven | ✅ (`setActiveTools`) | ✅ (`reflex_run`) | Pi translates the unified effort level per model itself, so no per-vendor dialect code is needed. |
| **MiMo Code** | ✅ hard block | ✅ inline | ✅ | ✅ compacting hook | ⚠️ token cap only | ✅ opt-in decision-driven | ❌ | ❌ | OpenCode-derived. `chat.params` sets `maxTokens` but not `reasoning_effort`, so effort cannot change how hard the model thinks. |
| **Claude Code** | ✅ hard block | ✅ inline | ✅ | ✅ fact-extraction guidance | ❌ | ⚠️ digest guidance only | ❌ | ❌ | `PreCompact` reads the transcript and extracts the fact buckets to steer the summary, but hooks cannot rewrite the message list, so it cannot choose what to keep. |
| **Qwen Code** | ✅ hard block | ✅ inline | ✅ | ✅ fact-extraction guidance | ❌ | ⚠️ digest guidance only | ❌ | ❌ | Same hook limits as Claude Code. Strongest of the shell-hook ports. |
| **Codex** | ✅ hard block | ✅ inline | ✅ | ❌ inert | ❌ | ❌ | ❌ | ❌ | No `PreCompact` `custom_instructions`; its compaction hook can only cancel compaction. Edits arrive via `apply_patch` (V4A). |
| **Antigravity** | ✅ hard block | ⚠️ one turn late | ✅ | ❌ inert | ❌ | ❌ | ❌ | ❌ | `PostToolUse` cannot inject context (open upstream antigravity-cli#808), so findings queue and surface at the next model call. |
| **Hermes** | ⚠️ wrapper tool | ✅ inline | ✅ | ❌ none | ❌ | ❌ | ❌ | ❌ | Hooks cannot block a tool call, so the guardrail is a `safe_run` wrapper over `terminal`. No compaction hook. |

Legend: ✅ works · ⚠️ works with a documented compromise · ❌ not possible (agent hook
API limitation). Dynamic effort means both the reasoning/thinking level and the
per-level `maxTokens` cap where the agent exposes one. Tool exposure means the
agent can remove tool schemas from the model's request (real input-token savings);
the shell-hook agents can only deny a tool call after the model already chose it,
which saves nothing and is therefore marked ❌.

## Usage
Install the skill using `npx skills add psygreg/agent-reflex` or `bun x skills add psygreg/agent-reflex` then ask your agent to do it: the skill briefs the agent on the plugin's capabilities and installs or updates it — updates need no answers (`bash install.sh </dev/null`), fresh installs collect the answers in chat and pipe them in.

Or run the install script provided in this repository. It will also install the skill so future updates can be performed through the agent itself.

```sh
./install.sh
```

On a fresh install it asks for the classifier provider (llama.cpp, Ollama, LM Studio, TypeSafe, OpenRouter, Vercel AI Gateway, OpenCode Zen or a custom endpoint), whether a local server runs on the same machine or a remote one (with its base URL), the classifier model, an optional API key (`{env:NAME}` supported), an optional fallback classifier model and an optional debug log path. It copies the plugin into the plugins directory next to your OpenCode config (`~/.config/opencode/` by default, `~/.opencode/` when your config lives there), installs the repo's agent skill through the skills CLI (`bunx`/`npx skills add`, into the CLI's own canonical path) when no copy exists yet — existing copies are detected and left untouched, so there is never a second installation path — and adds the plugin entry to `opencode.json(c)` (a `.agent-reflex.bak` backup is kept next to the config, and the merged file is validated before committing). The automatic config merge requires bun or node (bundled with npm); deno also works. Without any of them the entry is printed for a manual paste.

Re-running the installer only updates the plugin files: an existing installation (plugin copy or config entry) is detected and the configured options are left untouched. Each part installs only for the software actually present: the OpenCode plugin and its `opencode.json(c)` entry are written only when the `opencode` CLI is on `PATH`, and each agent port (Claude Code, Codex, Hermes, Qwen Code, Antigravity, Pi, MiMo Code) only when that agent's CLI is present — anything you do not have installed is skipped entirely, with no files or config written for it. If none of the supported agents is installed, a fresh install stops before the classifier prompts and reports that there is nothing to install. After installing or updating, restart OpenCode (`opencode service restart`) to load the plugin.

For development, add a `"debugLog":` key to the plugin's options pointing to a file to write the logs into. Configuration reference examples live in `opencode.example.jsonc`.

## TO-DO
- Add automatic effort changing capabilities for local models running through LM Studio (blocked upstream: its OpenAI-compatible endpoint documents no reasoning field yet)
- Add automatic effort changing capabilities for other providers beyond the wired dialects (Anthropic, GPT, GLM, MiMo, Gemini, Qwen, Kimi, Grok, MiniMax)
- Port to further agents (Claude Code, Codex, Hermes, Qwen Code, Antigravity, Pi and MiMo Code are done)
