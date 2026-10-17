# agent-reflex
Plugin for coding agent workflow optimization and safeguarding using any system one decision model, from Jev to self-hosted LM Studio, Ollama or llama.cpp.

### Goals
- Safeguard against potentially dangerous shell commands
- Improve token efficiency
- Deliver more reliable solutions to tasks

### What works
- Local system one decision models through llama.cpp (0.6 onwards), Ollama (0.35 onwards) and LM Studio (0.4.26 onwards), all serving the same System One endpoint at `<baseURL>/systemone`
- TypeSafe Jev and other System One decision models as the classifier, through the TypeSafe API directly, OpenRouter, the Vercel AI Gateway or OpenCode Zen
- Use with OpenCode v2 agent
- Decision-driven history compaction
- Dynamic thinking effort level: qualifies each prompt as *low*, *medium* or *high* complexity, setting `maxTokens` alongside automatic effort changing for Anthropic, llama.cpp, Ollama, OpenAI GPT reasoning models, Z.ai GLM models (GLM-5.2 onwards), Xiaomi MiMo models (MiMo-V2.5 onwards) and Google Gemini models (Gemini 3 onwards) in accordance. The request dialect is detected per request from the model actually being requested, so multimodel setups — including one gateway proxying many models — never send a foreign field; models without a wired dialect stay untouched and can still use other features of the plugin
- Confidence level tool: automatically suggested for *medium* and *high* complexity tasks, allows the LLM to check for the confidence level of its current line of thinking before finalizing a response and correct itself in the way if needed
- Up to two-step syntax checks after `edit` and `write` tool calls using parsers and decision model
- Shell command check guardrail against commands that may cause damage to a repository or remove files without backup

## Usage
Install the skill using `npx skills add psygreg/agent-reflex` or `bun x skills add psygreg/agent-reflex` then ask your agent to do it: the skill briefs the agent on the plugin's capabilities and installs or updates it — updates need no answers (`bash install.sh </dev/null`), fresh installs collect the answers in chat and pipe them in.

Or run the install script provided in this repository. It will also install the skill so future updates can be performed through the agent itself.

```sh
./install.sh
```

On a fresh install it asks for the classifier provider (llama.cpp, Ollama, LM Studio, TypeSafe, OpenRouter, Vercel AI Gateway, OpenCode Zen or a custom endpoint), whether a local server runs on the same machine or a remote one (with its base URL), the classifier model, an optional API key (`{env:NAME}` supported), an optional fallback classifier model and an optional debug log path. It copies the plugin into the plugins directory next to your OpenCode config (`~/.config/opencode/` by default, `~/.opencode/` when your config lives there), installs the repo's agent skill through the skills CLI (`bunx`/`npx skills add`, into the CLI's own canonical path) when no copy exists yet — existing copies are detected and left untouched, so there is never a second installation path — and adds the plugin entry to `opencode.json(c)` (a `.agent-reflex.bak` backup is kept next to the config, and the merged file is validated before committing). The automatic config merge requires bun or node (bundled with npm); deno also works. Without any of them the entry is printed for a manual paste.

Re-running the installer only updates the plugin files: an existing installation (plugin copy or config entry) is detected and the configured options are left untouched. After installing or updating, restart OpenCode (`opencode service restart`) to load the plugin.

For development, add a `"debugLog":` key to the plugin's options pointing to a file to write the logs into. Configuration reference examples live in `opencode.example.jsonc`.

## TO-DO
- Add automatic effort changing capabilities for local models running through LM Studio (blocked upstream: its OpenAI-compatible endpoint documents no reasoning field yet)
- Add automatic effort changing capabilities for Qwen and other providers
- Use with other agents like Claude Code, Hermes, Codex and Qwen Code
