#!/usr/bin/env bash
# agent-reflex installer.
#
# First run: interactively walks through the classifier (System One) options,
# then installs each piece only for the software actually present on PATH. The
# OpenCode plugin (and its config entry) is installed when the opencode CLI is
# present, the repo's agent skill (agent-reflex) when it is not installed yet,
# and each agent port (Claude Code, Codex, Hermes, Qwen Code, Antigravity, Pi,
# MiMo Code) only when that agent's CLI is present — anything absent is skipped
# entirely. Re-running only updates the plugin files: an existing installation
# (plugin copy or config entry) is detected, the configured options and an
# already-installed skill are left untouched, and a missing skill is still
# installed.
#
# Requires bash and, for the automatic config merge, bun, node (bundled with
# npm) or deno — the plugin needs a JS/TS runtime to load anyway. Without any
# of them the plugin entry is printed for a manual paste instead.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$REPO_DIR/plugins/opencode"
CC_PLUGIN_SRC="$REPO_DIR/plugins/claude-code"
CX_PLUGIN_SRC="$REPO_DIR/plugins/codex"
HX_PLUGIN_SRC="$REPO_DIR/plugins/hermes"
QX_PLUGIN_SRC="$REPO_DIR/plugins/qwen-code"
AX_PLUGIN_SRC="$REPO_DIR/plugins/antigravity"
PX_PLUGIN_SRC="$REPO_DIR/plugins/pi"
MX_PLUGIN_SRC="$REPO_DIR/plugins/mimocode"
SKILL_SRC="$REPO_DIR/.agents/skills/agent-reflex"

# The global OpenCode config lives in ~/.config/opencode (XDG) or, with some
# installation methods, ~/.opencode. An existing config file decides the
# directory: the plugin entry's "./plugins/reflex" package path resolves
# relative to the config file, so the plugin copy must live in the same
# directory. A fresh install defaults to the XDG directory.
XDG_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
CONFIG_DIR=""
CONFIG_FILE=""
for dir in "$XDG_CONFIG_DIR" "$HOME/.opencode"; do
  for f in opencode.json opencode.jsonc; do
    if [ -f "$dir/$f" ]; then
      CONFIG_DIR="$dir"
      CONFIG_FILE="$dir/$f"
      break 2
    fi
  done
done
if [ -z "$CONFIG_DIR" ]; then
  CONFIG_DIR="$XDG_CONFIG_DIR"
fi
PLUGIN_DEST="$CONFIG_DIR/plugins/reflex"

# JS runtime used for the config merge, in order of preference. The merge
# script is plain CommonJS, so bun, node (bundled with npm) and deno all run it.
JS_RUNTIME=""
if command -v bun >/dev/null 2>&1; then
  JS_RUNTIME="bun -e"
elif command -v node >/dev/null 2>&1; then
  JS_RUNTIME="node -e"
elif command -v deno >/dev/null 2>&1; then
  JS_RUNTIME="deno eval"
fi

# Terminal colors, disabled when stdout is not a terminal or NO_COLOR is set
# (https://no-color.org). Piped/non-interactive runs get plain text.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\e[1m' CYAN=$'\e[36m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' DIM=$'\e[2m' RESET=$'\e[0m'
else
  BOLD="" CYAN="" GREEN="" YELLOW="" RED="" DIM="" RESET=""
fi

msg() { echo "${BOLD}${CYAN}[agent-reflex]${RESET}: $*"; }
warn() { echo "${BOLD}${YELLOW}[agent-reflex]${RESET}: ${BOLD}$*${RESET}"; }
err() { echo "${BOLD}${RED}[agent-reflex]${RESET}: $*" >&2; }

# True when at least one of the given CLI binaries is on PATH. Agent ports are
# installed only for agents that are actually present, so a machine running just
# one agent does not collect plugin files and classifier configs for the others.
# Aliases are accepted (e.g. Antigravity: antigravity/gemini; MiMo Code: mimocode/mimo).
have_cli() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 && return 0
  done
  return 1
}
die() { err "${RED}$*${RESET}"; exit 1; }

# Classifier presets: default base URL and suggested model per provider.
declare -A PRESET_URL=(
  [llamacpp]="http://127.0.0.1:8080/v1"
  [ollama]="http://127.0.0.1:11434/v1"
  [lmstudio]="http://127.0.0.1:1234/v1"
  [typesafe]="https://api.typesafe.ai/v1"
  [openrouter]="https://openrouter.ai/api/v1"
  [vercel]="https://ai-gateway.vercel.sh/typesafe/v1"
  [opencode]="https://opencode.ai/zen/v1"
)
declare -A PRESET_MODEL=(
  [llamacpp]=""
  [ollama]="nimble"
  [lmstudio]=""
  [typesafe]="jev-latest"
  [openrouter]="~typesafe/jev-latest"
  [vercel]="typesafe-ai/jev"
  [opencode]="jev-1.13"
)
declare -A PRESET_HINT=(
  [llamacpp]="the decision model your llama-server serves (e.g. liquid-d1, kev)"
  [ollama]="decision model like nimble (bundled with Ollama 0.35+) or d1"
  [lmstudio]="the decision model id from the LM Studio catalog"
  [typesafe]="jev-latest or a pinned release"
  [openrouter]="typesafe/jev-1.14 or ~typesafe/jev-latest"
  [vercel]="typesafe-ai/jev"
  [opencode]="jev-1.13, or the limited-time free jev-1.13-free"
)

