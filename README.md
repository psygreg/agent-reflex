# agent-reflex
Plugin for coding agent workflow optimization and safeguarding using any system one decision model, from Jev to self-hosted LM Studio, Ollama or llama.cpp.

### Goals
- Safeguard against potentially dangerous shell commands
- Improve token efficiency
- Deliver more reliable solutions to tasks

### What works
- Local system one decision models through llama.cpp
- Use with OpenCode v2 agent
- Decision-driven history compaction
- Dynamic thinking effort level: qualifies each prompt as *low*, *medium* or *high* complexity, setting `maxTokens` alongside automatic effort changing for Anthropic, llama.cpp, OpenAI GPT reasoning models, and Z.ai GLM models (GLM-5.2 onwards) in accordance. The request dialect is detected per request from the model actually being requested, so multimodel setups — including one gateway proxying many models — never send a foreign field; models without a wired dialect stay untouched and can still use other features of the plugin
- Confidence level tool: automatically suggested for *medium* and *high* complexity tasks, allows the LLM to check for the confidence level of its current line of thinking before finalizing a response and correct itself in the way if needed
- Up to two-step syntax checks after `edit` and `write` tool calls using parsers and decision model
- Shell command check guardrail against commands that may cause damage to a repository or remove files without backup
- TypeSafe Jev and other System One decision models as the classifier, through the TypeSafe API directly, OpenRouter, the Vercel AI Gateway or OpenCode Zen, in addition to local system one decision models through llama.cpp

## Usage
Merge the `plugins` directory from this repository with your OpenCode plugins directory, then use whatever configuration block is adequate for your use case from `opencode.example.jsonc`. An automated installation script will be developed once this project becomes more feature-complete.

For development, add a `"debugLog":` key to the plugin's options pointing to a file to write the logs into.

This requires `npm` or `bun` to compile.

## TO-DO
- Use with local system one decision models through Ollama and LM Studio
- Add automatic effort changing capabilities for local models running through Ollama and LM Studio
- Add automatic effort changing capabilities for Qwen, Xiaomi and other providers
- Use with other agents like Claude Code, Hermes, Codex and Qwen Code
