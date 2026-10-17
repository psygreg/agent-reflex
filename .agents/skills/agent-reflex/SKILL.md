---
name: agent-reflex
description: Brief on the agent-reflex plugin's capabilities, and install or update the plugin by running its install script (update mode needs no answers)
---

# agent-reflex plugin

An OpenCode plugin that adds a small System One decision model (Jev, nimble, d1,
liquid-d1...) as a classifier to the agent loop. This skill briefs the user on
its capabilities and installs or updates it.

## Locate the installer

When this skill runs from the repository, the installer is at
`../../../install.sh` relative to this skill's directory, the README at
`../../../README.md`, example configs at `../../../opencode.example.jsonc`,
the source at `../../../plugins/reflex/index.ts`.

When this skill was installed standalone (e.g. via
`npx skills add psygreg/agent-reflex`), the repository is not present: clone
it first and use `<clone>/install.sh` instead:

```sh
git clone https://github.com/psygreg/agent-reflex /tmp/agent-reflex
```

## Capabilities (brief the user with this)

- **Decision-driven history compaction**: when the conversation exceeds 16
  messages, each old message is scored by the classifier and dropped when it is
  unlikely to matter; structural messages (tool calls/results) always survive.
- **Complexity classification**: every prompt is scored *simple*, *medium* or
  *high*; `maxTokens` is set per level and medium/high prompts get a system
  note suggesting a confidence check before committing to a solution.
- **Automatic effort control**: the level is written into every primary model
  request in the dialect the requested model actually speaks — Claude
  (`output_config.effort`), GPT reasoning models (`reasoning.effort` /
  `reasoning_effort`), GLM-5.2+ (`thinking.type` + `reasoning_effort`), Xiaomi
  MiMo V2.5+ (`thinking.type`, or `reasoning.effort` / `reasoning_effort` on
  the Responses API and gateway routes), local llama.cpp/Ollama
  (`reasoning_effort`, plus `chat_template_kwargs` on llama.cpp). Dialects are
  detected per request, so multimodel setups never send a foreign field;
  models without a wired dialect stay untouched.
- **Confidence tool**: the `systemone_check_confidence` tool scores the
  model's current line of thought and returns CONTINUE or RESTART.
- **Shell guardrail**: shell commands are scored for damage potential;
  dangerous ones are denied.
- **Syntax checks**: after `edit`/`write` the file is checked with language
  parsers (plus a classifier bug check on medium/high), with one retry and
  then an ask-the-user stop.

The classifier needs a System One endpoint at `<baseURL>/systemone`: local
llama.cpp/Ollama (0.35+)/LM Studio (0.4.26+), or TypeSafe's Jev through the
TypeSafe API, OpenRouter, the Vercel AI Gateway or OpenCode Zen. A
`fallbackModel` option retries the classifier when the primary model rejects
requests (e.g. a free-model window closing).

## Updating an existing installation

`install.sh` detects an existing installation (plugin copy or config entry)
**before asking anything**, so updating needs no answers. Run it with stdin
closed:

```sh
bash ../../../install.sh </dev/null
```

- Only the plugin files are refreshed (in `~/.config/opencode/plugins/reflex/`
  or next to the config that references it); the configured options are left
  untouched.
- If it instead prints the setup menu and ends with "No input available
  (stdin closed)", there is no installation yet — follow the fresh-install
  section below.
- After updating, **tell the user to restart OpenCode** (`opencode service
  restart`). Do not restart it yourself: it would terminate this session.

## Fresh install

The installer asks questions in a fixed order and reads the answers from
stdin, so collect them from the user in chat first, then pipe them in one
line each. The exact order:

1. Provider: `1` llamacpp, `2` ollama, `3` lmstudio, `4` typesafe,
   `5` openrouter, `6` vercel, `7` opencode (OpenCode Zen), `8` custom.
2. Providers 1-3 only: "Server runs on this machine?" — `Y` or `n`. If `n`,
   the next answer is the remote base URL including `/v1`
   (e.g. `http://192.168.1.10:8080/v1`). Provider 8 (custom) takes the base
   URL here directly.
3. Classifier model. An empty answer takes the preset default (`nimble`,
   `jev-latest`, `~typesafe/jev-latest`, `typesafe-ai/jev`, `jev-1.13`);
   required for llamacpp and lmstudio (their models are free-form ids).
4. API key, optional, `{env:NAME}` substitution supported and preferred over
   literal keys.
5. Fallback classifier model on the same endpoint, optional.
6. Debug log file path, optional.

Example — Jev through the TypeSafe API with the key from the environment:

```sh
printf '4\n\n{env:TYPESAFE_API_KEY}\n\n\n' | bash ../../../install.sh
```

(Colors are automatic and turn off by themselves when output is not a
terminal, so nothing extra is needed when running it from an agent.)

The installer copies the plugin next to the OpenCode config it finds
(`~/.config/opencode/` or `~/.opencode/`) and merges the plugin entry into
`opencode.json(c)`, keeping comments and formatting; a `.agent-reflex.bak`
backup is written and the merged file is validated before committing. The
merge needs bun, node (bundled with npm) or deno; without any of them the
script prints the entry for a manual paste — in that case, show the printed
entry to the user instead of editing the config blindly.

Report the script's `[agent-reflex]` messages to the user, confirm the merged
entry looks right, and remind them to restart OpenCode — again, do not run
`opencode service restart` from inside the session.