update_files() {
  mkdir -p "$PLUGIN_DEST"
  cp "$PLUGIN_SRC"/*.ts "$PLUGIN_DEST"/
  msg "Plugin files updated in ${DIM}${PLUGIN_DEST}${RESET}"
}

# The repo's agent skill (agent-reflex), installed through the skills CLI
# (bunx or npx) so there is exactly one canonical, CLI-managed copy — the
# installer never creates a second installation path itself. Copies the CLI
# already manages (~/.agents/skills, ~/.claude/skills) or a pre-existing
# OpenCode copy are detected and left untouched; the skill itself carries a
# repo-clone fallback for running outside the repository.

# Runtime for the skills CLI: bunx (bun) or npx (node, bundled with npm).
SKILLS_CLI=""
if command -v bunx >/dev/null 2>&1; then
  SKILLS_CLI="bunx skills"
elif command -v npx >/dev/null 2>&1; then
  SKILLS_CLI="npx --yes skills"
fi

install_skill() {
  if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
    return
  fi
  if [ -z "$SKILLS_CLI" ]; then
    warn "Skill agent-reflex not installed: no skills CLI runtime (bunx or npx)."
    warn "Install it later with: npx skills add psygreg/agent-reflex --skill agent-reflex -a opencode -g"
    return
  fi
  local output
  if output=$($SKILLS_CLI add "$REPO_DIR" --skill agent-reflex -a opencode -g -y 2>&1); then
    msg "Skill agent-reflex installed through the skills CLI."
  else
    warn "Skill agent-reflex not installed — the skills CLI failed:"
    printf '%s\n' "$output" | sed 's/^/  /'
  fi
}

# ---------------------------------------------------------------
# AGENT PORTS (plugins/claude-code, plugins/codex).
# ---------------------------------------------------------------
# Both agent plugins load from a local directory or a marketplace. This
# installer keeps one installation path per agent: it copies the plugin into the
# agent's plugins directory and, when that agent's CLI is available, registers it
# so hooks load. The classifier config is written to agent-reflex.jsonc in each
# plugin root (same option names as the OpenCode plugin), so the user configures
# the classifier once and every agent shares it.
#
# install_agent_port SRC DEST LABEL CLI_CMD...
#   SRC        repo plugin source dir
#   DEST       installed plugin dir (contains agent-reflex.jsonc)
#   LABEL      display name (Claude Code, Codex, ...)
#   CLI_CMD... command prefix to register the plugin (empty => copy only)
install_agent_port() {
  local src="$1" dest="$2" label="$3"; shift 3
  local cfg="$dest/agent-reflex.jsonc"
  [ -d "$src" ] || { warn "plugins/${src##*/} not found — skipping ${label} install."; return 0; }

  # Copy plugin files, preserving an existing classifier config across the copy.
  mkdir -p "$dest"
  local keep=""
  if [ -f "$cfg" ]; then
    keep="$(mktemp)"
    cp "$cfg" "$keep"
  fi
  cp -R "$src"/. "$dest"/
  # Keep test harnesses out of the install dir (harmless, but not part of the plugin).
  rm -f "$dest"/test.ts "$dest"/test.js 2>/dev/null || true
  if [ -n "$keep" ]; then
    cp "$keep" "$cfg"
    rm -f "$keep"
  fi
  chmod +x "$dest"/scripts/*.sh 2>/dev/null || true
  msg "${label} plugin files copied to ${DIM}${dest}${RESET}"

  # Write the shared classifier config when absent (a non-empty $1 = provider is
  # passed via _AR_PROVIDER from the caller; empty means update mode, skip).
  if [ -n "${_AR_PROVIDER:-}" ] && [ ! -f "$cfg" ]; then
    mkdir -p "$dest"
    {
      echo "{"
      echo "  // System One classifier shared with the OpenCode plugin."
      echo "  // Option names match plugins/opencode (provider/baseURL/model/apiKey/...)."
      printf '  "provider": "%s",\n' "$_AR_PROVIDER"
      [ -n "${_AR_BASEURL:-}" ] && printf '  "baseURL": "%s",\n' "$_AR_BASEURL"
      [ -n "${_AR_MODEL:-}" ] && printf '  "model": "%s",\n' "$_AR_MODEL"
      [ -n "${_AR_APIKEY:-}" ] && printf '  "apiKey": "%s",\n' "$_AR_APIKEY"
      [ -n "${_AR_FALLBACK:-}" ] && printf '  "fallbackModel": "%s",\n' "$_AR_FALLBACK"
      [ -n "${_AR_DEBUG:-}" ] && printf '  "debugLog": "%s",\n' "$_AR_DEBUG"
      echo "}"
    } > "$cfg" 2>/dev/null
    # Trim a possible trailing comma before } or ].
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$cfg" <<'PY' 2>/dev/null || true
import re, sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
s = re.sub(r',(\s*[}\]])', r'\1', s)
open(p, "w", encoding="utf-8").write(s)
PY
    fi
    msg "${label} classifier config written to ${DIM}${cfg}${RESET}"
  elif [ -f "$cfg" ]; then
    msg "${label} classifier config left untouched (${DIM}${cfg}${RESET})"
  fi

  # Register with the agent CLI when present; otherwise print manual steps.
  [ "$#" -gt 0 ] || return 0
  if ! command -v "$1" >/dev/null 2>&1; then
    warn "${label} CLI ($1) not found — plugin files are copied to"
    warn "  ${dest}"
    warn "but not registered. Register it manually:"
    warn "  $* ${dest}"
    return 0
  fi
  local out
  if out=$("$@" "$dest" 2>&1); then
    msg "${label} plugin registered through the $1 CLI."
  else
    warn "${label} plugin copied but not registered (the $1 install command"
    warn "differed). Register it manually:"
    warn "  $* ${dest}"
    printf '%s\n' "$out" | sed 's/^/  /'
  fi
}

install_agent_ports() {
  # Each port is installed only when that agent's CLI is present; a missing agent
  # is skipped with no output (no files copied, no config written).
  # Claude Code: register via `claude plugin install <dir>`.
  if have_cli claude; then
    install_agent_port "$CC_PLUGIN_SRC" "$HOME/.claude/plugins/agent-reflex" "Claude Code" claude plugin install
  fi
  # Codex: register via `codex plugin install <dir>`.
  if have_cli codex; then
    install_agent_port "$CX_PLUGIN_SRC" "$HOME/.codex/plugins/agent-reflex" "Codex" codex plugin install
  fi
  # Hermes: copy the plugin, then enable it in config.yaml (Hermes has no
  # install command — plugins are discovered by directory but disabled by
  # default until listed under plugins.enabled).
  if have_cli hermes; then
    install_agent_port "$HX_PLUGIN_SRC" "$HOME/.hermes/plugins/agent-reflex" "Hermes"
    enable_hermes_plugin
  fi
  # Qwen Code: copy the plugin files + config, then register via
  # `qwen extensions install <dir>` (Qwen loads extensions from ~/.qwen/extensions).
  if have_cli qwen; then
    install_agent_port "$QX_PLUGIN_SRC" "$HOME/.qwen/extensions/agent-reflex" "Qwen Code" qwen extensions install
  fi
  # Antigravity: copy into the global plugin dir (discovered by directory, no
  # install command and no enable gate — like Hermes but without plugins.enabled).
  if have_cli antigravity gemini; then
    install_agent_port "$AX_PLUGIN_SRC" "$HOME/.gemini/config/plugins/agent-reflex" "Antigravity"
  fi
  # Pi: copy into the extensions dir (auto-discovered by index.ts at the extension
  # root, no install command and no enable gate). Pi loads it via its jiti TS loader.
  if have_cli pi; then
    install_agent_port "$PX_PLUGIN_SRC" "$HOME/.pi/agent/extensions/agent-reflex" "Pi"
  fi
  if have_cli mimocode mimo; then
    install_mimocode_port
  fi
}

# MiMo Code is file-hook based: it loads hooks/*.ts and tools/*.ts from its config
# dirs (the "plugin" array does NOT execute module code). So the hook module and its
# two helpers go in hooks/, the confidence tool in tools/, and the classifier config
# next to the hooks. Mirrors install_agent_port's config-preservation rules.
install_mimocode_port() {
  local src="$MX_PLUGIN_SRC"
  [ -d "$src" ] || { warn "plugins/mimocode not found — skipping MiMo Code install."; return 0; }

  local hooks_dir="$HOME/.config/mimocode/hooks"
  local tools_dir="$HOME/.config/mimocode/tools"
  local cfg="$hooks_dir/agent-reflex.jsonc"

  mkdir -p "$hooks_dir" "$tools_dir"
  # Preserve an existing classifier config across the copy.
  local keep=""
  if [ -f "$cfg" ]; then
    keep="$(mktemp)"
    cp "$cfg" "$keep"
  fi
  cp "$src"/index.ts "$src"/classifier.ts "$src"/check.ts "$hooks_dir"/
  cp "$src"/tools.ts "$tools_dir"/agent-reflex-confidence.ts
  rm -f "$hooks_dir"/test.ts "$tools_dir"/test.ts 2>/dev/null || true
  if [ -n "$keep" ]; then
    cp "$keep" "$cfg"
    rm -f "$keep"
  fi
  msg "MiMo Code hook files copied to ${DIM}${hooks_dir}${RESET} and ${DIM}${tools_dir}${RESET}"

  # Write the shared classifier config when absent (a non-empty _AR_PROVIDER means
  # fresh install; empty means update mode, skip).
  if [ -n "${_AR_PROVIDER:-}" ] && [ ! -f "$cfg" ]; then
    {
      echo "{"
      echo "  // System One classifier shared with the OpenCode plugin."
      echo "  // Option names match plugins/opencode (provider/baseURL/model/apiKey/...)."
      printf '  "provider": "%s",\n' "$_AR_PROVIDER"
      [ -n "${_AR_BASEURL:-}" ] && printf '  "baseURL": "%s",\n' "$_AR_BASEURL"
      [ -n "${_AR_MODEL:-}" ] && printf '  "model": "%s",\n' "$_AR_MODEL"
      [ -n "${_AR_APIKEY:-}" ] && printf '  "apiKey": "%s",\n' "$_AR_APIKEY"
      [ -n "${_AR_FALLBACK:-}" ] && printf '  "fallbackModel": "%s",\n' "$_AR_FALLBACK"
      [ -n "${_AR_DEBUG:-}" ] && printf '  "debugLog": "%s",\n' "$_AR_DEBUG"
      echo "}"
    } > "$cfg" 2>/dev/null
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$cfg" <<'PY' 2>/dev/null || true
import re, sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
s = re.sub(r',(\s*[}\]])', r'\1', s)
open(p, "w", encoding="utf-8").write(s)
PY
    fi
    msg "MiMo Code classifier config written to ${DIM}${cfg}${RESET}"
  elif [ -f "$cfg" ]; then
    msg "MiMo Code classifier config left untouched (${DIM}${cfg}${RESET})"
  fi
  msg "MiMo Code loads these automatically (file hooks); restart it if they were already open."
}

# Adds "agent-reflex" to plugins.enabled in ~/.hermes/config.yaml (creating the
# file/section as needed). Hermes refuses to load a plugin that is not enabled.
enable_hermes_plugin() {
  local cfg="$HOME/.hermes/config.yaml"
  mkdir -p "$HOME/.hermes"
  if [ ! -f "$cfg" ]; then
    printf 'plugins:\n  enabled:\n    - agent-reflex\n' > "$cfg"
    msg "Hermes plugin enabled in ${DIM}${cfg}${RESET}"
    return 0
  fi
  if grep -qE '(^|[[:space:]])-[[:space:]]*agent-reflex[[:space:]]*$' "$cfg" 2>/dev/null; then
    msg "Hermes plugin already enabled — left untouched."
    return 0
  fi
  # Insert under an existing plugins.enabled list, or append a new block.
  if grep -qE '^[[:space:]]*enabled:[[:space:]]*$' "$cfg" 2>/dev/null; then
    # Append "- agent-reflex" to the first enabled: list block.
    awk '
      /^[[:space:]]*enabled:[[:space:]]*$/ && !done { print; print "    - agent-reflex"; done=1; next }
      { print }
    ' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
    msg "Hermes plugin enabled in ${DIM}${cfg}${RESET}"
  elif grep -qE '^[[:space:]]*plugins:[[:space:]]*$' "$cfg" 2>/dev/null; then
    awk '
      /^[[:space:]]*plugins:[[:space:]]*$/ && !done { print; print "  enabled:"; print "    - agent-reflex"; done=1; next }
      { print }
    ' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
    msg "Hermes plugin enabled in ${DIM}${cfg}${RESET}"
  else
    printf '\nplugins:\n  enabled:\n    - agent-reflex\n' >> "$cfg"
    msg "Hermes plugin enabled in ${DIM}${cfg}${RESET}"
  fi
}

# ---------------------------------------------------------------
# UPDATE MODE: an existing installation is only brought up to date.
# ---------------------------------------------------------------
if [ -f "$PLUGIN_DEST/index.ts" ] || { [ -n "$CONFIG_FILE" ] && grep -q 'plugins/reflex' "$CONFIG_FILE"; }; then
  if have_cli opencode; then
    update_files
  fi
  install_skill
  install_agent_ports
  msg "Existing installation detected — options left untouched."
  if have_cli opencode; then
    msg "Restart OpenCode ${BOLD}(opencode service restart)${RESET} to reload the plugin."
  fi
  exit 0
fi

# ---------------------------------------------------------------
# FRESH INSTALL: ask for the classifier options.
# ---------------------------------------------------------------
  if [ ! -d "$PLUGIN_SRC" ]; then
    die "plugins/opencode not found next to install.sh — run from the repository root."
  fi

# The classifier options below configure OpenCode's plugin and each agent port's
# shared config. When none of that software is installed there is nothing to
# configure and nothing to copy, so stop before prompting instead of collecting
# answers that would be discarded.
if ! have_cli opencode claude codex hermes qwen antigravity gemini pi mimocode mimo; then
  echo
  warn "No supported agent CLI found on PATH (opencode, claude, codex, hermes,"
  warn "qwen, antigravity/gemini, pi, mimocode/mimo) — nothing to install."
  exit 0
fi

# Prompt helper: reads one line, applies DEFAULT when the line is empty, and
# exits cleanly when stdin closes (EOF) instead of looping or aborting.
ask() {
  local __var="$1" __prompt="$2" __default="${3-}" __val=""
  if ! read -r -p "$__prompt" __val; then
    echo >&2
    err "No input available (stdin closed). Re-run and answer the prompts."
    exit 1
  fi
  printf -v "$__var" '%s' "${__val:-$__default}"
}

echo "${BOLD}agent-reflex setup${RESET} — the plugin needs a ${CYAN}${BOLD}System One decision model${RESET} as its classifier."
echo "It is asked through the System One endpoint at ${DIM}<baseURL>/systemone${RESET}."
echo

echo "${BOLD}Which provider serves the classifier?${RESET}"
echo "  ${CYAN}1)${RESET} ${BOLD}llamacpp${RESET}    ${DIM}local llama.cpp server${RESET}"
echo "  ${CYAN}2)${RESET} ${BOLD}ollama${RESET}      ${DIM}local Ollama (0.35 onwards)${RESET}"
echo "  ${CYAN}3)${RESET} ${BOLD}lmstudio${RESET}    ${DIM}local LM Studio (0.4.26 onwards)${RESET}"
echo "  ${CYAN}4)${RESET} ${BOLD}typesafe${RESET}    ${DIM}TypeSafe API, Jev (api.typesafe.ai)${RESET}"
echo "  ${CYAN}5)${RESET} ${BOLD}openrouter${RESET}  ${DIM}OpenRouter${RESET}"
echo "  ${CYAN}6)${RESET} ${BOLD}vercel${RESET}      ${DIM}Vercel AI Gateway${RESET}"
echo "  ${CYAN}7)${RESET} ${BOLD}opencode${RESET}    ${DIM}OpenCode Zen${RESET}"
echo "  ${CYAN}8)${RESET} ${BOLD}custom${RESET}      ${DIM}any other System One endpoint${RESET}"
ask choice "${BOLD}Provider${RESET} ${DIM}[1-8]${RESET}: "
case "$choice" in
  1) provider="llamacpp" ;;
  2) provider="ollama" ;;
  3) provider="lmstudio" ;;
  4) provider="typesafe" ;;
  5) provider="openrouter" ;;
  6) provider="vercel" ;;
  7) provider="opencode" ;;
  8) provider="custom" ;;
  *) die "Invalid choice." ;;
esac

baseURL=""
case "$provider" in
  llamacpp|ollama|lmstudio)
    ask local_yn "${BOLD}Server runs on this machine?${RESET} ${DIM}[Y/n]${RESET}: " "Y"
    if [[ ! "$local_yn" =~ ^[nN] ]]; then
      baseURL="${PRESET_URL[$provider]}"
    else
      ask baseURL "${BOLD}Base URL of the remote server, including /v1${RESET} ${DIM}(e.g. http://192.168.1.10:8080/v1)${RESET}: "
      if [ -z "$baseURL" ]; then die "A base URL is required for a remote server."; fi
    fi
    ;;
  custom)
    ask baseURL "${BOLD}Base URL of the System One endpoint, including /v1${RESET}: "
    if [ -z "$baseURL" ]; then die "A base URL is required."; fi
    ;;
  *)
    baseURL="${PRESET_URL[$provider]}"
    ;;
esac

# The custom provider has no preset entries, so both keys are read with a
# default — an unset associative-array key aborts the script under set -u.
model_default="${PRESET_MODEL[$provider]-}"
model_hint="${PRESET_HINT[$provider]-the model id served by the endpoint}"
if [ -n "$model_default" ]; then
  ask model "${BOLD}Classifier model${RESET} ${DIM}[${model_default}]${RESET}: " "$model_default"
else
  while :; do
    ask model "${BOLD}Classifier model${RESET} ${DIM}(${model_hint})${RESET}: "
    [ -n "$model" ] && break
    err "The classifier model is required."
  done
fi

case "$provider" in
  llamacpp|ollama|lmstudio)
    ask apiKey "${BOLD}API key for the server, if it requires one${RESET} ${DIM}(optional, {env:NAME} supported)${RESET}: "
    ;;
  *)
    ask apiKey "${BOLD}API key${RESET} ${DIM}({env:NAME} supported, e.g. {env:TYPESAFE_API_KEY})${RESET}: "
    if [ -z "$apiKey" ]; then
      warn "No key given — ${BOLD}${provider}${RESET} normally requires one; add ${BOLD}\"apiKey\"${RESET} later if calls fail."
    fi
    ;;
esac

ask fallbackModel "${BOLD}Fallback classifier model on the same endpoint, retried if the primary rejects requests${RESET} ${DIM}(optional)${RESET}: "
ask debugLog "${BOLD}Debug log file for outgoing request bodies${RESET} ${DIM}(optional, blank to skip)${RESET}: "

# ---------------------------------------------------------------
# Install the plugin files, the skill, and merge the config entry.
# ---------------------------------------------------------------
# OpenCode's own plugin is only written when the opencode CLI is present; the
# skill and the detected agent ports are installed regardless.
if have_cli opencode; then
  update_files
fi
install_skill

# Agent ports: register each plugin and write its shared classifier config. The
# answers collected above are passed via _AR_* so every agent shares one config.
_AR_PROVIDER="$provider" _AR_BASEURL="$baseURL" _AR_MODEL="$model" \
_AR_APIKEY="$apiKey" _AR_FALLBACK="$fallbackModel" _AR_DEBUG="$debugLog" \
  install_agent_ports

make_entry() {
  PLUGIN_PROVIDER="$provider" \
  PLUGIN_BASEURL="$baseURL" \
  PLUGIN_MODEL="$model" \
  PLUGIN_API_KEY="$apiKey" \
  PLUGIN_FALLBACK_MODEL="$fallbackModel" \
  PLUGIN_DEBUG_LOG="$debugLog" \
  CONFIG_FILE="$CONFIG_FILE" \
  MSG_PREFIX="${BOLD}${CYAN}[agent-reflex]${RESET}: " \
  MSG_ERROR_PREFIX="${BOLD}${RED}[agent-reflex]${RESET}: " \
  $JS_RUNTIME '
(async () => {
    const fs = await import("node:fs");
    const options = {
      provider: process.env.PLUGIN_PROVIDER,
      ...(process.env.PLUGIN_BASEURL ? { baseURL: process.env.PLUGIN_BASEURL } : {}),
      model: process.env.PLUGIN_MODEL,
      ...(process.env.PLUGIN_API_KEY ? { apiKey: process.env.PLUGIN_API_KEY } : {}),
      ...(process.env.PLUGIN_FALLBACK_MODEL ? { fallbackModel: process.env.PLUGIN_FALLBACK_MODEL } : {}),
      ...(process.env.PLUGIN_DEBUG_LOG ? { debugLog: process.env.PLUGIN_DEBUG_LOG } : {}),
    };
    // The entry block keeps the 2-space indentation JSON.stringify produces;
    // each use site shifts it to the depth of its own "plugins" array.
    const entry = JSON.stringify({ package: "./plugins/reflex", options }, null, 2);
    const padLines = (block, pad) => block.split("\n").map((l) => pad + l).join("\n");
    // Reads the string starting at src[start] (the opening quote) and returns
    // the index just past its closing quote, honoring escapes.
    const stringEnd = (src, start) => {
      let j = start + 1;
      while (j < src.length && src[j] !== "\"") j += src[j] === "\\" ? 2 : 1;
      return j + 1;
    };
    // String- and comment-aware scan of a JSONC source: reports where the last
    // real character ends (comments and blank space excluded), which "}" closes
    // the root object, and where the ROOT-LEVEL "plugins" array lives (key
    // index, its "[" and the matching "]"), so none of them can be fooled by
    // brackets, commas or a "plugins" label that only appear inside comments or
    // strings. A nested "plugins" array (inside a provider block, say) is not
    // the array the entry belongs to and is ignored.
    const scanJsonc = (src) => {
      let i = 0, lastReal = 0, rootClose = -1, depth = 0;
      let pluginsKey = -1, pluginsOpen = -1, pluginsClose = -1;
      while (i < src.length) {
        const c = src[i];
        if (c === "\"") {
          const end = stringEnd(src, i);
          if (depth === 1 && pluginsOpen === -1 && src.slice(i + 1, end - 1) === "plugins") {
            let j = end;
            while (j < src.length && /\s/.test(src[j])) j += 1;
            if (src[j] === ":") {
              j += 1;
              while (j < src.length && /\s/.test(src[j])) j += 1;
              if (src[j] === "[") {
                pluginsKey = i;
                pluginsOpen = j;
                let k = j + 1, sq = 1;
                while (k < src.length && sq > 0) {
                  const d = src[k];
                  if (d === "\"") { k = stringEnd(src, k); continue; }
                  if (d === "/" && src[k + 1] === "/") { while (k < src.length && src[k] !== "\n") k += 1; continue; }
                  if (d === "/" && src[k + 1] === "*") { k += 2; while (k < src.length && !(src[k] === "*" && src[k + 1] === "/")) k += 1; k += 2; continue; }
                  if (d === "[") sq += 1;
                  if (d === "]") sq -= 1;
                  k += 1;
                }
                pluginsClose = sq === 0 ? k - 1 : -1;
              }
            }
          }
          i = end;
          lastReal = i;
          continue;
        }
        if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
        if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1; i += 2; continue; }
        i += 1;
        if (/\s/.test(c)) continue;
        lastReal = i;
        if (c === "{") depth += 1;
        if (c === "}" && --depth === 0 && rootClose === -1) rootClose = i - 1;
      }
      return { lastReal, rootClose, pluginsKey, pluginsOpen, pluginsClose };
    };
    // Blanks out comments while keeping every byte position and newline, with
    // the same string awareness as the scan, so structure tests cannot be
    // fooled by text that only appears inside a comment.
    const maskComments = (src) => {
      let out = "", i = 0;
      while (i < src.length) {
        const c = src[i];
        if (c === "\"") {
          const end = stringEnd(src, i);
          out += src.slice(i, end);
          i = end;
          continue;
        }
        if (c === "/" && src[i + 1] === "/") {
          while (i < src.length && src[i] !== "\n") { out += " "; i += 1; }
          continue;
        }
        if (c === "/" && src[i + 1] === "*") {
          const start = i;
          i += 2;
          while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
          i += 2;
          out += src.slice(start, i).replace(/[^\n]/g, " ");
          continue;
        }
        out += c;
        i += 1;
      }
      return out;
    };
    // Moves a closing bracket or brace to a line of its own when it is glued to
    // the end of the line before it, indenting the new line with `indent`. A
    // closer that already sits on its own line keeps the indentation it has.
    const closeOnOwnLine = (src, closeAt, indent) => {
      const lineStart = src.lastIndexOf("\n", closeAt) + 1;
      if (/^[ \t]*$/.test(src.slice(lineStart, closeAt))) return src;
      return src.slice(0, closeAt).replace(/[ \t]+$/, "") + "\n" + indent + src.slice(closeAt);
    };

    const path = process.env.CONFIG_FILE || "";
    let text = path && fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";

    if (text.trim() === "") {
      fs.writeFileSync(path, `{\n  "plugins": [\n${padLines(entry, "    ")}\n  ]\n}\n`);
    } else {
      let scan = scanJsonc(text);
      if (scan.pluginsOpen !== -1) {
        if (scan.pluginsClose === -1) {
          console.error(`${process.env.MSG_ERROR_PREFIX}The "plugins" array is never closed — fix the config by hand.`);
          process.exit(1);
        }
        // Insert as the first entry of the existing root "plugins" array,
        // keeping the file textual (comments and formatting are preserved).
        const open = scan.pluginsOpen + 1;
        const lineStart = text.lastIndexOf("\n", scan.pluginsKey) + 1;
        const lineEnd = text.indexOf("\n", scan.pluginsKey);
        const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
        const baseIndent = (/^([ \t]*)/.exec(line) || ["", ""])[1] || "";
        const indent = baseIndent + "  ";
        // An array holding nothing but comments counts as empty: the entry goes
        // between the brackets without a comma.
        const empty = /^\s*$/.test(maskComments(text.slice(open, scan.pluginsClose)));
        text = text.slice(0, open) + "\n" + padLines(entry, indent) + (empty ? "" : ",") + text.slice(open);
        // The closing bracket of the array does not share its line with the
        // entry (or the last element) before it: it gets its own line at the
        // indentation of the "plugins" key.
        scan = scanJsonc(text);
        if (scan.pluginsClose !== -1) {
          text = closeOnOwnLine(text, scan.pluginsClose, baseIndent);
        }
      } else {
        // No plugins key: add one before the root closing brace. The comma goes
        // after the last real value — never after a comment — and a trailing
        // comma (or an empty root object) must not produce a double comma.
        const trimmed = text.replace(/\s+$/, "");
        const rootClose = scanJsonc(trimmed).rootClose;
        if (rootClose === -1) {
          console.error(`${process.env.MSG_ERROR_PREFIX}Config file has no closing brace — not a JSON object?`);
          process.exit(1);
        }
        const core = trimmed.slice(0, rootClose).replace(/\s+$/, "");
        const lastReal = scanJsonc(core).lastReal;
        const prev = core[lastReal - 1];
        const comma = lastReal > 0 && prev !== "," && prev !== "{" ? "," : "";
        // The root closing brace keeps its own line and the indentation it
        // already had there; glued to the line before (minified or inline) it
        // closes at the indentation of the first line of the file.
        const braceLineStart = trimmed.lastIndexOf("\n", rootClose) + 1;
        const bracePrefix = trimmed.slice(braceLineStart, rootClose);
        const firstIndent = (/^[ \t]*/.exec(text) || [""])[0] || "";
        const closeIndent = /^[ \t]*$/.test(bracePrefix) ? bracePrefix : firstIndent;
        const head =
          core.slice(0, lastReal) + comma + core.slice(lastReal) +
          `\n  "plugins": [\n${padLines(entry, "    ")}\n  ]`;
        text = closeOnOwnLine(head + trimmed.slice(rootClose), head.length, closeIndent) + "\n";
      }
      // Whichever branch spliced the text, the root closing brace does not
      // share its line with the "]" before it (a minified file arrives that
      // way): move it to a line of its own.
      const mergedClose = scanJsonc(text).rootClose;
      if (mergedClose !== -1) {
        text = closeOnOwnLine(text, mergedClose, (/^[ \t]*/.exec(text) || [""])[0] || "");
      }
      // Validate before committing: back up, strip comments and trailing
      // commas, and make sure the merged file still parses.
      fs.copyFileSync(path, path + ".agent-reflex.bak");
      fs.writeFileSync(path, text);
      const stripJsonc = (src) => {
        let out = "", i = 0, inString = false;
        while (i < src.length) {
          const c = src[i];
          if (inString) {
            out += c;
            if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
            if (c === "\"") inString = false;
            i += 1;
            continue;
          }
          if (c === "\"") { inString = true; out += c; i += 1; continue; }
          if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
          if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1; i += 2; continue; }
          out += c;
          i += 1;
        }
        return out.replace(/,\s*([\]}])/g, "$1");
      };
      try {
        JSON.parse(stripJsonc(fs.readFileSync(path, "utf8")));
      } catch (error) {
        fs.copyFileSync(path + ".agent-reflex.bak", path);
        console.error(`${process.env.MSG_ERROR_PREFIX}Merged config failed validation (${error.message}) — original restored, backup kept at ${path}.agent-reflex.bak`);
        process.exit(1);
      }
    }
    console.log(`${process.env.MSG_PREFIX}Plugin entry added to ${path || "(new config file)"}`);
})().catch((error) => {
  console.error(`${process.env.MSG_ERROR_PREFIX}${(error && error.message) || error}`);
  process.exit(1);
});
  '
}

