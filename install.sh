#!/usr/bin/env bash
# agent-reflex installer.
#
# First run: interactively walks through the classifier (System One) options,
# copies the plugin into OpenCode's config directory and adds the plugin entry
# to the OpenCode config. Re-running only updates the plugin files: an existing
# installation (plugin copy or config entry) is detected and the configured
# options are left untouched.
#
# Requires bash and, for the automatic config merge, bun (the plugin needs a
# JS/TS runtime to load anyway). Without bun the plugin entry is printed for a
# manual paste instead.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$REPO_DIR/plugins/reflex"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DEST="$CONFIG_DIR/plugins/reflex"

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

# Pick the existing config file, or default to opencode.json for a fresh one.
CONFIG_FILE=""
for f in opencode.json opencode.jsonc; do
  if [ -f "$CONFIG_DIR/$f" ]; then
    CONFIG_FILE="$CONFIG_DIR/$f"
    break
  fi
done

update_files() {
  mkdir -p "$PLUGIN_DEST"
  cp "$PLUGIN_SRC"/*.ts "$PLUGIN_DEST"/
  echo "[agent-reflex]: Plugin files updated in $PLUGIN_DEST"
}

# ---------------------------------------------------------------
# UPDATE MODE: an existing installation is only brought up to date.
# ---------------------------------------------------------------
if [ -f "$PLUGIN_DEST/index.ts" ] || { [ -n "$CONFIG_FILE" ] && grep -q 'plugins/reflex' "$CONFIG_FILE"; }; then
  update_files
  echo "[agent-reflex]: Existing installation detected — options left untouched."
  echo "[agent-reflex]: Restart OpenCode (opencode service restart) to reload the plugin."
  exit 0
fi

# ---------------------------------------------------------------
# FRESH INSTALL: ask for the classifier options.
# ---------------------------------------------------------------
if [ ! -d "$PLUGIN_SRC" ]; then
  echo "[agent-reflex]: plugins/reflex not found next to install.sh — run from the repository root." >&2
  exit 1
fi

echo "agent-reflex setup — the plugin needs a System One decision model as its classifier."
echo "It is asked through the System One endpoint at <baseURL>/systemone."
echo

echo "Which provider serves the classifier?"
echo "  1) llamacpp    local llama.cpp server"
echo "  2) ollama      local Ollama (0.35 onwards)"
# Prompt helper: reads one line, applies DEFAULT when the line is empty, and
# exits cleanly when stdin closes (EOF) instead of looping or aborting.
ask() {
  local __var="$1" __prompt="$2" __default="${3-}" __val=""
  if ! read -r -p "$__prompt" __val; then
    echo >&2
    echo "[agent-reflex]: No input available (stdin closed). Re-run and answer the prompts." >&2
    exit 1
  fi
  printf -v "$__var" '%s' "${__val:-$__default}"
}

echo "  3) lmstudio    local LM Studio (0.4.26 onwards)"
echo "  4) typesafe    TypeSafe API, Jev (api.typesafe.ai)"
echo "  5) openrouter  OpenRouter"
echo "  6) vercel      Vercel AI Gateway"
echo "  7) opencode    OpenCode Zen"
echo "  8) custom      any other System One endpoint"
ask choice "Provider [1-8]: "
case "$choice" in
  1) provider="llamacpp" ;;
  2) provider="ollama" ;;
  3) provider="lmstudio" ;;
  4) provider="typesafe" ;;
  5) provider="openrouter" ;;
  6) provider="vercel" ;;
  7) provider="opencode" ;;
  8) provider="custom" ;;
  *) echo "Invalid choice." >&2; exit 1 ;;
esac

baseURL=""
case "$provider" in
  llamacpp|ollama|lmstudio)
    ask local_yn "Server runs on this machine? [Y/n]: " "Y"
    if [[ ! "$local_yn" =~ ^[nN] ]]; then
      baseURL="${PRESET_URL[$provider]}"
    else
      ask baseURL "Base URL of the remote server, including /v1 (e.g. http://192.168.1.10:8080/v1): "
      if [ -z "$baseURL" ]; then echo "A base URL is required for a remote server." >&2; exit 1; fi
    fi
    ;;
  custom)
    ask baseURL "Base URL of the System One endpoint, including /v1: "
    if [ -z "$baseURL" ]; then echo "A base URL is required." >&2; exit 1; fi
    ;;
  *)
    baseURL="${PRESET_URL[$provider]}"
    ;;
esac

model_default="${PRESET_MODEL[$provider]}"
if [ -n "$model_default" ]; then
  ask model "Classifier model [$model_default]: " "$model_default"
else
  while :; do
    ask model "Classifier model (${PRESET_HINT[$provider]}): "
    [ -n "$model" ] && break
    echo "The classifier model is required." >&2
  done
fi

case "$provider" in
  llamacpp|ollama|lmstudio)
    ask apiKey "API key for the server, if it requires one (optional, {env:NAME} supported): "
    ;;
  *)
    ask apiKey "API key ({env:NAME} supported, e.g. {env:TYPESAFE_API_KEY}): "
    if [ -z "$apiKey" ]; then
      echo "[agent-reflex]: No key given — $provider normally requires one; add \"apiKey\" later if calls fail."
    fi
    ;;
esac

ask fallbackModel "Fallback classifier model on the same endpoint, retried if the primary rejects requests (optional): "
ask debugLog "Debug log file for outgoing request bodies (optional, blank to skip): "

# ---------------------------------------------------------------
# Install the plugin files and merge the config entry.
# ---------------------------------------------------------------
update_files

make_entry() {
  PLUGIN_PROVIDER="$provider" \
  PLUGIN_BASEURL="$baseURL" \
  PLUGIN_MODEL="$model" \
  PLUGIN_API_KEY="$apiKey" \
  PLUGIN_FALLBACK_MODEL="$fallbackModel" \
  PLUGIN_DEBUG_LOG="$debugLog" \
  CONFIG_FILE="$CONFIG_FILE" \
  bun -e '
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
    const fs = require("node:fs");
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
          console.error("[agent-reflex]: Config file has no closing brace — not a JSON object?");
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
        console.error(`[agent-reflex]: Merged config failed validation (${error.message}) — original restored, backup kept at ${path}.agent-reflex.bak`);
        process.exit(1);
      }
    }
    console.log(`[agent-reflex]: Plugin entry added to ${path || "(new config file)"}`);
  '
}

manual_entry() {
  echo
  echo "[agent-reflex]: The config entry must be added by hand. Add this object to"
  echo "the \"plugins\" array in ${CONFIG_FILE:-$CONFIG_DIR/opencode.json}"
  echo "(create the file with { \"plugins\": [...] } if absent):"
  echo
  printf '  {\n    "package": "./plugins/reflex",\n    "options": {\n      "provider": "%s",\n      "baseURL": "%s",\n      "model": "%s"%s%s%s\n    }\n  }\n' \
    "$provider" "$baseURL" "$model" \
    "${apiKey:+,\n      \"apiKey\": \"$apiKey\"}" \
    "${fallbackModel:+,\n      \"fallbackModel\": \"$fallbackModel\"}" \
    "${debugLog:+,\n      \"debugLog\": \"$debugLog\"}"
  echo
  echo "[agent-reflex]: Then restart OpenCode (opencode service restart) to load the plugin."
}

merged=0
if command -v bun >/dev/null 2>&1; then
  if [ -z "$CONFIG_FILE" ]; then
    CONFIG_FILE="$CONFIG_DIR/opencode.json"
  fi
  if CONFIG_FILE="$CONFIG_FILE" make_entry; then
    merged=1
  fi
else
  echo
  echo "[agent-reflex]: bun not found — plugin files are installed, but the config"
  echo "entry could not be merged automatically."
fi

if [ "$merged" = 1 ]; then
  echo
  echo "[agent-reflex]: Installed. Restart OpenCode (opencode service restart) to load the plugin."
else
  manual_entry
fi
