#!/usr/bin/env bash
# agent-reflex installer.
#
# First run: interactively walks through the classifier (System One) options,
# copies the plugin into OpenCode's config directory, installs the repo's
# agent skill (agent-reflex) when it is not installed yet, adds the plugin
# entry to the OpenCode config, and installs the Claude Code port
# (plugins/claude-code) when the Claude Code CLI is present. Re-running only
# updates the plugin files: an existing installation (plugin copy or config
# entry) is detected, the configured options and an already-installed skill are
# left untouched, and a missing skill is still installed.
#
# Requires bash and, for the automatic config merge, bun, node (bundled with
# npm) or deno — the plugin needs a JS/TS runtime to load anyway. Without any
# of them the plugin entry is printed for a manual paste instead.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$REPO_DIR/plugins/opencode"
CC_PLUGIN_SRC="$REPO_DIR/plugins/claude-code"
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
skill_installed() {
  [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/agent-reflex/SKILL.md" ] && return 0
  [ -f "$HOME/.agents/skills/agent-reflex/SKILL.md" ] && return 0
  [ -f "$HOME/.claude/skills/agent-reflex/SKILL.md" ] && return 0
  return 1
}

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
  if skill_installed; then
    msg "Skill agent-reflex already installed — left untouched."
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
# CLAUDE CODE PORT (plugins/claude-code).
# ---------------------------------------------------------------
# Claude Code plugins load from a local directory or a marketplace. This
# installer keeps one installation path: it copies the plugin into the user's
# ~/.claude/plugins source directory and, when the claude CLI is available,
# registers it there so hooks load. The classifier config is written to
# agent-reflex.jsonc in the plugin root (same option names as the OpenCode
# plugin), so the user configures the classifier once and both agents share it.
CC_DEST="$HOME/.claude/plugins/agent-reflex"
CC_CONFIG="$CC_DEST/agent-reflex.jsonc"

update_cc_files() {
  [ -d "$CC_PLUGIN_SRC" ] || return 0
  mkdir -p "$CC_DEST"
  # Preserve an existing classifier config across the copy (the source tree has
  # no agent-reflex.jsonc, but a future sample must never clobber the real one).
  local keep=""
  if [ -f "$CC_CONFIG" ]; then
    keep="$(mktemp)"
    cp "$CC_CONFIG" "$keep"
  fi
  cp -R "$CC_PLUGIN_SRC"/. "$CC_DEST"/
  if [ -n "$keep" ]; then
    cp "$keep" "$CC_CONFIG"
    rm -f "$keep"
  fi
  chmod +x "$CC_DEST"/scripts/*.sh 2>/dev/null || true
  msg "Claude Code plugin files copied to ${DIM}${CC_DEST}${RESET}"
}

# Writes agent-reflex.jsonc from the same classifier answers used for OpenCode,
# but only when absent — an existing config is left untouched. When the answers
# are not available (update mode), the file is simply left alone.
write_cc_config() {
  [ -n "${1:-}" ] || return 0           # provider (empty => update mode, skip)
  if [ -f "$CC_CONFIG" ]; then
    msg "Claude Code classifier config left untouched (${DIM}${CC_CONFIG}${RESET})"
    return 0
  fi
  mkdir -p "$CC_DEST"
  {
    echo "{"
    echo "  // System One classifier shared with the OpenCode plugin."
    echo "  // Option names match plugins/opencode (provider/baseURL/model/apiKey/...)."
    printf '  "provider": "%s",\n' "$1"
    [ -n "${2:-}" ] && printf '  "baseURL": "%s",\n' "$2"
    [ -n "${3:-}" ] && printf '  "model": "%s",\n' "$3"
    [ -n "${4:-}" ] && printf '  "apiKey": "%s",\n' "$4"
    [ -n "${5:-}" ] && printf '  "fallbackModel": "%s",\n' "$5"
    [ -n "${6:-}" ] && printf '  "debugLog": "%s",\n' "$6"
    echo "}"
  } > "$CC_CONFIG" 2>/dev/null
  # Trim a possible trailing comma on the last line before "}".
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CC_CONFIG" <<'PY' 2>/dev/null || true
import re, sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
s = re.sub(r',(\s*[}\]])', r'\1', s)
open(p, "w", encoding="utf-8").write(s)
PY
  fi
  msg "Claude Code classifier config written to ${DIM}${CC_CONFIG}${RESET}"
}

# Registers the plugin with the claude CLI when present. The exact install
# command varies by CLI version, so this tries the plugin-dir route and, if the
# CLI is absent or the command differs, prints clear manual steps instead of
# failing the whole install.
install_cc() {
  [ -d "$CC_PLUGIN_SRC" ] || { warn "plugins/claude-code not found — skipping Claude Code install."; return 0; }
  update_cc_files
  if ! command -v claude >/dev/null 2>&1; then
    warn "Claude Code CLI (claude) not found — plugin files are copied to"
    warn "  ${CC_DEST}"
    warn "but not registered. Enable it from Claude Code with:"
    warn "  claude plugin install ${CC_DEST}"
    return 0
  fi
  local out
  if out=$(claude plugin install "$CC_DEST" 2>&1); then
    msg "Claude Code plugin registered through the claude CLI."
  else
    warn "Claude Code plugin copied but not registered (the claude CLI install"
    warn "command differed). Register it manually from Claude Code:"
    warn "  claude plugin install ${CC_DEST}"
    printf '%s\n' "$out" | sed 's/^/  /'
  fi
}

# ---------------------------------------------------------------
# UPDATE MODE: an existing installation is only brought up to date.
# ---------------------------------------------------------------
if [ -f "$PLUGIN_DEST/index.ts" ] || { [ -n "$CONFIG_FILE" ] && grep -q 'plugins/reflex' "$CONFIG_FILE"; }; then
  update_files
  install_skill
  install_cc
  msg "Existing installation detected — options left untouched."
  msg "Restart OpenCode ${BOLD}(opencode service restart)${RESET} to reload the plugin."
  exit 0
fi

# ---------------------------------------------------------------
# FRESH INSTALL: ask for the classifier options.
# ---------------------------------------------------------------
  if [ ! -d "$PLUGIN_SRC" ]; then
    die "plugins/opencode not found next to install.sh — run from the repository root."
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

model_default="${PRESET_MODEL[$provider]}"
if [ -n "$model_default" ]; then
  ask model "${BOLD}Classifier model${RESET} ${DIM}[${model_default}]${RESET}: " "$model_default"
else
  while :; do
    ask model "${BOLD}Classifier model${RESET} ${DIM}(${PRESET_HINT[$provider]})${RESET}: "
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
update_files
install_skill

# Claude Code port: register the plugin, then write the shared classifier config.
install_cc
write_cc_config "$provider" "$baseURL" "$model" "$apiKey" "$fallbackModel" "$debugLog"

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
    // Every line of the entry is indented by 4 spaces: it lands inside the
    // "plugins": [ ... ] array whose elements sit at that depth.
    const entry = JSON.stringify({ package: "./plugins/reflex", options }, null, 2)
      .split("\n").map((l) => "    " + l).join("\n");

    const path = process.env.CONFIG_FILE || "";
    let text = path && fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";

    if (text.trim() === "") {
      fs.writeFileSync(path, `{\n  "plugins": [\n${entry}\n  ]\n}\n`);
    } else {
      const m = /"plugins"\s*:\s*\[/.exec(text);
      if (m && m.index !== undefined) {
        // Insert as the first entry of the existing plugins array, keeping the
        // file textual (comments and formatting are preserved).
        const open = m.index + m[0].length;
        const rest = text.slice(open);
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        const lineEnd = text.indexOf("\n", m.index);
        const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
        const baseIndent = (/^([ \t]*)/.exec(line) || ["", ""])[1] || "";
        const indent = baseIndent + "  ";
        if (/^\s*\]/.test(rest)) {
          text = text.slice(0, open) + `\n${indent}${entry}\n${baseIndent}` + text.slice(open);
        } else {
          text = text.slice(0, open) + `\n${indent}${entry},` + text.slice(open);
        }
      } else {
        // No plugins key: add one before the root closing brace. A trailing
        // comma (or an empty root object) must not produce a double comma.
        const trimmed = text.replace(/\s+$/, "");
        const lastBrace = trimmed.lastIndexOf("}");
        if (lastBrace === -1) {
          console.error(`${process.env.MSG_ERROR_PREFIX}Config file has no closing brace — not a JSON object?`);
          process.exit(1);
        }
        const core = trimmed.slice(0, lastBrace).replace(/\s+$/, "");
        const comma = core.endsWith(",") || core === "{" ? "" : ",";
        text =
          core + comma +
          `\n  "plugins": [\n${entry}\n  ]` +
          trimmed.slice(lastBrace) + "\n";
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
  msg "The Claude Code port is at ${DIM}${CC_DEST}${RESET} — enable it from Claude Code if it is not already registered."
else
  manual_entry
fi