manual_entry() {
  # Optional fields are built separately and printed with %b so their \n
  # escapes are honored; printf arguments do not interpret escape sequences.
  local opt_api="" opt_fallback="" opt_debug=""
  [ -n "$apiKey" ] && opt_api=',\n      "apiKey": "'"$apiKey"'"'
  [ -n "$fallbackModel" ] && opt_fallback=',\n      "fallbackModel": "'"$fallbackModel"'"'
  [ -n "$debugLog" ] && opt_debug=',\n      "debugLog": "'"$debugLog"'"'
  echo
  warn "The config entry must be added by hand. Add this object to"
  echo "the ${BOLD}\"plugins\"${RESET} array in ${DIM}${CONFIG_FILE:-$CONFIG_DIR/opencode.json}${RESET}"
  echo "(create the file with { ${BOLD}\"plugins\"${RESET}: [...] } if absent):"
  echo
  printf '%s  {\n    "package": "./plugins/reflex",\n    "options": {\n      "provider": "%s",\n      "baseURL": "%s",\n      "model": "%s"%b%b%b\n    }\n  }\n%s' \
    "$CYAN" "$provider" "$baseURL" "$model" "$opt_api" "$opt_fallback" "$opt_debug" "$RESET"
  echo
  msg "Then restart OpenCode ${BOLD}(opencode service restart)${RESET} to load the plugin."
}

