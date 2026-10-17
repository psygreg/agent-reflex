// agent-reflex (Pi) — System One classifier client.
//
// Ported from the OpenCode plugin plugins/opencode/index.ts and the shell ports'
// scripts/common.sh. The classifier is a System One decision model asked through
// the System One shape (model, state, questions -> answers.q.noul) at
// <baseURL>/systemone. Configuration is read from agent-reflex.jsonc in the plugin
// root (same option names as the OpenCode plugin: provider / baseURL / model /
// apiKey / fallbackModel / debugLog).
//
// Every helper fails open: when the classifier is unavailable, callers get null
// and must let the operation proceed. The tool must never block work when the
// decision model is down.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Plugin root: the directory holding agent-reflex.jsonc (this file's directory).
const PLUGIN_ROOT = HERE;

// Classifier presets -> default base URL. Mirrors PRESET_BASE_URLS in the
// OpenCode plugin.
const PRESET_BASE_URLS: Record<string, string> = {
  llamacpp: "http://127.0.0.1:8080/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  typesafe: "https://api.typesafe.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vercel: "https://ai-gateway.vercel.sh/typesafe/v1",
  opencode: "https://opencode.ai/zen/v1",
};

const REQUEST_TIMEOUT_MS = Number(process.env.AGENT_REFLEX_TIMEOUT ?? "20000");

interface Config {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  fallbackModel?: string;
  debugLog?: string;
}

let configCache: Config | null | undefined;

// Strips // line comments (only when // begins a token) and trailing commas so
// JSON.parse can read JSONC.
function stripJsonc(text: string): string {
  return text
    .replace(/(^|[^:\"])\/\/.*/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

function loadConfig(): Config {
  if (configCache !== undefined) return configCache;
  for (const name of ["agent-reflex.jsonc", "agent-reflex.json"]) {
    const path = join(PLUGIN_ROOT, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
      configCache = typeof parsed === "object" && parsed !== null ? parsed : {};
      return configCache;
    } catch {
      // keep looking / fall through to empty
    }
  }
  configCache = {};
  return configCache;
}

export function config(key: keyof Config): string | undefined {
  return loadConfig()[key];
}

// Resolves an {env:NAME} placeholder to the environment value.
export function resolveEnv(value: string | undefined): string | undefined {
  if (typeof value === "string") {
    const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (m) return process.env[m[1]] ?? "";
  }
  return value;
}

export function baseUrl(): string {
  const base = config("baseURL");
  if (base) return base.replace(/\/+$/, "");
  const provider = config("provider") ?? "";
  return PRESET_BASE_URLS[provider] ?? "";
}

function log(message: string): void {
  const path = config("debugLog");
  if (!path) return;
  try {
    appendFileSync(path, `${message}\n`);
  } catch {
    // best effort
  }
}

export { log as arLog };

// One System One request. Returns P(YES) in [0, 1], or null on failure.
async function askModel(state: string, question: string, model: string): Promise<number | null> {
  const base = baseUrl();
  if (!base || !model) return null;
  const key = resolveEnv(config("apiKey")) || undefined;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const body = JSON.stringify({
    model,
    state,
    questions: { q: { type: "noul", instructions: question } },
  });

  let data: any;
  try {
    const resp = await fetch(`${base}/systemone`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    data = await resp.json();
  } catch {
    return null;
  }

  const value = Number(data?.answers?.q?.noul);
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

// Asks the classifier, falling back to fallbackModel when the primary rejects.
// Returns P(YES) in [0, 1], or null when the classifier is unavailable.
export async function arAsk(state: string, question: string): Promise<number | null> {
  const model = config("model");
  if (!model) return null;

  const value = await askModel(state, question, model);
  if (value !== null) return value;

  const fallback = config("fallbackModel");
  if (fallback && fallback !== model) {
    log(`Classifier model "${model}" unavailable, retrying with "${fallback}"`);
    return askModel(state, question, fallback);
  }
  return null;
}

// Maps a classifier score to a complexity level. Cut-offs match the plugin.
export function classifyLevel(score: number): "simple" | "medium" | "high" {
  if (score > 0.8) return "high";
  if (score > 0.5) return "medium";
  return "simple";
}
