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

let configCache: Config | undefined;

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
      configCache = typeof parsed === "object" && parsed !== null ? (parsed as Config) : {};
      return configCache;
    } catch {
      // keep looking / fall through to empty
    }
  }
  configCache = {};
  return configCache as Config;
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

// Batched System One query: one request carrying a question per id, so a whole
// tool set is scored in a single round-trip. Same wire shape as askModel but with
// a key per id; the response is read per key (answers.<id>.noul). Returns a map of
// id -> P(YES) in [0, 1]. Ids the backend did not answer are omitted, letting a
// caller detect a single-question-only backend and fall back rather than treat
// silence as "not relevant".
async function askModelMany(state: string, questionsById: Record<string, string>, model: string): Promise<Record<string, number>> {
  const ids = Object.keys(questionsById);
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;

  const base = baseUrl();
  if (!base || !model) return out;
  const key = resolveEnv(config("apiKey")) || undefined;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const questions: Record<string, { type: string; instructions: string }> = {};
  for (const id of ids) questions[id] = { type: "noul", instructions: questionsById[id] };

  let data: any;
  try {
    const resp = await fetch(`${base}/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return out;
    data = await resp.json();
  } catch {
    return out;
  }

  for (const id of ids) {
    const value = Number(data?.answers?.[id]?.noul);
    if (Number.isFinite(value)) out[id] = Math.min(1, Math.max(0, value));
  }
  return out;
}

// Asks the classifier many questions in one call, falling back to fallbackModel
// when the primary returns nothing. Returns a map of id -> P(YES); ids with no
// usable answer are absent. Fails open to {} when the classifier is unavailable.
export async function arAskMany(state: string, questionsById: Record<string, string>): Promise<Record<string, number>> {
  const model = config("model");
  if (!model) return {};

  const primary = await askModelMany(state, questionsById, model);
  if (Object.keys(primary).length > 0) return primary;

  const fallback = config("fallbackModel");
  if (fallback && fallback !== model) {
    return askModelMany(state, questionsById, fallback);
  }
  return primary;
}

// A "choice" decision: pick one option from named criteria. Returns the chosen
// key plus per-option probabilities and an overall confidence, or null when the
// classifier is unavailable. This is the primitive Reflex uses to select which
// sub-tool to dispatch (the decision model picks the tool in one forward pass).
export interface ChoiceAnswer {
  choice: string | null;
  probabilities: Record<string, number>;
  confidence: number | null;
}

async function askChoice(
  state: string,
  question: string,
  criteria: Record<string, string>,
  model: string,
): Promise<ChoiceAnswer | null> {
  const base = baseUrl();
  if (!base || !model || Object.keys(criteria).length === 0) return null;
  const key = resolveEnv(config("apiKey")) || undefined;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const body = JSON.stringify({
    model,
    state,
    questions: { q: { type: "choice", instructions: question, criteria } },
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

  const answer = data?.answers?.q;
  if (!answer || answer.type !== "choice") return null;
  const probabilities: Record<string, number> = {};
  if (answer.probabilities && typeof answer.probabilities === "object") {
    for (const [k, v] of Object.entries(answer.probabilities)) {
      const n = Number(v);
      if (Number.isFinite(n)) probabilities[k] = n;
    }
  }
  return {
    choice: typeof answer.choice === "string" ? answer.choice : null,
    probabilities,
    confidence: Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : null,
  };
}

// Asks a "choice" question, falling back to fallbackModel when the primary gives
// no usable answer. Uses the configured model (like every other classifier call).
// Fails open to null when the classifier is unavailable.
export async function arAskChoice(state: string, question: string, criteria: Record<string, string>): Promise<ChoiceAnswer | null> {
  const model = config("model");
  if (!model) return null;

  const primary = await askChoice(state, question, criteria, model);
  if (primary && primary.choice) return primary;

  const fallback = config("fallbackModel");
  if (fallback && fallback !== model) {
    return askChoice(state, question, criteria, fallback);
  }
  return primary;
}

// Batched "choice" decisions: one request carrying a question per id, each with
// its own criteria, answered in a single round-trip. Used by history compaction to
// extract every digest bucket at once. Ids the backend did not answer are omitted,
// so a caller can tell a backend that only honors a single question and degrade
// gracefully. Falls back to fallbackModel when the primary returns nothing usable.
// Fails open to {} when the classifier is unavailable.
export async function arAskChoiceMany(
  state: string,
  questionsById: Record<string, { instructions: string; criteria: Record<string, string> }>,
): Promise<Record<string, ChoiceAnswer>> {
  const model = config("model");
  if (!model) return {};

  const primary = await askChoiceMany(state, questionsById, model);
  if (Object.keys(primary).length > 0) return primary;

  const fallback = config("fallbackModel");
  if (fallback && fallback !== model) {
    return (await askChoiceMany(state, questionsById, fallback)) ?? {};
  }
  return primary;
}

async function askChoiceMany(
  state: string,
  questionsById: Record<string, { instructions: string; criteria: Record<string, string> }>,
  model: string,
): Promise<Record<string, ChoiceAnswer>> {
  const ids = Object.keys(questionsById);
  const out: Record<string, ChoiceAnswer> = {};
  if (ids.length === 0) return out;

  const base = baseUrl();
  if (!base || !model) return out;
  const key = resolveEnv(config("apiKey")) || undefined;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const questions: Record<string, any> = {};
  for (const id of ids) {
    questions[id] = { type: "choice", instructions: questionsById[id].instructions, criteria: questionsById[id].criteria };
  }

  let data: any;
  try {
    const resp = await fetch(`${base}/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return out;
    data = await resp.json();
  } catch {
    return out;
  }

  for (const id of ids) {
    const answer = data?.answers?.[id];
    if (!answer || answer.type !== "choice") continue;
    const probabilities: Record<string, number> = {};
    if (answer.probabilities && typeof answer.probabilities === "object") {
      for (const [k, v] of Object.entries(answer.probabilities)) {
        const n = Number(v);
        if (Number.isFinite(n)) probabilities[k] = n;
      }
    }
    out[id] = {
      choice: typeof answer.choice === "string" ? answer.choice : null,
      probabilities,
      confidence: Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : null,
    };
  }
  return out;
}