merged=0
if have_cli opencode; then
  if [ -n "$JS_RUNTIME" ]; then
    if [ -z "$CONFIG_FILE" ]; then
      CONFIG_FILE="$CONFIG_DIR/opencode.json"
    fi
    if CONFIG_FILE="$CONFIG_FILE" make_entry; then
      merged=1
    fi
  else
    echo
    warn "No JS runtime found (bun, node or deno) — plugin files are installed,"
    echo "but the config entry could not be merged automatically."
  fi

  if [ "$merged" = 1 ]; then
    echo
    msg "${BOLD}${GREEN}Installed.${RESET} Restart OpenCode ${BOLD}(opencode service restart)${RESET} to load the plugin."
    # Only mention the agent ports that were actually installed (their CLI is present).
    if have_cli claude && have_cli codex; then
      msg "The Claude Code and Codex ports are under ${DIM}~/.claude/plugins/agent-reflex${RESET} and ${DIM}~/.codex/plugins/agent-reflex${RESET} — register them with their CLIs if not already enabled."
    elif have_cli claude; then
      msg "The Claude Code port is under ${DIM}~/.claude/plugins/agent-reflex${RESET} — register it with the claude CLI if not already enabled."
    elif have_cli codex; then
      msg "The Codex port is under ${DIM}~/.codex/plugins/agent-reflex${RESET} — register it with the codex CLI if not already enabled."
    fi
  else
    manual_entry
  fi
else
  # No OpenCode on this machine: its plugin copy and config entry are skipped
  # entirely (silent, like the other absent agents). The skill and any detected
  # agent ports were still installed above.
  echo
  msg "${BOLD}${GREEN}Installed.${RESET}"
fi
