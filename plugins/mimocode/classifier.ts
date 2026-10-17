// agent-reflex (MiMo Code) — System One classifier client.
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

// ---- "choice" decisions (used by history compaction's structured digest) ----
// A "choice" answer: the decision model picks one key from named criteria, plus
// per-option probabilities and an overall confidence. Mirrors the plugin's
// ChoiceAnswer.
export interface ChoiceAnswer {
  choice: string | null;
  probabilities: Record<string, number>;
  confidence: number | null;
}

function parseChoiceAnswer(answer: any): ChoiceAnswer | null {
  if (!answer || answer.type !== "choice") return null;
  const probabilities: Record<string, number> = {};
  if (answer.probabilities && typeof answer.probabilities === "object") {
    for (const [key, value] of Object.entries(answer.probabilities)) {
      const n = Number(value);
      if (Number.isFinite(n)) probabilities[key] = n;
    }
  }
  return {
    choice: typeof answer.choice === "string" ? answer.choice : null,
    probabilities,
    confidence: Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : null,
  };
}

// One batched "choice" request: a question per id, each with its own criteria,
// answered in a single round-trip. Ids the backend did not answer are omitted, so a
// caller can tell a backend that only honors a single question and degrade
// gracefully. Falls back to fallbackModel when the primary returns nothing usable.
// Returns {} on failure (fail open).
async function askChoiceMany(
  state: string,
  questionsById: Record<string, { instructions: string; criteria: Record<string, string> }>,
): Promise<Record<string, ChoiceAnswer>> {
  const ids = Object.keys(questionsById);
  if (ids.length === 0) return {};

  const base = baseUrl();
  if (!base) return {};
  const key = resolveEnv(config("apiKey")) || undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const ask = async (model: string): Promise<Record<string, ChoiceAnswer> | null> => {
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
      if (!resp.ok) return null;
      data = await resp.json();
    } catch {
      return null;
    }
    const out: Record<string, ChoiceAnswer> = {};
    for (const id of ids) {
      const parsed = parseChoiceAnswer(data?.answers?.[id]);
      if (parsed) out[id] = parsed;
    }
    return out;
  };

  let primary: Record<string, ChoiceAnswer> | null = null;
  try {
    primary = await ask(config("model") ?? "");
  } catch {
    primary = null;
  }
  if (primary && Object.keys(primary).length > 0) return primary;

  const fallback = config("fallbackModel");
  const model = config("model");
  if (fallback && fallback !== model) {
    try {
      return (await ask(fallback)) ?? {};
    } catch {
      return primary ?? {};
    }
  }
  return primary ?? {};
}

