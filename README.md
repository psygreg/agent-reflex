# agent-orchestrator
OpenCode plugin for coding agent workflow optimization and safeguarding using any system one decision model, from Jev to self-hosted LM Studio, Ollama or llama.cpp.

### Goals
- Safeguard against potentially dangerous shell commands
- Improve token efficiency
- Deliver more reliable solutions to tasks

### What works
- Local system one decision models through llama.cpp
- Decision-driven history compaction
- Dynamic thinking effort level: qualifies each prompt as *low*, *medium* or *high* complexity, setting `maxTokens` alongside automatic effort changing for Anthropic or llama.cpp models (for now) in accordance
- Confidence level tool: automatically suggested for *medium* and *high* complexity tasks, allows the LLM to check for the confidence level of its current line of thinking before finalizing a response and correct itself in the way if needed
- Shell command check guardrail against commands that may cause damage to a repository or remove files without backup

## Usage
Merge the `plugins` directory from this repository with your OpenCode plugins directory, then use whatever configuration block is adequate for your use case from `opencode.example.jsonc`. An automated installation script will be developed once this project becomes more feature-complete.

For development, add a `"debugLog":` key to the plugin's options pointing to a file to write the logs into.

## TO-DO
- Use with local system one decision models through Ollama and LM Studio
- Use with external system one decision model providers like TypeSafe Jev
- Add automatic effort changing capabilities for local models running through Ollama and LM Studio
- Add automatic effort changing capabilities for OpenAI, Qwen, Z.ai and other providers