// ---- history compaction digest (ported from the plugin) ----
// The structured digest buckets: the recurring kinds of fact a coding session
// establishes and later work depends on. Each bucket carries theme keywords used to
// select candidate sentences from the tail; for each bucket, the tail's own matching
// sentences become "choice" candidates and the classifier picks the most
// representative one, so the digest preserves the SPECIFIC fact rather than merely
// noting the topic came up. Mirrors DIGEST_BUCKETS in the plugin.
export interface DigestBucket {
  description: string;
  keywords: string[];
}
export const DIGEST_BUCKETS: Record<string, DigestBucket> = {
  goal: { description: "The overall task goal, objective, or problem being solved", keywords: ["goal", "objective", "task is", "we need to", "trying to", "aim", "problem is"] },
  architecture: { description: "Architectural structure, module boundaries, or a chosen design/approach", keywords: ["architect", "design", "structure", "module", "component", "pattern", "layer", "service", "pipeline"] },
  requirements: { description: "Functional or non-functional requirements, scope, or acceptance criteria", keywords: ["requirement", "must", "should", "needs to", "scope", "acceptance", "criteria", "expected"] },
  constraints: { description: "Named constraints, rules, standards, or 'must/must not' decisions to honor", keywords: ["constraint", "rule", "standard", "must not", "do not", "never", "policy", "convention", "limit"] },
  interfaces: { description: "Defined or changed APIs, data shapes, schemas, contracts, or key signatures", keywords: ["api", "interface", "schema", "contract", "signature", "function", "type", "endpoint", "param", "returns"] },
  decisions: { description: "A decision that was made and its rationale", keywords: ["decided", "decision", "chose", "we will use", "going with", "instead of", "because", "rationale", "tradeoff"] },
  files: { description: "Specific files or modules that were created, changed, or are central to the work", keywords: ["file", "folder", "directory", "path", "module", "created", "edited", "added", "renamed", ".ts", ".js", ".py", ".json", ".md"] },
  verification: { description: "Commands to build/test/lint/run, or how correctness was verified", keywords: ["test", "run", "build", "lint", "command", "npm", "bun", "pytest", "verify", "check", "passing", "failing", "suite"] },
  state: { description: "Prior findings, bug causes, error messages, or facts established about the code", keywords: ["bug", "error", "issue", "cause", "found", "because", "fails", "broken", "root cause", "exception", "traceback"] },
  environment: { description: "Environment or configuration details — versions, paths, ports, env vars, dependencies", keywords: ["version", "config", "environment", "port", "env", "dependency", "install", "path", "node", "python", "docker"] },
  pending: { description: "Open questions, TODOs, or next steps agreed but not yet completed", keywords: ["todo", "next", "later", "pending", "open question", "remaining", "still need", "follow up", "unresolved"] },
};

// Builds the structured digest from the compacted tail. For each bucket, the tail's
// own sentences that match the bucket's theme become candidate values, and one
// batched "choice" call asks the classifier to pick the single most representative
// one — so the digest preserves the SPECIFIC fact ("auth uses event-sourcing") rather
// than merely noting the topic came up. Buckets with no matching sentences are
// skipped. Returns the digest lines, or an empty array when the classifier gives
// nothing usable (the caller then keeps the tail's most relevant messages and nothing
// is lost outright). Mirrors the plugin's buildHistoryDigest.
export async function buildHistoryDigest(tailText: string): Promise<string[]> {
  const sentences = tailText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\[[A-Z]+\]:\s*/, "").trim())
    .filter((s) => s.length > 20 && s.length < 400);

  const questionsById: Record<string, { instructions: string; criteria: Record<string, string> }> = {};
  const bucketSentences: Record<string, string[]> = {};
  for (const [key, bucket] of Object.entries(DIGEST_BUCKETS)) {
    const matches = sentences
      .filter((s) => {
        const low = s.toLowerCase();
        return bucket.keywords.some((w) => low.includes(w));
      })
      .slice(0, 6);
    if (matches.length === 0) continue;

    const criteria: Record<string, string> = {};
    matches.forEach((s, i) => {
      criteria[`v${i}`] = s;
    });
    criteria["none"] = "None of these capture it.";
    bucketSentences[key] = matches;
    questionsById[key] = {
      instructions: `From this earlier conversation, which statement best captures ${bucket.description}? Pick the single most representative one, or "none".`,
      criteria,
    };
  }
  if (Object.keys(questionsById).length === 0) return [];

  const answers = await askChoiceMany(tailText, questionsById);

  const lines: string[] = [];
  for (const [key, bucket] of Object.entries(DIGEST_BUCKETS)) {
    const pick = answers[key]?.choice;
    if (!pick || pick === "none") continue;
    const idx = Number(pick.replace(/^v/, ""));
    const chosen = bucketSentences[key]?.[idx];
    if (chosen) lines.push(`- ${bucket.description}: ${chosen}`);
  }
  return lines;
}

// Per-session complexity level, keyed by sessionID. Set by the classification
// hook; read by the confidence tool (for its threshold) and the post-edit check.
export const levelBySession = new Map<string, "simple" | "medium" | "high">();
