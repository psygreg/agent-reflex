import { Plugin } from "@opencode/plugin";

type ProviderPreset =
  | "llamacpp"
  | "ollama"
  | "lmstudio"
  | "typesafe"
  | "openrouter"
  | "vercel"
  | "opencode"
  | "custom";

// Default base URLs per provider preset. Every preset below serves the same
// System One request shape (model, state, questions) at <baseURL>/systemone:
// the local runtimes' System One APIs (llama.cpp's, Ollama's and LM Studio's
// /v1/systemone endpoints — Ollama 0.35 and LM Studio 0.4.26 onwards), the
// TypeSafe API (Jev), OpenRouter's System One surface, the Vercel AI Gateway's
// TypeSafe-compatible surface and OpenCode Zen. "custom" (or an omitted
// preset) needs an explicit baseURL.
const PRESET_BASE_URLS: Record<string, string | undefined> = {
  llamacpp: "http://127.0.0.1:8080/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  typesafe: "https://api.typesafe.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vercel: "https://ai-gateway.vercel.sh/typesafe/v1",
  opencode: "https://opencode.ai/zen/v1",
};

const REQUEST_TIMEOUT_MS = 20_000;
const SYSTEMONE_MAX_BATCH_QUESTIONS = 32;
const SYSTEMONE_DECISION_BATCH_WINDOW_MS = 12;
const COMPACT_SCORE_MAX_CHARS = 4_000;

// Requested settings per complexity level, applied only while the agent's effort
// is at its default. Explicit variants or provider effort settings take precedence.
// effort: Anthropic output_config.effort; OpenAI Responses reasoning.effort /
// Chat Completions reasoning_effort; local reasoning_effort ("low" keeps
// thinking at its lowest level).
// thinking: llama.cpp chat template enable_thinking (on/off, Qwen-style templates).
// maxTokens: level cap on generated tokens, sent through event.options (ignored by the
// OpenCode Go provider) and enforced on the wire for Z.ai GLM (max_completion_tokens).
const LEVEL_REQUEST = {
  simple: { maxTokens: 8192, effort: "low", thinking: false },
  medium: { maxTokens: 65536, effort: "medium", thinking: true },
  high: { maxTokens: 131072, effort: "high", thinking: true },
} as const;

type EffortLevel = keyof typeof LEVEL_REQUEST;

// Complexity score cut-offs: above 0.50 is medium, above 0.80 is high.
function classifyComplexity(score: number): EffortLevel {
  if (score > 0.80) return "high";
  if (score > 0.50) return "medium";
  return "simple";
}

function isExplicitEffortValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "string") return true;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "default" && normalized !== "auto";
}

function hasExplicitEffortOptions(options: any, visited = new Set<object>()): boolean {
  if (!options || typeof options !== "object") return false;
  if (visited.has(options)) return false;
  visited.add(options);
  const values = [
    options.reasoningEffort,
    options.reasoning_effort,
    options.effort,
    options.reasoning?.effort,
    options.outputConfig?.effort,
    options.output_config?.effort,
    options.thinking?.type,
    options.thinking?.budgetTokens,
    options.thinking?.budget_tokens,
    options.enableThinking,
    options.enable_thinking,
  ];
  if (values.some(isExplicitEffortValue)) return true;

  // Provider-specific settings may be nested by provider ID or under `body`.
  for (const nested of Object.values(options)) {
    if (nested && typeof nested === "object" && hasExplicitEffortOptions(nested, visited)) return true;
  }
  return false;
}

// OpenCode exposes an explicitly selected model variant on Model.Ref and passes
// provider/agent settings through context options. A missing/default variant with
// no effort option means the plugin may apply its per-request complexity level.
function hasUserEffortOverride(model: any, options: any): boolean {
  return isExplicitEffortValue(model?.variant) || hasExplicitEffortOptions(options);
}

// ---- HISTORY COMPACTION (decision-driven) ----
// Compaction keeps the most recent messages verbatim (the keep window, sized by
// complexity level so a task in flight never loses its working context), keeps a
// bounded set of high-relevance older messages verbatim, and turns the remaining
// older messages into one structured digest instead of discarding their detail.
// The digest is produced by the classifier through a "choice" decision (the
// System One surface returns typed decisions, not prose), so nothing depends on
// a free-text generation call.
//
// Keep-window (most recent messages always kept verbatim) per complexity level.
// High-complexity work has the most moving parts, so it keeps the most context.
const COMPACT_KEEP_RECENT: Record<EffortLevel, number> = { simple: 6, medium: 10, high: 14 };

// Trigger only when the history is meaningfully longer than the keep window.
const COMPACT_MIN_MESSAGES = 18;

// Relevance floor for keeping an older message verbatim. Above this the message
// is preserved in full; at or below it the message is folded into the digest.
// Deliberately higher than a coin-flip so only clearly load-bearing messages
// survive — the rest are compressed, not thrown away.
const COMPACT_RELEVANCE_KEEP = 0.65;

// Bound on how many older messages are kept verbatim for relevance, so a long
// session cannot preserve its whole tail and defeat the compaction.
const COMPACT_MAX_PRESERVED = 8;

// The structured digest buckets: the recurring kinds of fact a coding session
// establishes and later work depends on. Each bucket carries theme keywords used
// to select candidate sentences from the tail; for each bucket, the tail's own
// matching sentences become "choice" candidates and the classifier picks the most
// representative one, so the digest preserves the SPECIFIC fact rather than merely
// noting the topic came up. This is the extraction step: it distills the tail into
// a small, structured record using the "choice" primitive rather than free-form
// summarization.
interface DigestBucket {
  description: string;
  keywords: string[];
}
const DIGEST_BUCKETS: Record<string, DigestBucket> = {
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

// Z.ai GLM request fields per complexity level (models from GLM-5.2 onwards).
// thinking toggles the chain of thought (GLM-4.6+). reasoning_effort scales it
// (GLM-5.2+): "medium" is not a valid GLM-5.3 reasoning_effort, so the medium level maps to "high".
const ZAI_LEVEL_REQUEST = {
  simple: { thinking: false, effort: "low" },
  medium: { thinking: true, effort: "high" },
  high: { thinking: true, effort: "max" },
} as const;

// The OpenCode Go gateway (https://opencode.ai/inference/go/...) proxies GLM models with
// its own request dialect: reasoning_effort is honored, but Z.ai's native "thinking"
// field is rejected as an unknown parameter (verified against the live endpoint).
const OPENCODE_GO_URL = /https?:\/\/[^/]*opencode\.ai\/inference\/go\//i;

// GLM capabilities parsed from the model id found in a request body.
interface GlmModel {
  supportsEffort: boolean; // reasoning_effort parameter exists (GLM-5.2 onwards)
  forcedThinking: boolean; // thinking cannot be turned off (GLM-5.3 onwards)
}

// Matches "glm-5.2", "GLM-5.3-Flash", "glm-5-2", "glm5.3", "z-ai/glm-5.2"... The
// leading boundary keeps older "chatglm" ids from matching as newer GLM versions.
function parseGlmModel(model: unknown): GlmModel | null {
  if (typeof model !== "string") return null;
  const match = model.toLowerCase().match(/(?:^|[^a-z])glm[-_.\s]?v?(\d+)(?:[-_.](\d+))?/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  const atLeast = (needMajor: number, needMinor: number) => major > needMajor || (major === needMajor && minor >= needMinor);
  return {
    supportsEffort: atLeast(5, 2),
    // Future versions are treated as forced-thinking: skipping "disabled" on a model
    // that allows it only loses the speed optimization, but sending "disabled" to a
    // model that rejects it fails the whole request.
    forcedThinking: atLeast(5, 3),
  };
}

// Applies the session's level to a GLM chat/completions request body (in place).
// Returns false when the request must stay untouched (not a GLM-5.2+ model).
function applyZaiLevel(body: any, level: EffortLevel, url: string): boolean {
  const glm = parseGlmModel(body?.model);
  if (!glm?.supportsEffort) return false;

  const zai = ZAI_LEVEL_REQUEST[level];

  if (OPENCODE_GO_URL.test(url)) {
    // The gateway rejects the "thinking" field, so effort rides on reasoning_effort alone.
    // glm-5.2 accepts "minimal" (skips thinking entirely); glm-5.3+ cannot skip thinking,
    // so simple tasks fall back to "low". "none" is rejected and is never sent.
    delete body.thinking;
    body.reasoning_effort = zai.thinking || glm.forcedThinking ? zai.effort : "minimal";
    // The Go provider ignores event.options.maxTokens, so the level cap is enforced
    // on the wire instead (the field OpenCode itself sends on this route). OpenCode's
    // pre-filled cap is model-aware, so the level cap only ever lowers it.
    const wanted = LEVEL_REQUEST[level].maxTokens;
    const existing = body.max_completion_tokens ?? body.max_tokens;
    body.max_completion_tokens =
      typeof existing === "number" && existing > 0 ? Math.min(wanted, existing) : wanted;
    return true;
  }

  // Direct Z.ai API (https://api.z.ai/api/paas/v4): thinking.type plus reasoning_effort.
  // reasoning_effort only takes effect while thinking is enabled.
  if (!zai.thinking && !glm.forcedThinking) {
    body.thinking = { ...(body.thinking ?? {}), type: "disabled" };
    delete body.reasoning_effort;
  } else {
    body.thinking = { ...(body.thinking ?? {}), type: "enabled" };
    body.reasoning_effort = zai.effort;
  }
  return true;
}

// Applies the session's level to OpenAI GPT reasoning requests. OpenAI's
// Responses API uses reasoning.effort; Chat Completions uses reasoning_effort.
function applyOpenAiLevel(body: any, level: EffortLevel, url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const effort = LEVEL_REQUEST[level].effort;

  if (/\/responses$/i.test(pathname)) {
    body.reasoning = {
      ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}),
      effort,
    };
    return true;
  }

  if (/\/chat\/completions$/i.test(pathname)) {
    body.reasoning_effort = effort;
    return true;
  }

  return false;
}

// Xiaomi MiMo request fields per complexity level (MiMo-V2.5 onwards).
// thinking: the chain-of-thought toggle (thinking.type on /v1/chat/completions
// and on the Anthropic-compatible /messages surface). On the Responses API
// thinking is controlled through reasoning.effort: "none" disables it, while
// "low", "medium" and "high" all enable thinking with identical behavior today
// (Xiaomi does not yet differentiate their intensity), so the levels map one to
// one for when it does. Only none/low/medium/high are ever sent: those are the
// values MiMo's chat completions surface accepts (verified live through the
// OpenCode Go gateway, which proxies MiMo on its openai-compatible route).
const MIMO_LEVEL_REQUEST = {
  simple: { thinking: false, effort: "none" },
  medium: { thinking: true, effort: "medium" },
  high: { thinking: true, effort: "high" },
} as const;

// Matches "mimo-v2.5", "MiMo-V2.6-Pro", "xiaomi/mimo-v2.5-pro",
// "mimo-v2.6-pro-ultraspeed", "mimo2.6", "mimo-v2.6.1"... The negative
// lookahead keeps size-suffixed legacy ids ("MiMo-7B-RL", "mimo-70b") from
// matching. Only MiMo-V2.5 onwards is accepted: earlier versions
// ("mimo-v2-flash") have no thinking controls, and future versions keep working.
function parseMimoModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const match = model.toLowerCase().match(/(?:^|[^a-z])mimo[-_.\s]?v?(\d+)(?:[-_.](\d+))?(?!\d|b(?![a-z]))/);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  return major > 2 || (major === 2 && minor >= 5);
}

// OpenRouter speaks one unified reasoning parameter on every route and strips
// provider-specific shapes such as MiMo's "thinking".
function isOpenRouterUrl(url: string): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Applies the session's level to a Xiaomi MiMo request body (in place). Returns
// false when the request must stay untouched (not a MiMo-V2.5+ model, or an
// endpoint shape MiMo does not serve). The field dialect is chosen per surface:
// - /responses (Xiaomi's OpenAI Responses surface): reasoning.effort, where
//   "none" disables thinking. The reasoning object holds effort alone.
// - /chat/completions on the OpenCode Go gateway: reasoning_effort plus
//   max_completion_tokens, since the Go provider ignores event.options.maxTokens.
//   Verified live: the route accepts none/low/medium/high ("minimal" is rejected)
//   and the level caps fit its 131072-token completion limit.
// - /chat/completions on OpenRouter: the unified reasoning.effort parameter
//   (effort replaces the reasoning object; effort and max_tokens are mutually
//   exclusive there).
// - /chat/completions elsewhere (Xiaomi's own API and compatible endpoints) and
//   the Anthropic-compatible /messages surface: the native thinking.type, whose
//   object holds type alone (no budget is accepted).
function applyMimoLevel(body: any, level: EffortLevel, url: string): boolean {
  if (!parseMimoModel(body?.model)) return false;

  const request = MIMO_LEVEL_REQUEST[level];
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const isChat = /\/chat\/completions$/i.test(pathname);

  if (/\/responses$/i.test(pathname)) {
    body.reasoning = { effort: request.effort };
    return true;
  }

  if (isChat && OPENCODE_GO_URL.test(url)) {
    body.reasoning_effort = request.effort;
    body.max_completion_tokens = LEVEL_REQUEST[level].maxTokens;
    return true;
  }

  if (isChat && isOpenRouterUrl(url)) {
    body.reasoning = { effort: request.effort };
    return true;
  }

  if (isChat || isAnthropicMessagesEndpoint(url)) {
    body.thinking = { type: request.thinking ? "enabled" : "disabled" };
    return true;
  }

  return false;
}

// Google Gemini levels per complexity level (Gemini 3 onwards, thinkingLevel).
// Thinking cannot be fully disabled on Gemini 3+ and "minimal" is deliberately
// not used: it errors on Gemini 3.8+ and Gemini 4, while "low" is Google's
// documented latency/cost tier and is supported everywhere.
const GEMINI_LEVEL_REQUEST = {
  simple: "low",
  medium: "medium",
  high: "high",
} as const;

// Matches "gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-3.8-flash",
// "gemini-4-argon", "google/gemini-3.5-flash-lite"... Only Gemini 3 onwards: the
// 2.5 generation speaks the older thinkingBudget instead of thinkingLevel.
// Media/specialist variants (image, tts, live, audio, speech, robotics) have
// their own level sets and stay untouched, as do versionless aliases.
function parseGeminiModel(model: unknown): { supportsMedium: boolean } | null {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase();
  if (/(?:image|tts|live|audio|speech|robotics)/.test(id)) return null;
  const match = id.match(/(?:^|[^a-z])gemini[-_.\s]?v?(\d+)(?:[-_.](\d+))?(?!\d)/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  if (major < 3) return null;
  // gemini-3-pro (3.0) supports only "low" and "high"; every later model adds "medium".
  return { supportsMedium: !(major === 3 && minor === 0 && /pro/.test(id)) };
}

// Google-style endpoints carry the model in the path (/models/{model}:action)
// instead of the request body.
function modelFromGooglePath(url: string): string | null {
  return url.split(/[?#]/, 1)[0].match(/\/models\/([^/:]+)(?::|$)/)?.[1] ?? null;
}

// Applies the session's level to a Google Gemini request body (in place).
// Returns false when the request must stay untouched (not a Gemini 3+ model, or
// an endpoint shape Gemini does not serve). The field dialect:
// - :generateContent / :streamGenerateContent (Google AI, Vertex AI and the
//   OpenCode Go google route): generationConfig.thinkingConfig.thinkingLevel.
//   Gemini 3+ rejects thinkingBudget and thinkingLevel together (verified live
//   through Go: "You can only set only one of thinking budget and thinking
//   level"), so any budget is dropped. The level cap is enforced as
//   maxOutputTokens on the Go route only, where event.options.maxTokens is
//   ignored (verified live: the route accepts the full 131072 cap).
// - /chat/completions (Google's OpenAI-compatible surface, OpenRouter, Go's
//   openai route): reasoning_effort, which those surfaces map to thinkingLevel.
function applyGeminiLevel(body: any, level: EffortLevel, url: string): boolean {
  const gemini = parseGeminiModel(typeof body?.model === "string" ? body.model : modelFromGooglePath(url));
  if (!gemini) return false;

  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const thinkingLevel = level === "medium" && !gemini.supportsMedium ? "high" : GEMINI_LEVEL_REQUEST[level];

  if (/:(?:streamGenerateContent|generateContent)$/i.test(pathname)) {
    const generationConfig = { ...(body.generationConfig ?? {}) };
    const thinkingConfig: any = { ...(generationConfig.thinkingConfig ?? {}) };
    delete thinkingConfig.thinkingBudget;
    generationConfig.thinkingConfig = { ...thinkingConfig, thinkingLevel };
    if (OPENCODE_GO_URL.test(url)) generationConfig.maxOutputTokens = LEVEL_REQUEST[level].maxTokens;
    body.generationConfig = generationConfig;
    return true;
  }

  if (/\/chat\/completions$/i.test(pathname)) {
    body.reasoning_effort = thinkingLevel;
    return true;
  }

  return false;
}

// Xiaomi MiMo and Google Gemini are matched by version; Qwen additionally
// matches versionless product ids (qwen-plus, qwen-max...) because Alibaba
// keeps those as live hybrid-thinking aliases.

// Qwen levels per complexity level. Qwen's native knob is a boolean
// (enable_thinking / thinking.type) to turn thought on or off, plus an
// intensity: reasoning_effort on Chat Completions/DashScope (low/medium/xhigh
// on Qwen3.8; low/medium/high on Qwen3.5-3.7), reasoning.effort on the
// Responses surface (supports xhigh there), and output_config.effort (Claude
// style) on the Anthropic-compatible surface. "high" is mapped to "xhigh" where
// Qwen's top tier is xhigh. Simple turns thinking off entirely
// (enable_thinking=false / thinking.type=disabled). thinking_budget and
// thinking.budget_tokens are never sent: they conflict with or are rejected
// alongside the effort knobs.
const QWEN_LEVEL_REQUEST = {
  simple: { thinking: false, effort: "low" },
  medium: { thinking: true, effort: "medium" },
  high: { thinking: true, effort: "high" },
} as const;

// Matches "qwen3.8-max", "qwen3.7-plus", "qwen3.6-flash", "qwen3.5-plus",
// "qwen3.8-omni-flash", "qwen3-coder-plus", "qwen/qwen3.7-max" (OpenRouter
// prefix), and the versionless flagship aliases "qwen-plus", "qwen-max",
// "qwen-turbo", "qwen-flash". Gate at Qwen3.5+ or a versionless flagship alias.
// Qwen3-Coder, Qwen3-VL, Qwen3.5-Omni (self-contradictory thinking support) and
// qwen1.5/2.x have no safe thinking knob and are excluded. "thinkingOnly" marks
// the few models that always think and cannot disable it (their simple level
// falls back to the lowest effort instead of off); "xhigh" marks models whose top
// effort tier is xhigh rather than high (Qwen3.8+).
function parseQwenModel(model: unknown): { thinkingOnly: boolean; xhigh: boolean } | null {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase().split("/").pop() ?? "";
  if (!id.startsWith("qwen")) return null;

  // Versionless flagship aliases (no digit right after "qwen").
  if (!/^qwen\d/.test(id)) {
    if (/^(qwen)-(plus|max|turbo|flash)(-|$)/.test(id)) return { thinkingOnly: false, xhigh: false };
    return null;
  }

  // A version digit follows. Reject Qwen3-Coder / Qwen3-VL / audio / math and
  // the Qwen3.5-Omni speech family (its thinking support is self-contradictory
  // across Alibaba's pages, so it is left untouched rather than risk a foreign field).
  if (/^qwen3-(coder|vl|audio|math)/.test(id)) return null;
  if (/^qwen3\.5-omni/.test(id)) return null;
  const match = id.match(/^qwen(\d+)(?:[._-](\d+))?/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;

  if (major < 3) return null;
  if (major === 3 && minor === 0 && /-(coder|vl|omni|audio|math)/.test(id)) return null;
  if (major === 3 && minor < 5 && !/-(plus|max|turbo|flash)/.test(id)) return null;

  // Qwen3.8's top effort tier is "xhigh" (not "high"); 3.5-3.7 use "high".
  const xhigh = major > 3 || (major === 3 && minor >= 8);
  // Thinking-only models cannot disable thinking.
  const thinkingOnly = /^qwen3\.8-2\.4t/.test(id) || /-preview$/.test(id) || /^qwen3\.7-max-2026-05-17/.test(id);
  return { thinkingOnly, xhigh };
}

// Applies the session's level to a Qwen request body (in place). Returns false
// when the request must stay untouched (not a Qwen model, or an endpoint shape
// Qwen does not serve). The field dialect is chosen per surface:
// - /chat/completions (OpenAI-compatible, DashScope, OpenRouter, Go): the
//   boolean enable_thinking to turn thought on/off, plus reasoning_effort as
//   the intensity. Simple sets enable_thinking=false (and drops any effort or
//   budget so no conflicting knob survives).
// - /responses (OpenAI-compatible Responses): reasoning.effort, the documented
//   knob there. Simple maps to "none" when the model supports off, else "low".
// - /messages (Anthropic-compatible): thinking.type to turn thought on/off, with
//   output_config.effort (Claude-style) as the intensity. thinking.budget_tokens
//   is deliberately NOT sent — the Go anthropic route and Claude-style surfaces
//   reject it, while output_config.effort is the portable intensity knob. Simple
//   sets type=disabled (dropping any budget). Verified live through Go.
function applyQwenLevel(body: any, level: EffortLevel, url: string): boolean {
  const qwen = parseQwenModel(body?.model);
  if (!qwen) return false;

  const request = QWEN_LEVEL_REQUEST[level];
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const on = level !== "simple" || qwen.thinkingOnly;
  const effort = level === "high" && qwen.xhigh ? "xhigh" : request.effort;

  if (/\/responses$/i.test(pathname)) {
    body.reasoning = { effort: on ? effort : qwen.thinkingOnly ? "low" : "none" };
    return true;
  }

  if (/\/chat\/completions$/i.test(pathname)) {
    delete body.thinking_budget;
    delete body.reasoning;
    if (!on) {
      delete body.reasoning_effort;
      body.enable_thinking = false;
    } else {
      body.enable_thinking = true;
      body.reasoning_effort = effort;
    }
    return true;
  }

  if (isAnthropicMessagesEndpoint(url)) {
    const thinking: any = { ...(body.thinking ?? {}) };
    delete thinking.budget_tokens;
    thinking.type = on ? "enabled" : "disabled";
    body.thinking = thinking;
    if (on) body.output_config = { ...(body.output_config ?? {}), effort };
    return true;
  }

  return false;
}

// Moonshot Kimi levels per complexity level. Kimi's thinking control differs per
// generation (Moonshot's Model Parameter Reference, verified live through the
// OpenCode Go openai route):
// - kimi-k3: thinking always on; intensity via top-level reasoning_effort
//   ("low"/"high"/"max", default "max"). No thinking parameter (errors if sent).
//   Verified: reasoning_effort low reduces reasoning tokens vs max.
// - kimi-k2.7-code / -highspeed: thinking always on, cannot be disabled
//   (thinking {type:"disabled"} -> 400 "only type=enabled is allowed for this
//   model"). No documented effort field; it always reasons.
// - kimi-k2.6: thinking switchable via thinking.type ("enabled"/"disabled");
//   no effort field.
// Intensity is therefore only expressible on K3 (reasoning_effort low/max). K3
// "high" is not sent — its documented top is "max" and "high" maps ambiguously,
// so medium/high both use "max". Simple disables thinking where the model allows
// (k2.6), else falls back to the lowest effort (k3 "low"; k2.7 always reasons).
const KIMI_LEVEL_REQUEST = {
  simple: { thinking: false, effort: "low", maxEffort: "low" },
  medium: { thinking: true, effort: "high", maxEffort: "max" },
  high: { thinking: true, effort: "max", maxEffort: "max" },
} as const;

// Matches the active Kimi models "kimi-k2.7-code", "kimi-k2.7-code-highspeed",
// "kimi-k2.6", "kimi-k3", "kimi-k3-swarm-max", and OpenRouter-prefixed
// "kimi/kimi-k2.7-code" / "moonshotai/kimi-k3". Gate at kimi-k2.7+ or kimi-k3:
// the retired kimi-k2-thinking / kimi-k2.5 / moonshot-v1-* ids and non-Kimi ids
// (glm, qwen, mimo) stay untouched. "kind" is "k3" (effort field), "k27"
// (thinking-only, no effort field) or "k26" (switchable thinking, no effort field).
function parseKimiModel(model: unknown): { kind: "k3" | "k27" | "k26" } | null {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase().split("/").pop() ?? "";
  if (!id.startsWith("kimi")) return null;

  if (/^kimi-k?3/.test(id)) return { kind: "k3" };
  if (/^kimi-k2\.7/.test(id)) return { kind: "k27" };
  if (/^kimi-k2\.6/.test(id)) return { kind: "k26" };
  return null;
}

// Applies the session's level to a Moonshot Kimi request body (in place).
// Returns false when the request must stay untouched (not an active Kimi model,
// or an endpoint shape Kimi does not serve). The field dialect per generation:
// - kimi-k3: reasoning_effort (low/high/max) on /chat/completions and /responses
//   (reasoning.effort); thinking is always on so no toggle is sent.
// - kimi-k2.7-code: thinking always on; only {"type":"enabled","keep":"all"} is
//   accepted on /chat/completions (verified against Moonshot's reference), so the
//   rewrite emits exactly that and never "disabled" (which errors).
// - kimi-k2.6: thinking.type ("enabled"/"disabled") toggles thought on/off.
// The /messages (Anthropic) surface maps thinking.type there; K3 effort rides on
// output_config.effort on that surface (Claude-style).
function applyKimiLevel(body: any, level: EffortLevel, url: string): boolean {
  const kimi = parseKimiModel(body?.model);
  if (!kimi) return false;

  const request = KIMI_LEVEL_REQUEST[level];
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  // Only k2.6 can turn thinking off; k3 and k2.7 always think.
  const canDisable = kimi.kind === "k26";
  const on = level !== "simple" || !canDisable;

  if (/\/chat\/completions$/i.test(pathname)) {
    delete body.reasoning;
    if (kimi.kind === "k3") {
      delete body.thinking;
      body.reasoning_effort = on ? request.maxEffort : "low";
      return true;
    }
    delete body.reasoning_effort;
    if (kimi.kind === "k27") {
      // Thinking-only: only {"type":"enabled","keep":"all"} is accepted.
      body.thinking = { type: "enabled", keep: "all" };
      return true;
    }
    // k2.6: switchable thinking, no effort field.
    body.thinking = { type: on ? "enabled" : "disabled" };
    return true;
  }

  if (/\/responses$/i.test(pathname)) {
    if (kimi.kind === "k3") {
      body.reasoning = { effort: on ? request.maxEffort : "low" };
      return true;
    }
    return false;
  }

  if (isAnthropicMessagesEndpoint(url)) {
    if (kimi.kind === "k3") {
      // K3 always thinks and exposes no toggle; effort rides on output_config.
      delete body.thinking;
      body.output_config = { ...(body.output_config ?? {}), effort: on ? request.maxEffort : "low" };
      return true;
    }
    const thinking: any = { ...(body.thinking ?? {}) };
    if (kimi.kind === "k27") {
      // Thinking-only; keep is not documented on the Anthropic surface, so only type.
      thinking.type = "enabled";
    } else {
      thinking.type = on ? "enabled" : "disabled";
    }
    body.thinking = thinking;
    return true;
  }

  return false;
}

// xAI Grok request fields per complexity level. Grok's knob is reasoning_effort
// on /chat/completions and reasoning.effort on /responses; there is no separate
// thinking toggle. What differs per generation is the vocabulary and whether
// reasoning can be turned off (xAI's Reasoning docs and the grok-4.3 model card):
// - grok-4.3: reasoning is configurable and CAN be disabled ("none"), with
//   low/medium/high/xhigh effort tiers (default "low").
// - grok-4.5 / 4.6 / 4.7: reasoning CANNOT be disabled; tiers are low/medium/high
//   (default "high"), plus "xhigh" from grok-4.6 onwards.
// - grok-4 and older (grok-3-mini, retired grok-4-fast): effort is either
//   rejected (grok-4 errors on reasoning_effort) or is a separate model id, so
//   they are left untouched rather than risk a foreign or 400ing field.
// Simple disables reasoning only where the model allows it (grok-4.3 "none"),
// falling back to the lowest effort otherwise. "high" maps to "xhigh" where the
// model's top tier is xhigh (grok-4.3/4.6+), mirroring the Qwen convention.
const GROK_LEVEL_REQUEST = {
  simple: { thinking: false, effort: "low" },
  medium: { thinking: true, effort: "medium" },
  high: { thinking: true, effort: "high" },
} as const;

// Grok capabilities parsed from the model id found in a request body.
// canDisable: reasoning can be switched off ("none") — grok-4.3 only. Models
// that cannot disable it fall back to the lowest effort on the simple level.
// xhigh: the top effort tier is "xhigh" rather than "high" (grok-4.3, 4.6+).
interface GrokModel {
  canDisable: boolean;
  xhigh: boolean;
}

// Matches "grok-4.3", "grok-4.5", "Grok-4.6", "grok-4.7", "x-ai/grok-4.3",
// "grok4.3"... Only grok-4.3 onwards is accepted: the 4.0 generation rejects
// reasoning_effort, and grok-3-mini / grok-4-fast use their own (retired) ids.
// Multi-agent variants route their reasoning knob at agent count, not effort,
// so they are excluded, as are media models (imagine, voice, vision, tts).
function parseGrokModel(model: unknown): GrokModel | null {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase().split("/").pop() ?? "";
  if (/(?:imagine|voice|vision|tts|image|agent)/.test(id)) return null;
  const match = id.match(/^grok[-_.\s]?v?(\d+)(?:[._-](\d+))?/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  // grok-4.3 is the first generation with a configurable reasoning knob.
  if (major < 4 || (major === 4 && minor < 3)) return null;
  const atLeast = (needMajor: number, needMinor: number) => major > needMajor || (major === needMajor && minor >= needMinor);
  return {
    // "none" is a grok-4.3-only tier; 4.5+ cannot disable reasoning.
    canDisable: !atLeast(4, 5),
    // grok-4.3 and grok-4.6+ top out at xhigh; grok-4.5 is high-only.
    xhigh: !atLeast(4, 5) || atLeast(4, 6),
  };
}

// Applies the session's level to a Grok request body (in place). Returns false
// when the request must stay untouched (not a grok-4.3+ model, or an endpoint
// shape Grok does not serve). The field dialect per surface:
// - /responses (xAI's OpenAI Responses surface): reasoning.effort.
// - /chat/completions (xAI's OpenAI-compatible surface, OpenRouter, any gateway):
//   reasoning_effort, unless OpenRouter's unified reasoning.effort is expected.
// Simple sets "none" where the model supports it (grok-4.3), else the lowest
// effort (Grok 4.5+ reasons regardless). presencePenalty, frequencyPenalty and
// stop are rejected by Grok reasoning models, but those are the caller's fields
// and are left alone here.
function applyGrokLevel(body: any, level: EffortLevel, url: string): boolean {
  const grok = parseGrokModel(body?.model);
  if (!grok) return false;

  const request = GROK_LEVEL_REQUEST[level];
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const effort = level === "high" && grok.xhigh ? "xhigh" : request.effort;
  const value = level === "simple" && !grok.canDisable ? effort : level === "simple" ? "none" : effort;

  if (/\/responses$/i.test(pathname)) {
    body.reasoning = { ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}), effort: value };
    return true;
  }

  if (/\/chat\/completions$/i.test(pathname)) {
    if (isOpenRouterUrl(url)) body.reasoning = { effort: value };
    else body.reasoning_effort = value;
    return true;
  }

  return false;
}

// MiniMax request fields per complexity level (MiniMax-M3 family onwards).
// MiniMax exposes two separate knobs (MiniMax's OpenAI SDK / Chat Completions docs):
// - thinking: {type} is the on/off switch. Its type is only "disabled" or
//   "adaptive" — NOT "enabled" (unlike Xiaomi MiMo / Kimi / Qwen, which use
//   "enabled"). Omitting thinking leaves thinking on (adaptive). "disabled" is
//   honored on MiniMax-M3 alone; MiniMax-M3.1-Flash-Preview returns HTTP 400
//   (it always thinks) and the M2.x models accept-but-ignore it.
// - reasoning_effort tunes thinking depth: low | medium | high | xhigh | max
//   (default "max"). It is honored on MiniMax-M3.1-Flash-Preview only; M3 and
//   M2.x ignore it. "none" is NOT accepted anywhere and returns HTTP 400.
// M2.x and older think at a fixed depth and can neither be disabled nor tuned,
// so they are left untouched rather than risk a foreign or 400ing field.
const MINIMAX_LEVEL_REQUEST = {
  // MiniMax-M3 needs adaptive thinking for reliable agent/tool turns. Keep it
  // enabled even on simple prompts; disabling it can produce an empty response.
  simple: { effort: "low" },
  medium: { effort: "medium" },
  high: { effort: "max" },
} as const;

// MiniMax capabilities parsed from the model id in a request body.
// supportsThinkingToggle: M3 accepts thinking.type, but the agent always sets it
// to adaptive because disabling it can yield an empty response. M3.1+ cannot
// disable thinking and instead tunes depth through effort. Models without either
// capability are left untouched.
interface MiniMaxModel {
  supportsThinkingToggle: boolean;
  tunable: boolean;
}

// Matches "MiniMax-M3", "minimax-m3.1-flash-preview", "minimax/minimax-m3",
// "minimax-m3.1"... Gate at MiniMax-M3 onwards: the M2.x generation (M2, M2.1,
// M2.5, M2.7 and their -highspeed pairs) can neither disable thinking nor tune
// its depth, and the M1 / abab lines predate thinking controls entirely. Both
// flags come from the version: M3 (3.0) can disable but not tune depth; M3.1+
// (the Flash preview) always thinks but tunes depth via reasoning_effort.
function parseMiniMaxModel(model: unknown): MiniMaxModel | null {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase().split("/").pop() ?? "";
  const match = id.match(/^minimax[-_.\s]?m?(\d+)(?:[._-](\d+))?/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  if (major < 3) return null;
  return {
    // thinking.type "disabled" is accepted by MiniMax-M3 only (M3.1-Flash 400s).
    supportsThinkingToggle: minor === 0,
    // reasoning_effort tunes depth on M3.1-Flash-Preview only (M3 ignores it).
    tunable: minor > 0,
  };
}

// Applies the session's level to a MiniMax request body (in place). Returns false
// when the request must stay untouched (not a MiniMax-M3+ model, or an endpoint
// shape MiniMax does not serve). The field dialect per surface:
// - /messages (MiniMax's Anthropic-compatible surface, the one OpenCode Go and
//   other agents use): thinking.type as the on/off switch where the model accepts
//   it (MiniMax-M3), plus output_config.effort where the model tunes depth
//   (M3.1-Flash). Note the M3 default here is OFF when thinking is omitted, so
//   the switch is written on every level (adaptive enables it).
// - /chat/completions (MiniMax's OpenAI-compatible surface): thinking.type where
//   the model accepts it (MiniMax-M3, default ON), plus reasoning_effort where the
//   model tunes depth (M3.1-Flash). OpenRouter speaks its unified reasoning.effort
//   instead of either field.
// - /responses (MiniMax's OpenAI Responses surface): reasoning.effort, whose
//   "none" is rejected exactly like reasoning_effort, so the simple level sends
//   the lowest effort there.
// MiniMax-M3 keeps adaptive thinking enabled at every level: disabling it can
// yield an empty response, and agent turns need its interleaved reasoning to
// consume tool results reliably. Simple M3.1 turns use the lowest effort instead.
// presence_penalty, frequency_penalty and logit_bias are ignored by MiniMax, but
// those are the caller's fields and are left alone here.
function applyMiniMaxLevel(body: any, level: EffortLevel, url: string): boolean {
  const minimax = parseMiniMaxModel(body?.model);
  if (!minimax) return false;

  const request = MINIMAX_LEVEL_REQUEST[level];
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, "");

  if (isAnthropicMessagesEndpoint(url)) {
    // MiniMax's /messages: keep M3 adaptive at every level; M3.1-Flash always
    // thinks and tunes depth through output_config.effort. "none" is not accepted.
    if (minimax.supportsThinkingToggle) body.thinking = { type: "adaptive" };
    if (minimax.tunable) body.output_config = { ...(body.output_config ?? {}), effort: request.effort };
    return true;
  }

  if (/\/responses$/i.test(pathname)) {
    // reasoning.effort has no "none"; the lowest effort stands in for off.
    body.reasoning = { ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}), effort: request.effort };
    return true;
  }

  if (/\/chat\/completions$/i.test(pathname)) {
    if (isOpenRouterUrl(url)) {
      body.reasoning = { effort: request.effort };
      return true;
    }
    if (minimax.supportsThinkingToggle) body.thinking = { type: "adaptive" };
    if (minimax.tunable) body.reasoning_effort = request.effort;
    return true;
  }

  return false;
}

// Effort dialect detection is per request, from the model actually being requested.
// The http.request hook event carries the provider's own model reference
// (event.model), even when a gateway like OpenCode Go proxies many models
// (Claude, GLM, GPT...) through a single server, so one model's dialect is
// never injected into another model's request.

// Claude models speak the Anthropic /v1/messages dialect (api.anthropic.com or
// compatible gateways). Claude through a chat/completions endpoint stays untouched.
function isAnthropicMessagesEndpoint(url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  return /\/messages$/i.test(pathname);
}

// GPT reasoning models accept reasoning effort: gpt-5 onwards plus the o-series.
const OPENAI_REASONING_MODEL = /(?:^|[/\-_.\s])(?:gpt-[5-9]|o[134])(?:[-_.\s]|$)/i;

// Local inference servers (llama.cpp, Ollama, LM Studio...) run on loopback or
// LAN hosts. The kind of server is identified once per origin via GET /v1/models
// (data[].owned_by): "llamacpp" for llama.cpp, "library" (the default Ollama
// username) or "ollama" for Ollama, and "lmstudio"/"organization_owner" for
// LM Studio. A probe that fails is cached as null (unknown) and retried only
// after the plugin reloads.
type LocalServer = "llamacpp" | "ollama" | "lmstudio";

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

const localServerByOrigin = new Map<string, Promise<LocalServer | null>>();

function detectLocalServer(url: string): Promise<LocalServer | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return Promise.resolve(null);
  }

  let probe = localServerByOrigin.get(origin);
  if (!probe) {
    probe = (async () => {
      try {
        const response = await fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) return null;
        const owners: string[] = (((await response.json()) as any)?.data ?? []).map((m: any) =>
          String(m?.owned_by ?? "")
        );
        if (owners.includes("llamacpp")) return "llamacpp";
        if (owners.includes("lmstudio") || owners.includes("organization_owner")) return "lmstudio";
        if (owners.some((owner) => owner === "library" || owner === "ollama")) return "ollama";
        return null;
      } catch {
        return null;
      }
    })();
    localServerByOrigin.set(origin, probe);
  }
  return probe;
}

// Reasoning effort written to local llama.cpp and Ollama requests. Both runtimes
// accept top-level reasoning_effort on /v1/chat/completions: "low" keeps
// thinking on at its lowest level, and "medium"/"high" scale it (the level
// reaches the chat template on llama.cpp and is mapped per model on Ollama).
const LOCAL_EFFORT = {
  simple: "low",
  medium: "medium",
  high: "high",
} as const;

// Decides which effort dialect a request speaks from the model being requested
// (event.model, falling back to the request body's model field). Requests with
// an unknown dialect stay untouched. "local": a local inference server on a
// loopback or LAN host, whose kind (llama.cpp or Ollama) is probed separately.
function detectBackend(model: { providerID?: string; id?: string } | undefined, body: any, url: string): EffortDialect | null {
  const modelId =
    typeof model?.id === "string" && model.id
      ? model.id
      : typeof body?.model === "string"
        ? body.model
        : "";

  // GLM models from 5.2 onwards, through the Z.ai API or the OpenCode Go gateway.
  if (parseGlmModel(modelId)?.supportsEffort) return "zai";
  // Claude models on a /v1/messages endpoint.
  if (/claude/i.test(modelId)) return isAnthropicMessagesEndpoint(url) ? "anthropic" : null;
  // GPT reasoning models through the OpenAI API or OpenCode Go.
  if (OPENAI_REASONING_MODEL.test(modelId)) return "openai";
  // Xiaomi MiMo models from v2.5 onwards through a remote API. A locally served
  // MiMo keeps the local server's own controls (reasoning_effort,
  // chat_template_kwargs) instead of the remote MiMo dialect.
  if (parseMimoModel(modelId) && !isLocalHost(url)) return "mimo";
  // Google Gemini models from Gemini 3 onwards through a remote API (the model
  // may live in the /models/{model}: URL path instead of the request body).
  if (parseGeminiModel(modelId || modelFromGooglePath(url)) && !isLocalHost(url)) return "gemini";
  // Qwen models from Qwen3.5 onwards, plus the versionless flagship aliases
  // (qwen-plus, qwen-max...), through a remote API. A locally served Qwen keeps
  // the local server's own controls.
  if (parseQwenModel(modelId) && !isLocalHost(url)) return "qwen";
  // Moonshot Kimi models from kimi-k2.7+/kimi-k3 through a remote API. A locally
  // served Kimi keeps the local server's own controls.
  if (parseKimiModel(modelId) && !isLocalHost(url)) return "kimi";
  if (parseGrokModel(modelId) && !isLocalHost(url)) return "grok";
  // MiniMax models from M3 onwards through a remote API. A locally served MiniMax
  // keeps the local server's own controls.
  if (parseMiniMaxModel(modelId) && !isLocalHost(url)) return "minimax";
  // Local inference servers (llama.cpp, Ollama) on loopback or LAN hosts.
  if (isLocalHost(url)) return "local";
  return null;
}

// Permission actions that carry a shell command.
const SHELL_ACTIONS = new Set(["bash", "shell", "terminal"]);

const CONFIDENCE_TOOL = "systemone_check_confidence";
const TOOL_EXPOSURE_TOOL = "systemone_reveal_tools";

// Effort dialect a primary request may speak, decided per request from the model
// being requested. "local": a local inference server (llama.cpp or Ollama) on a
// loopback or LAN host.
type EffortDialect = "anthropic" | "openai" | "zai" | "mimo" | "gemini" | "qwen" | "kimi" | "grok" | "minimax" | "local";

interface SystemOneConfig {
  baseURL: string;
  model: string;
  // Optional classifier fallback: retried once (same endpoint and key) when the
  // primary model rejects the request, e.g. when a limited-time free model
  // window closes.
  fallbackModel?: string;
  apiKey?: string;
  debugLog?: string;
  // Tool exposure: "auto" (default) lets System One decide which tools the task
  // needs and drops the rest from the request; "all" disables filtering and keeps
  // every tool. Anything else is treated as "all" (fail-open).
  toolExposure: "auto" | "all";
}

function resolveConfig(options: Record<string, unknown>): SystemOneConfig | null {
  const provider = (options.provider as ProviderPreset | undefined) ?? "custom";
  const baseURL = (options.baseURL as string | undefined) ?? PRESET_BASE_URLS[provider];
  const model = options.model as string | undefined;
  if (!baseURL || !model) return null;

  const toolsOpt = (options.tools as string | undefined) ?? (options.toolExposure as string | undefined);
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    model,
    fallbackModel: typeof options.fallbackModel === "string" ? options.fallbackModel : undefined,
    apiKey: options.apiKey as string | undefined,
    debugLog: typeof options.debugLog === "string" ? options.debugLog : undefined,
    toolExposure: toolsOpt === "auto" ? "auto" : "all",
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => b.text || b.content || "").join(" ");
  return "";
}

// Stable key for the active user request, used to scope explicit tool-exposure
// overrides to that request rather than disabling automatic exposure forever.
function latestUserMessage(messages: any[]): any | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i];
  }
}

function latestUserPromptKey(messages: any[]): string {
  const message = latestUserMessage(messages);
  if (!message) return "";
  if (typeof message.id === "string" && message.id) return `id:${message.id}`;
  try {
    return `content:${JSON.stringify(message.content)}`;
  } catch {
    return `content:${contentToText(message.content)}`;
  }
}

// Asks a yes/no question to a System One endpoint (the local runtimes' System One
// API, the TypeSafe API, OpenRouter, the Vercel AI Gateway or OpenCode Zen — all
// serve the same shape at <baseURL>/systemone) and returns P(YES) in [0, 1].
// Returns null when the model gives no usable number. System One models return
// typed decisions, never text, so every classifier request uses this shape.
// When the primary model rejects the request (e.g. a limited-time free model
// window closes) and a fallbackModel is configured, the question is retried
// once on the same endpoint and key.
async function askSystemOne(config: SystemOneConfig, state: string, question: string): Promise<number | null> {
  const ask = async (model: string): Promise<number | null> => {
    const response = await fetch(`${config.baseURL}/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        state,
        questions: { q: { type: "noul", instructions: question } },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const value = Number(data.answers?.q?.noul);
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : null;
  };

  let answer: number | null;
  try {
    answer = await ask(config.model);
  } catch {
    answer = null;
  }
  if (answer !== null) return answer;

  if (config.fallbackModel && config.fallbackModel !== config.model) {
    console.warn(`[System One]: Classifier model "${config.model}" unavailable, retrying with "${config.fallbackModel}".`);
    try {
      return await ask(config.fallbackModel);
    } catch {
      return null;
    }
  }
  return null;
}

// Batched System One query: one request carrying a question per tool id, so a
// whole tool set is scored in a single round-trip. The request shape is the same
// System One wire format as askSystemOne (model, state, questions) but with a key
// per tool; the response is read per key (answers.<id>.noul). Returns a map of
// id -> P(YES) in [0, 1]. Ids the backend did not answer are omitted, which
// lets a caller detect a backend that only honors a single question and fall
// back rather than treat silence as "not relevant".
async function askSystemOneMany(config: SystemOneConfig, state: string, questionsById: Record<string, string>): Promise<Record<string, number>> {
  const ids = Object.keys(questionsById);
  if (ids.length === 0) return {};

  const ask = async (model: string): Promise<Record<string, number> | null> => {
    const questions: Record<string, { type: string; instructions: string }> = {};
    for (const id of ids) questions[id] = { type: "noul", instructions: questionsById[id] };

    const response = await fetch(`${config.baseURL}/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const out: Record<string, number> = {};
    for (const id of ids) {
      const value = Number(data.answers?.[id]?.noul);
      if (Number.isFinite(value)) out[id] = Math.min(Math.max(value, 0), 1);
    }
    return out;
  };

  try {
    const primary = await ask(config.model);
    if (primary && Object.keys(primary).length > 0) return primary;
  } catch {
    // fall through to the fallback model
  }

  if (config.fallbackModel && config.fallbackModel !== config.model) {
    try {
      return (await ask(config.fallbackModel)) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

// Keep decision batches bounded for smaller local models while still replacing
// the old one-request-per-message compaction loop with a handful of batched calls.
async function askSystemOneManyChunked(
  config: SystemOneConfig,
  state: string,
  questionsById: Record<string, string>,
): Promise<Record<string, number>> {
  const entries = Object.entries(questionsById);
  const answers: Record<string, number> = {};
  for (let i = 0; i < entries.length; i += SYSTEMONE_MAX_BATCH_QUESTIONS) {
    const batch = Object.fromEntries(entries.slice(i, i + SYSTEMONE_MAX_BATCH_QUESTIONS));
    Object.assign(answers, await askSystemOneMany(config, state, batch));
  }
  return answers;
}

// Coalesce independent noul checks that arrive together from parallel tool
// executions (permissions, confidence, and post-edit checks). Sequential checks
// still run separately because their inputs only exist after each action.
function createSystemOneDecisionBatcher(config: SystemOneConfig): (state: string, question: string) => Promise<number | null> {
  const pending: Array<{
    state: string;
    question: string;
    resolve: (score: number | null) => void;
  }> = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, SYSTEMONE_DECISION_BATCH_WINDOW_MS);
  };

  const flush = async () => {
    const batch = pending.splice(0, pending.length);
    if (batch.length === 0) return;

    if (batch.length === 1) {
      try {
        batch[0].resolve(await askSystemOne(config, batch[0].state, batch[0].question));
      } catch {
        batch[0].resolve(null);
      }
    } else {
      const questionsById: Record<string, string> = {};
      batch.forEach((item, index) => {
        questionsById[`parallel_${index}`] = `Decision-specific context:\n${item.state}\n\nQuestion:\n${item.question}`;
      });
      try {
        const answers = await askSystemOneManyChunked(
          config,
          "Evaluate each independent item using only the context embedded in that item's question. Answer each one separately.",
          questionsById,
        );
        batch.forEach((item, index) => item.resolve(answers[`parallel_${index}`] ?? null));
      } catch {
        batch.forEach((item) => item.resolve(null));
      }
    }

    if (pending.length > 0) scheduleFlush();
  };

  return (state, question) => new Promise((resolve) => {
    pending.push({ state, question, resolve });
    scheduleFlush();
  });
}

// A "choice" decision: pick one option from named criteria. Returns the chosen key
// plus per-option probabilities and an overall confidence, or null when the model
// gives no usable answer. This is the primitive Reflex uses to select which sub-tool
// to dispatch — the decision model picks the tool in one forward pass. Uses the
// configured model (like every other classifier call) and falls back to
// fallbackModel when the primary gives no answer.
interface ChoiceAnswer {
  choice: string | null;
  probabilities: Record<string, number>;
  confidence: number | null;
}

async function askSystemOneChoice(
  config: SystemOneConfig,
  state: string,
  question: string,
  criteria: Record<string, string>,
): Promise<ChoiceAnswer | null> {
  if (Object.keys(criteria).length === 0) return null;

  const ask = async (model: string): Promise<ChoiceAnswer | null> => {
    const response = await fetch(`${config.baseURL}/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        state,
        questions: { q: { type: "choice", instructions: question, criteria } },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const answer = data.answers?.q;
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
  };

  let primary: ChoiceAnswer | null;
  try {
    primary = await ask(config.model);
  } catch {
    primary = null;
  }
  if (primary && primary.choice) return primary;

  if (config.fallbackModel && config.fallbackModel !== config.model) {
    try {
      return await ask(config.fallbackModel);
    } catch {
      return primary;
    }
  }
  return primary;
}

// Batched "choice" decisions: one request carrying a question per id, each with
// its own criteria, answered in a single round-trip. Used by history compaction to
// extract every digest bucket at once. Ids the backend did not answer are omitted,
// so a caller can tell a backend that only honors a single question and degrade
// gracefully. Falls back to fallbackModel when the primary returns nothing usable.
async function askSystemOneChoiceMany(
  config: SystemOneConfig,
  state: string,
  questionsById: Record<string, { instructions: string; criteria: Record<string, string> }>,
): Promise<Record<string, ChoiceAnswer>> {
  const ids = Object.keys(questionsById);
  if (ids.length === 0) return {};

  const ask = async (model: string): Promise<Record<string, ChoiceAnswer> | null> => {
    const questions: Record<string, any> = {};
    for (const id of ids) {
      questions[id] = { type: "choice", instructions: questionsById[id].instructions, criteria: questionsById[id].criteria };
    }
    const response = await fetch(`${config.baseURL}/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const out: Record<string, ChoiceAnswer> = {};
    for (const id of ids) {
      const answer = data.answers?.[id];
      if (!answer || answer.type !== "choice") continue;
      const probabilities: Record<string, number> = {};
      if (answer.probabilities && typeof answer.probabilities === "object") {
        for (const [key, value] of Object.entries(answer.probabilities)) {
          const n = Number(value);
          if (Number.isFinite(n)) probabilities[key] = n;
        }
      }
      out[id] = {
        choice: typeof answer.choice === "string" ? answer.choice : null,
        probabilities,
        confidence: Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : null,
      };
    }
    return out;
  };

  let primary: Record<string, ChoiceAnswer> | null;
  try {
    primary = await ask(config.model);
  } catch {
    primary = null;
  }
  if (primary && Object.keys(primary).length > 0) return primary;

  if (config.fallbackModel && config.fallbackModel !== config.model) {
    try {
      return (await ask(config.fallbackModel)) ?? {};
    } catch {
      return primary ?? {};
    }
  }
  return primary ?? {};
}

// Builds the structured digest from the compacted tail. For each bucket, the
// tail's own sentences that match the bucket's theme become candidate values, and
// one batched "choice" call asks the classifier to pick the single most
// representative one — so the digest preserves the SPECIFIC fact ("auth uses
// event-sourcing") rather than merely noting that the topic came up. Buckets with
// no matching sentences are skipped. Returns the digest lines, or an empty array
// when the classifier gives nothing usable (the caller then keeps the tail's most
// relevant messages and nothing is lost outright).
async function buildHistoryDigest(config: SystemOneConfig, tailText: string): Promise<{ lines: string[]; cacheable: boolean }> {
  // Split the tail into candidate sentences and score each against every bucket's
  // theme keywords. A sentence becomes a candidate for a bucket when it shares that
  // bucket's keywords.
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
  if (Object.keys(questionsById).length === 0) return { lines: [], cacheable: true };

  const answers = await askSystemOneChoiceMany(config, tailText, questionsById);

  const lines: string[] = [];
  for (const [key, bucket] of Object.entries(DIGEST_BUCKETS)) {
    const pick = answers[key]?.choice;
    if (!pick || pick === "none") continue;
    const idx = Number(pick.replace(/^v/, ""));
    const chosen = bucketSentences[key]?.[idx];
    if (chosen) lines.push(`- ${bucket.description}: ${chosen}`);
  }
  return { lines, cacheable: Object.keys(answers).length > 0 };
}

// ============ TOOL EXPOSURE (give the model only the tools a task needs) ============
// Tool schemas (description + JSON schema) are part of the model's input, so
// dropping tools the task cannot use saves input tokens. The decision is driven
// by System One and lives in the context hook, which owns the mutable event.tools
// map (a Record<name, {description, input}>); deleting a key removes the tool
// from the outgoing request.
//
// Always-keep core: these are never removed regardless of the classifier, so the
// model can always find/read/search/edit/shell out. Anything the model has already
// invoked this session is also kept, so a multi-step task never loses a tool
// mid-flight. reflex_run is likewise never removed (it is the optional fallback
// dispatch path), so the model can always reach for it when it cannot decide which
// tool to call. The confidence tool is kept too: the context hook may explicitly
// instruct the model to call it, while tool relevance scoring only sees the user
// prompt and could otherwise remove it as irrelevant. The tool-exposure recovery
// tool is also core so it can restore the tools removed by this hook.
const TOOL_CORE = new Set([
  "read",
  "grep",
  "glob",
  "edit",
  "write",
  "bash",
  "shell",
  "task",
  "reflex_run",
  CONFIDENCE_TOOL,
  TOOL_EXPOSURE_TOOL,
]);

// Fallback tiers used when the per-tool batch is not supported by the classifier
// backend (it only answers one question). Each tier is the set of tool-name
// prefixes that stay exposed; everything else is dropped. Ordered narrow -> wide.
const TOOL_TIERS: Array<{ match: (name: string) => boolean }> = [
  // READ: inspect/search only.
  { match: (n) => /^(read|grep|glob|ls|list|find)$/.test(n) || /_?(read|search|find|list|grep|glob)$/.test(n) },
  // EDIT: read + modify files (adds write/edit/patch-style tools, no shell).
  { match: (n) => /^(read|grep|glob|ls|list|find|edit|write|patch|multiedit)$/.test(n) || /_?(edit|write|patch)$/.test(n) },
  // FULL: everything (shell, web, task, subagents, etc.).
  { match: () => true },
];

// Picking a tier from one scalar relevance score: low -> READ, mid -> EDIT, high -> FULL.
function tierForScore(score: number): number {
  if (score <= 0.33) return 0;
  if (score <= 0.66) return 1;
  return 2;
}

// Renders a nested tool result into plain text the model can read. OpenCode tool
// results carry a `content` string (or content parts); this flattens it and falls
// back to JSON for unexpected shapes. This is what feeds the sub-tool's real output
// back through reflex_run to the model.
function renderToolOutput(result: any): string {
  if (result == null) return "(no output)";
  if (typeof result === "string") return result;
  const content = result?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part: any) => (typeof part === "string" ? part : part?.text ?? part?.content ?? ""))
      .filter((s: string) => s)
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// Truncates a long tool output for the model-facing result and points at the rest.
function truncateOutput(text: string, limit = 24_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[agent-reflex] output truncated (${text.length} chars total). Re-run with a narrower scope to see more.`;
}

// Runs the shell guardrail on a command: true when it looks dangerous (> 0.75).
// Fails open (false = allowed) when the classifier is unavailable, matching the
// plugin's guardrail convention. Shared by reflex_run's dispatch paths.
async function isDangerousCommandGuarded(
  config: SystemOneConfig,
  command: string,
  ask: (state: string, question: string) => Promise<number | null> = (state, question) => askSystemOne(config, state, question),
): Promise<boolean> {
  try {
    const danger = await ask(
      `Command to be executed in terminal: ${command}`,
      "Determine if this command may damage system files, remove directories without backup or leak environment keys."
    );
    return danger !== null && danger > 0.75;
  } catch {
    return false;
  }
}

// Deterministic tool selection by SCHEMA FIT: for each candidate tool, build its
// args from the model's task/target and check whether every REQUIRED param can be
// satisfied unambiguously. A tool whose required args cannot be filled is never
// dispatched (that is what 400s). Returns the fitting tools (each with its built
// args); when exactly one fits it is chosen with no classifier at all. When several
// fit, the choice among THEM is the one genuine ambiguity — resolved by the decision
// model, which is appropriate there because every option is already arg-satisfiable
// and it is given the task + each tool's schema as context (not a blind pick).
interface ToolCandidate {
  name: string;
  description: string;
  input: any;
}

function fitTools(
  candidates: ToolCandidate[],
  task: string,
  target: string,
): Array<{ name: string; description: string; input: any; args: Record<string, any>; missing: string[]; fallback: boolean }> {
  const fitting: Array<{ name: string; description: string; input: any; args: Record<string, any>; missing: string[]; fallback: boolean }> = [];
  for (const c of candidates) {
    const built = buildArgsFromSchema(c.input, task, target);
    // "Fits" = every required param is satisfied. A fallback (codec) schema counts as
    // fitting only when we can source at least one arg from task/target.
    const fits = built.fallback ? true : built.missing.length === 0;
    if (fits) fitting.push({ name: c.name, description: c.description, input: c.input, args: built.args, missing: built.missing, fallback: built.fallback });
  }
  return fitting;
}

// Renders a tool's real input schema as compact readable text for the decision
// model, so it judges which tool the task needs WITH full information (required
// params, types, and each field's own description) instead of guessing from the tool
// name alone. Handles both a plain JSON schema (.properties/.required) and an
// Effect/TypeBox codec (not introspectable -> a short note; the tool description
// carries the signal there).
function describeToolSchema(schema: any): string {
  if (!schema || typeof schema !== "object") return "";
  const props: Record<string, any> = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const names = Object.keys(props);
  if (names.length === 0) return "(args: see description)";
  const parts = names.map((n) => {
    const d = props[n] ?? {};
    const type = typeof d.type === "string" ? d.type : "any";
    const req = required.includes(n) ? "required" : "optional";
    const desc = typeof d.description === "string" && d.description ? `: ${d.description}` : "";
    return `${n} (${type}, ${req})${desc}`;
  });
  return `args: ${parts.join("; ")}`;
}

// Derives pseudo input-property hints from a tool's free-text description, so the
// schema-token arg mapper can source args even when the real schema is an
// Effect/TypeBox codec (not introspectable). Returns a properties map whose keys are
// conventional field names and whose descriptions carry the tool's own wording; the
// mapper then picks the value source from those tokens — still no intent guessing.
function inferPropsFromDescription(description: string): Record<string, any> {
  const d = String(description ?? "").toLowerCase();
  const props: Record<string, any> = {};
  if (/(?:command|shell|exec|run\b|terminal)/.test(d)) props.command = { type: "string", description: "shell command to execute" };
  if (/(?:read|file|path|open|load|cat\b)/.test(d)) props.path = { type: "string", description: "file path to read" };
  if (/(?:write|create|save|content|overwrite)/.test(d)) {
    props.path = props.path ?? { type: "string", description: "file path" };
    props.content = { type: "string", description: "text content to write" };
  }
  if (/(?:edit|replace|update|patch|new string)/.test(d)) {
    props.path = props.path ?? { type: "string", description: "file path to edit" };
    props.new_string = { type: "string", description: "replacement text" };
  }
  if (/(?:search|grep|find|pattern|query|match|glob)/.test(d)) props.pattern = { type: "string", description: "search pattern or query" };
  if (/(?:fetch|web|url|http|download|page)/.test(d)) props.url = { type: "string", description: "url to fetch" };
  return props;
}

// Builds a sub-tool's arguments MECHANICALLY from its real input JSON schema: each
// declared property is filled from the caller's task (the payload text) or target (a
// path / command / query / URL) based ONLY on the property's declared type and its
// own name/description tokens — never by guessing the tool's intent. Properties the
// schema requires but that task/target cannot supply are reported as missing, so the
// caller asks the model instead of dispatching garbage. Returns the args, the
// missing required names, and a `fallback` flag for schemas that are not
// introspectable (Effect/TypeBox codecs), where the caller sources args from the
// tool's own documented field names rather than guessing.
function buildArgsFromSchema(schema: any, task: string, target: string): { args: Record<string, any>; missing: string[]; fallback: boolean } {
  const args: Record<string, any> = {};
  const missing: string[] = [];
  const taskSourced: string[] = [];
  const props: Record<string, any> = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required: string[] = Array.isArray(schema?.required) ? schema.required : Object.keys(props);

  // Schema not introspectable (an Effect/TypeBox Schema.Codec with no .properties,
  // as Code Mode tools use). The decision model already saw the tool's description;
  // arg sourcing is left to the caller via the tool's own field names, NOT guessed.
  if (Object.keys(props).length === 0 && required.length === 0) {
    return { args: {}, missing: [], fallback: true };
  }

  // Value source purely from the property's own name + description tokens (a
  // "command"/"path"/"pattern"/"url"-named field takes the target; a
  // "content"/"new_string"/"text"-named field takes the task). No tool-intent logic.
  // `payload` flags fields that consume the task TEXT (whether or not it is the
  // field we finally fill) so multi-payload schemas are detected as ambiguous.
  const classify = (name: string, def: any): "task" | "target" | "payload" | undefined => {
    const hay = `${name} ${typeof def?.description === "string" ? def.description : ""}`.toLowerCase();
    if (/(?:command|cmd|script|exec|shell|\brun\b)/.test(hay)) return "target";
    if (/(?:path|file|filename|dir|directory|location)/.test(hay)) return "target";
    if (/(?:pattern|query|search|regex|glob|match|filter)/.test(hay)) return "target";
    if (/(?:url|href|uri|link|address)/.test(hay)) return "target";
    // Payload fields consume task text. new_string/content/replacement are the
    // canonical WRITE-target fields; old_string / *_string / *text* are also task
    // text (the value being written or replaced), so a schema wanting more than one
    // such field is ambiguous and none is filled.
    if (/(?:\bcontent\b|new_?string|replacement|\bbody\b|\bpayload\b|\binstructions\b)/.test(hay)) return "task";
    if (/(?:old_?string|_?string\b|\btext\b|\bsnippet\b|\bcode\b|\bvalue\b)/.test(hay)) return "payload";
    return undefined;
  };

  for (const [name, def] of Object.entries(props)) {
    const declaredType = (def as any)?.type;
    const cls = classify(name, def);
    if (cls === "target") {
      const raw = target;
      if (raw !== undefined && raw !== "") {
        args[name] = declaredType === "number" || declaredType === "integer" ? Number(raw) || 0 : declaredType === "boolean" ? Boolean(raw) : String(raw);
        continue;
      }
      if (required.includes(name)) missing.push(name);
      continue;
    }
    if (cls === "task" || cls === "payload") {
      // Task/payload fields are filled from `task` only when the schema wants the
      // task text in exactly ONE place (e.g. write's content). Several such fields
      // (e.g. edit's old_string + new_string) can't be split without guessing.
      taskSourced.push(name);
      continue;
    }
    // No clear source for this field: report it missing only if the schema REQUIRES
    // it. Optional unknowns are left unset. Never guess a value.
    if (required.includes(name)) missing.push(name);
  }

  // Fill the single unambiguous task->payload field, or leave all payload fields
  // missing when there are several (no guessing which the task text belongs to).
  if (taskSourced.length === 1 && task !== "") {
    const name = taskSourced[0];
    const declaredType = (props[name] as any)?.type;
    args[name] = declaredType === "number" || declaredType === "integer" ? Number(task) || 0 : declaredType === "boolean" ? Boolean(task) : String(task);
  } else {
    for (const name of taskSourced) {
      if (required.includes(name)) missing.push(name);
    }
  }

  // Any required prop still unassigned is missing — the caller asks the model for it.
  for (const name of required) {
    if (!(name in args) && !missing.includes(name)) missing.push(name);
  }

  return { args, missing, fallback: false };
}

// Tool-call pairing: a provider request must keep an assistant message with
// tool_calls together with its matching tool result(s). If compaction keeps one
// half while folding the other into the digest, the API rejects the request
// with "Cannot resolve tool name for tool_call_id=...". These helpers identify
// which tool-call ids a message participates in, so both halves can be treated
// as atomic (either both survive verbatim or both fold into the digest).
function toolCallLinkIds(msg: any): string[] {
  const ids: string[] = [];
  const messageToolId = msg?.tool_call_id ?? msg?.toolCallId ?? msg?.tool_use_id ?? msg?.toolUseId;
  if (messageToolId) ids.push(String(messageToolId));
  for (const call of msg?.tool_calls ?? []) {
    const id = call?.id ?? call?.tool_call_id;
    if (id) ids.push(String(id));
  }
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  for (const p of parts) {
    if (!["tool_use", "tool-call", "tool_result", "tool-result"].includes(String(p?.type))) continue;
    const id = p?.id ?? p?.tool_call_id ?? p?.tool_use_id ?? p?.toolCallId ?? p?.toolUseId;
    if (id) ids.push(String(id));
  }
  return ids;
}

function isToolCallPairMember(msg: any): boolean {
  if (msg?.role === "tool") return true;
  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) return true;
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  return parts.some((p: any) => ["tool_use", "tool-call", "tool_result", "tool-result"].includes(String(p?.type)));
}

// Expands a preserved-index set so no tool-call pair is ever split: every
// preserved pair member drags in the messages sharing its tool-call ids, and
// pair members whose partner already sits in the keep window are forced in too.
// `pairMembers` must cover ALL messages (distant past + recent window).
function closeToolCallPairs(
  preservedIdx: Set<number>,
  distantPast: any[],
  recentPast: any[]
): void {
  const all = [...distantPast, ...recentPast];
  // A call and its result share one tool-call id, so an id maps to EVERY message
  // that carries it (both halves), not just the last one. Keeping only the last
  // index would hide the distant half of a pair whose result sits in the recent
  // window, dropping the call while sending its result -> orphaned result.
  const idToIdx = new Map<string, number[]>();
  for (let i = 0; i < all.length; i++) {
    for (const id of toolCallLinkIds(all[i])) {
      const list = idToIdx.get(id);
      if (list) list.push(i);
      else idToIdx.set(id, [i]);
    }
  }
  // Pairs cut by the keep-window boundary: the recent half is always sent, so
  // the distant half must survive verbatim as well.
  for (let j = distantPast.length; j < all.length; j++) {
    for (const id of toolCallLinkIds(all[j])) {
      for (const i of idToIdx.get(id) ?? []) {
        if (i < distantPast.length) preservedIdx.add(i);
      }
    }
  }
  // Fixpoint: a preserved call's result is preserved, and that result's call too.
  let grown = true;
  while (grown) {
    grown = false;
    for (const i of [...preservedIdx]) {
      for (const id of toolCallLinkIds(all[i])) {
        for (const j of idToIdx.get(id) ?? []) {
          if (!preservedIdx.has(j)) {
            preservedIdx.add(j);
            grown = true;
          }
        }
      }
    }
  }
}

const CALL_PART_TYPES = ["tool_use", "tool-call"];
const RESULT_PART_TYPES = ["tool_result", "tool-result"];
const TOOL_PART_TYPES = new Set([...CALL_PART_TYPES, ...RESULT_PART_TYPES]);

function partToolId(p: any): string | undefined {
  const id = p?.id ?? p?.tool_call_id ?? p?.tool_use_id ?? p?.toolCallId ?? p?.toolUseId;
  return id ? String(id) : undefined;
}

function callIdsOf(msg: any): Set<string> {
  const ids = new Set<string>();
  for (const call of msg?.tool_calls ?? []) {
    const id = call?.id ?? call?.tool_call_id;
    if (id) ids.add(String(id));
  }
  for (const p of Array.isArray(msg?.content) ? msg.content : []) {
    if (CALL_PART_TYPES.includes(String(p?.type))) {
      const id = partToolId(p);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function resultIdsOf(msg: any): Set<string> {
  const ids = new Set<string>();
  if (msg?.role === "tool") {
    const messageToolId = msg?.tool_call_id ?? msg?.toolCallId ?? msg?.tool_use_id ?? msg?.toolUseId;
    if (messageToolId) ids.add(String(messageToolId));
  }
  for (const p of Array.isArray(msg?.content) ? msg.content : []) {
    if (RESULT_PART_TYPES.includes(String(p?.type))) {
      const id = partToolId(p);
      if (id) ids.add(id);
    }
  }
  return ids;
}

// Returns the message without the tool parts whose ids are not in `keepIds`, or
// null when that would leave it empty. Returns the same object when nothing changes.
function withoutToolParts(msg: any, keepIds: Set<string>): any | null {
  let changed = false;

  let content = msg?.content;
  if (Array.isArray(content)) {
    const kept = content.filter((p: any) => {
      if (!TOOL_PART_TYPES.has(String(p?.type))) return true;
      const id = partToolId(p);
      if (id && keepIds.has(id)) return true;
      changed = true;
      return false;
    });
    if (kept.length !== content.length) content = kept;
  }

  let toolCalls = msg?.tool_calls;
  if (Array.isArray(toolCalls)) {
    const kept = toolCalls.filter((c: any) => {
      const id = c?.id ?? c?.tool_call_id;
      if (id && keepIds.has(String(id))) return true;
      changed = true;
      return false;
    });
    if (kept.length !== toolCalls.length) toolCalls = kept;
  }

  if (msg?.role === "tool") {
    // OpenCode v2 stores the tool-call ID on each `tool-result` content part,
    // while OpenAI-compatible messages commonly store it on the message itself.
    // Accept either representation or valid results disappear during compaction.
    const messageToolId = msg?.tool_call_id ?? msg?.toolCallId ?? msg?.tool_use_id ?? msg?.toolUseId;
    const retainedPartResult = Array.isArray(content) && content.some((part: any) => {
      if (!RESULT_PART_TYPES.includes(String(part?.type))) return false;
      const id = partToolId(part);
      return Boolean(id && keepIds.has(id));
    });
    if (messageToolId ? !keepIds.has(String(messageToolId)) : !retainedPartResult) return null;
  }

  if (!changed) return msg;
  const hasText = typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0;
  if (!hasText && (!toolCalls || toolCalls.length === 0)) return null;
  return { ...msg, content, tool_calls: toolCalls };
}

// Final guard after compaction. A tool result is only valid when a matching call
// appears somewhere EARLIER, and a call is only valid when a matching result
// appears somewhere LATER. Compaction flattens distant-past (with interleaving
// messages folded into the digest) in front of the recent window, so a call and
// its result can end up separated by unrelated messages. Pairing must therefore
// scan the whole list, not just the immediately adjacent message: a stricter
// adjacency check deletes valid tool parts and breaks the call/result sequence
// ("Cannot resolve tool name for tool_call_id", "tool_use_id not found").
// Calls with no result anywhere and results with no call anywhere are dropped;
// a message left without any tool content is dropped. Multi-call turns are kept
// intact: every call id that resolves is preserved.
function dropOrphanToolParts(messages: any[]): any[] {
  // Every call id declared anywhere, and every result id seen anywhere.
  const allCallIds = new Set<string>();
  const allResultIds = new Set<string>();
  for (const msg of messages) {
    for (const id of callIdsOf(msg)) allCallIds.add(id);
    for (const id of resultIdsOf(msg)) allResultIds.add(id);
  }
  // An id survives only when its call and result both exist somewhere in the
  // list; order within the list is validated separately below.
  const linkedIds = new Set<string>();
  for (const id of allCallIds) if (allResultIds.has(id)) linkedIds.add(id);

  const out: any[] = [];
  const seenCallIds = new Set<string>(); // calls emitted so far (a result must follow one)

  for (const msg of messages) {
    const callIds = callIdsOf(msg);
    const resultIds = resultIdsOf(msg);

    // Keep a result only if its call already appeared earlier and both halves
    // are linked. Keep a call only if it is linked to a result that will appear
    // (its result may come later). Unlinked halves are dropped here.
    const keep = new Set<string>();
    for (const id of resultIds) {
      if (linkedIds.has(id) && seenCallIds.has(id)) keep.add(id);
    }
    for (const id of callIds) {
      if (linkedIds.has(id)) keep.add(id);
    }

    const cleaned = withoutToolParts(msg, keep);
    for (const id of callIds) seenCallIds.add(id);
    if (cleaned !== null) out.push(cleaned);
  }

  return out;
}

// Names of tools the model has already invoked in this session's transcript.
// These are kept no matter what, so a task that has already reached for a tool
// never loses it on a later turn of the same task.
function usedToolNames(messages: any[]): Set<string> {
  const used = new Set<string>();
  for (const msg of messages ?? []) {
    const calls = msg?.tool_calls ?? (Array.isArray(msg?.content) ? msg.content.filter((p: any) => p?.type === "tool_use" || p?.type === "tool-call") : []);
    for (const call of calls) {
      const name = call?.function?.name ?? call?.name;
      if (typeof name === "string" && name) used.add(name);
    }
  }
  return used;
}

// Applies precomputed request-level decisions to the mutable tool map. The
// per-tool scores are sent in the same batch as complexity and compaction scores;
// a single scalar tier fallback is used only if the backend answered none of them.
const TOOL_RELEVANCE_THRESHOLD = 0.35;

interface ToolExposurePlan {
  allNames: string[];
  candidates: string[];
}

interface RequestDecisionCache {
  promptKey: string;
  complexityResolved: boolean;
  complexityScore: number | null;
  toolAttempted: Set<string>;
  toolScoresByName: Record<string, number>;
  toolTierResolved: boolean;
  toolTierScore: number | null;
  historyScores: Map<string, number | null>;
}

function createRequestDecisionCache(promptKey: string): RequestDecisionCache {
  return {
    promptKey,
    complexityResolved: false,
    complexityScore: null,
    toolAttempted: new Set(),
    toolScoresByName: {},
    toolTierResolved: false,
    toolTierScore: null,
    historyScores: new Map(),
  };
}

function historyMessageKey(message: any): string {
  const role = String(message?.role ?? "unknown");
  if (typeof message?.id === "string" && message.id) return `${role}:id:${message.id}`;
  try {
    return `${role}:content:${JSON.stringify(message?.content ?? message)}`;
  } catch {
    return `${role}:content:${contentToText(message?.content)}`;
  }
}

function planToolExposure(
  config: SystemOneConfig,
  event: { tools: Record<string, unknown>; messages: any[] },
  forceAll: boolean,
  userPrompt: string,
): ToolExposurePlan | null {
  if (config.toolExposure !== "auto" || forceAll || !event.tools || !userPrompt.trim()) return null;
  const allNames = Object.keys(event.tools);
  const used = usedToolNames(event.messages);
  const candidates = allNames.filter((name) => !TOOL_CORE.has(name) && !used.has(name));
  return candidates.length > 0 ? { allNames, candidates } : null;
}

function applyToolExposure(
  config: SystemOneConfig,
  event: { tools: Record<string, unknown>; messages: any[] },
  forceAll = false,
  availableTools?: Record<string, unknown>,
  plan: ToolExposurePlan | null = null,
  scoresByName: Record<string, number> = {},
  tierScore: number | null = null,
): void {
  if (config.toolExposure !== "auto") return;
  const tools = event.tools;
  if (!tools) return;

  if (forceAll) {
    if (availableTools) {
      for (const name of Object.keys(tools)) {
        if (!(name in availableTools)) delete tools[name];
      }
      Object.assign(tools, availableTools);
      console.log(`[System One Tools]: Restored all ${Object.keys(tools).length} tools for this user request.`);
    }
    return;
  }

  if (!plan) return;
  const candidates = plan.candidates.filter((name) => name in tools);
  const answered = candidates.filter((name) => typeof scoresByName[name] === "number");
  if (answered.length > 0) {
    for (const name of candidates) {
      const score = scoresByName[name];
      // Drop only tools the backend explicitly deemed irrelevant. A candidate
      // the backend did not answer is kept (fail-open per tool).
      if (typeof score === "number" && score < TOOL_RELEVANCE_THRESHOLD) delete tools[name];
    }
    console.log(`[System One Tools]: Exposed ${Object.keys(tools).length}/${plan.allNames.length} tools (per-tool scoring).`);
    return;
  }

  // When the batched request returned no per-tool answers, the context hook has
  // already asked the scalar tier fallback and cached its answer for this prompt.
  if (tierScore !== null) {
    const tier = TOOL_TIERS[tierForScore(tierScore)];
    for (const name of candidates) {
      if (!tier.match(name)) delete tools[name];
    }
    console.log(`[System One Tools]: Exposed ${Object.keys(tools).length}/${plan.allNames.length} tools (tier ${tierForScore(tierScore)}).`);
  }
}

const EDIT_TOOLS = new Set(["edit", "write"]);

// The System One bug check runs only on medium and high complexity sessions, on the lines around the edit.
const SEMANTIC_CHECK_CONFIDENCE = 0.75;
const SEMANTIC_CHECK_CONTEXT_LINES = 40;
const SEMANTIC_CHECK_MAX_CHARS = 8_000;

// Returns the lines around the edited text, or the start of the file when the edit cannot be located.
function excerptAroundEdit(content: string, edited: unknown): string {
  const fallback = content.slice(0, SEMANTIC_CHECK_MAX_CHARS);
  if (typeof edited !== "string" || edited.length === 0) return fallback;

  const index = content.indexOf(edited);
  if (index === -1) return fallback;

  const lines = content.split("\n");
  const first = content.slice(0, index).split("\n").length - 1;
  const last = first + edited.split("\n").length - 1;
  const from = Math.max(0, first - SEMANTIC_CHECK_CONTEXT_LINES);
  const to = Math.min(lines.length, last + SEMANTIC_CHECK_CONTEXT_LINES + 1);

  return lines.slice(from, to).join("\n").slice(0, SEMANTIC_CHECK_MAX_CHARS);
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Command-line syntax checks: the file path is appended to the arguments.
const COMMAND_PARSERS: Record<string, [string, string[]]> = {
  ".sh": ["bash", ["-n"]],
  ".bash": ["bash", ["-n"]],
  ".zsh": ["zsh", ["-n"]],
  ".py": ["python3", ["-m", "py_compile"]],
  ".rb": ["ruby", ["-c"]],
  ".php": ["php", ["-l"]],
  ".pl": ["perl", ["-c"]],
  ".lua": ["luac", ["-p"]],
  ".go": ["gofmt", ["-e"]],
};

// Runs a parser and returns its error lines. Returns null when the parser is not installed.
async function runParser(command: string, args: string[]): Promise<string[] | null> {
  const { execFile } = await import("node:child_process");
  return new Promise((done) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (!error) return done([]);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return done(null);
      done(String(stderr || stdout || error.message).trim().split("\n").slice(-5));
    });
  });
}

// Returns syntax errors for the file, an empty list when it parses, or null when no parser covers its type.
async function findSyntaxErrors(filePath: string): Promise<string[] | null> {
  const { extname } = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const ext = extname(filePath).toLowerCase();

  if (TS_EXTENSIONS.has(ext)) {
    const ts: any = await import("typescript");
    const code = await readFile(filePath, "utf8");
    const result = ts.transpileModule(code, { fileName: filePath, reportDiagnostics: true });
    return (result.diagnostics ?? []).map((d: any) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (d.file && d.start !== undefined) {
        const { line } = d.file.getLineAndCharacterOfPosition(d.start);
        return `line ${line + 1}: ${message}`;
      }
      return message;
    });
  }

  if (ext === ".json") {
    try {
      JSON.parse(await readFile(filePath, "utf8"));
      return [];
    } catch (error: any) {
      return [error.message];
    }
  }

  const parser = COMMAND_PARSERS[ext];
  if (!parser) return null;
  const [command, args] = parser;
  return runParser(command, [...args, filePath]);
}

export default Plugin.define({
  id: "agent-reflex",

  async setup(ctx) {
    const config = resolveConfig((ctx.options ?? {}) as Record<string, unknown>);
    if (!config) {
      console.warn("[System One Orchestrator]: Missing 'model' or 'baseURL' in plugin options. Orchestration disabled.");
      return;
    }

    // DEPRECATED options, accepted for compatibility and ignored:
    // - "protocol": the classifier is always asked through the System One shape
    //   (model, state, questions) at <baseURL>/systemone, since System One
    //   models return typed decisions, never text.
    // - "primaryBackend": the effort dialect is detected per request from the
    //   model actually being requested, so every model gets its own effort
    //   fields automatically.
    const deprecated = ctx.options ?? {};
    if ("protocol" in deprecated) {
      console.warn("[System One Orchestrator]: The 'protocol' option is deprecated and has no effect. The classifier is always asked through the System One endpoint (<baseURL>/systemone).");
    }
    if ("primaryBackend" in deprecated) {
      console.warn("[System One Orchestrator]: The 'primaryBackend' option is deprecated and has no effect. Effort control is now automatic for every model that supports it.");
    }

    console.log(`[System One Orchestrator]: Initialized (${config.model} @ ${config.baseURL}), monitoring context...`);
    const askSystemOneQueued = createSystemOneDecisionBatcher(config);

    // Estado por sessão: complexidade da tarefa atual
    const levelBySession = new Map<string, EffortLevel>();
    const dynamicEffortBySession = new Map<string, boolean>();
    const requestDecisionsBySession = new Map<string, RequestDecisionCache>();
    const historyDigestBySession = new Map<string, { tailText: string; lines: string[] }>();
    // Snapshot the unfiltered tool map per user request so the recovery tool can
    // restore tools removed by auto exposure on the next model call.
    const availableToolsBySession = new Map<string, { promptKey: string; tools: Record<string, unknown> }>();
    const exposeAllToolsBySession = new Map<string, string>();

    // Consecutive failed checks per session and file. Reset when a check passes.
    const failuresByFile = new Map<string, number>();

    // ==========================================
    // HOOK 1: CONTEXT (COMPACTION + PARAMETERS + SUGGESTION)
    // Runs before every model call of the agent loop.
    // ==========================================
    await ctx.session.hook("context", async (event) => {
      const userEffortOverride = hasUserEffortOverride(event.model, event.options);
      dynamicEffortBySession.set(event.sessionID, !userEffortOverride);

      const messages = event.messages || [];
      if (messages.length < 1) return;

      const promptKey = latestUserPromptKey(messages);
      const userMessage = latestUserMessage(messages);
      const userPrompt0 = contentToText(userMessage?.content);
      let decisionCache = promptKey ? requestDecisionsBySession.get(event.sessionID) : undefined;
      if (promptKey && (!decisionCache || decisionCache.promptKey !== promptKey)) {
        if (decisionCache) levelBySession.delete(event.sessionID);
        decisionCache = createRequestDecisionCache(promptKey);
        requestDecisionsBySession.set(event.sessionID, decisionCache);
      }
      if (!decisionCache) decisionCache = createRequestDecisionCache(promptKey);

      const previousTools = availableToolsBySession.get(event.sessionID);
      const previousOverride = exposeAllToolsBySession.get(event.sessionID);
      if (
        promptKey &&
        ((previousTools && previousTools.promptKey !== promptKey) || (previousOverride && previousOverride !== promptKey))
      ) {
        availableToolsBySession.delete(event.sessionID);
        exposeAllToolsBySession.delete(event.sessionID);
      }

      const forceAllTools = Boolean(promptKey && exposeAllToolsBySession.get(event.sessionID) === promptKey);
      if (promptKey && event.tools && !forceAllTools) {
        const currentSnapshot = availableToolsBySession.get(event.sessionID);
        availableToolsBySession.set(event.sessionID, {
          promptKey,
          // Union within the same request so a reused event.tools object cannot
          // make an earlier auto-filter permanently lose tool definitions.
          tools: {
            ...(currentSnapshot?.promptKey === promptKey ? currentSnapshot.tools : {}),
            ...event.tools,
          },
        });
      }
      const availableTools = availableToolsBySession.get(event.sessionID);

      // Complexity, tool exposure and any uncached history scores are all
      // decisions about this request, so put them in one typed System One batch.
      // The results are cached by user-message ID and reused across tool turns.
      const exposurePlan = planToolExposure(config, event, forceAllTools, userPrompt0);
      const questionsById: Record<string, string> = {};
      const questionTargets = new Map<string, { kind: "complexity" | "tool" | "history"; name?: string; key?: string }>();
      let decisionQuestionNumber = 0;
      const addDecisionQuestion = (
        target: { kind: "complexity" | "tool" | "history"; name?: string; key?: string },
        instructions: string,
      ) => {
        const id = `decision_${decisionQuestionNumber++}`;
        questionsById[id] = instructions;
        questionTargets.set(id, target);
      };

      if (!decisionCache.complexityResolved) {
        if (userPrompt0 && !userPrompt0.includes("[object Object]")) {
          addDecisionQuestion(
            { kind: "complexity" },
            "Does this user request require deep logic thinking, complex algorithms or mathematical/concurrency bugs?",
          );
        } else {
          decisionCache.complexityResolved = true;
        }
      }

      for (const name of exposurePlan?.candidates ?? []) {
        if (decisionCache.toolAttempted.has(name)) continue;
        decisionCache.toolAttempted.add(name);
        addDecisionQuestion(
          { kind: "tool", name },
          `Would the "${name}" tool be needed to fully answer this user request? Answer YES only if this specific tool is likely required.`,
        );
      }
      const historyToScore = messages.length > COMPACT_MIN_MESSAGES
        ? messages.slice(0, -COMPACT_KEEP_RECENT.simple)
        : [];
      for (const msg of historyToScore) {
        const key = historyMessageKey(msg);
        if (decisionCache.historyScores.has(key)) continue;
        const msgContent = contentToText(msg.content) || JSON.stringify(msg.content);
        const excerpt = msgContent.length > COMPACT_SCORE_MAX_CHARS
          ? `${msgContent.slice(0, COMPACT_SCORE_MAX_CHARS)}… [message excerpt truncated]`
          : msgContent;
        addDecisionQuestion(
          { kind: "history", key },
          `Old history message:\n[${String(msg.role).toUpperCase()}]: ${excerpt}\n\nIs this message load-bearing context the model still needs — a requirement, rule, key decision, API shape, or prior finding that later work depends on? Answer YES only if losing it would change the answer.`,
        );
      }

      if (Object.keys(questionsById).length > 0) {
        const state = `User request: ${userPrompt0.trim() || "(no plain-text user request)"}`;
        let scores: Record<string, number> = {};
        try {
          scores = await askSystemOneManyChunked(config, state, questionsById);
        } catch (error: any) {
          console.warn(`[System One]: Batched request decisions failed (${error.message}); using fail-open defaults.`);
        }
        for (const [id, target] of questionTargets) {
          const score = scores[id];
          if (target.kind === "complexity") {
            decisionCache.complexityResolved = true;
            decisionCache.complexityScore = typeof score === "number" ? score : null;
          } else if (target.kind === "tool" && target.name) {
            if (typeof score === "number") decisionCache.toolScoresByName[target.name] = score;
          } else if (target.kind === "history" && target.key) {
            decisionCache.historyScores.set(target.key, typeof score === "number" ? score : null);
          }
        }
      }

      const toolCandidates = exposurePlan?.candidates ?? [];
      const hasPerToolAnswer = toolCandidates.some((name) => typeof decisionCache.toolScoresByName[name] === "number");
      if (hasPerToolAnswer) {
        decisionCache.toolTierResolved = true;
      }
      if (toolCandidates.length > 0 && !hasPerToolAnswer && !decisionCache.toolTierResolved) {
        decisionCache.toolTierScore = await askSystemOne(
          config,
          `User request: ${userPrompt0.trim()}`,
          "Does solving this request require running shell commands, editing or writing files, or anything beyond reading and searching? YES means it needs more than read-only tools.",
        );
        decisionCache.toolTierResolved = true;
      }
      if (promptKey) requestDecisionsBySession.set(event.sessionID, decisionCache);

      const complexityScore = decisionCache.complexityScore;
      const level: EffortLevel = complexityScore === null ? "medium" : classifyComplexity(complexityScore);

      // ---- SUB-ROUTINE A: DECISION-DRIVEN HISTORY COMPACTION ----
      // Keeps the most recent messages verbatim (keep window sized by the level),
      // keeps a bounded set of high-relevance older messages verbatim, and folds
      // the remaining older messages into one structured digest so their detail is
      // compressed rather than discarded.
      if (messages.length > COMPACT_MIN_MESSAGES) {
        const keepRecent = COMPACT_KEEP_RECENT[level];
        const distantPast = messages.slice(0, -keepRecent);
        const recentPast = messages.slice(-keepRecent);

        // Structural messages are scored too. Their decisions were included in
        // the request-level batch above and cached by message identity, so tool
        // continuations do not re-send the same old messages one by one.
        const scored: Array<{ msg: any; score: number | null }> = distantPast.map((msg) => ({
          msg,
          score: decisionCache.historyScores.get(historyMessageKey(msg)) ?? null,
        }));

        // Keep the highest-relevance older messages verbatim, bounded so a long
        // session cannot preserve its whole tail. A null score (classifier
        // unavailable) counts as relevant so we fail open, but the bound still holds.
        const ranked = scored
          .map((s, i) => ({ ...s, i, s: s.score ?? 1 }))
          .sort((a, b) => b.s - a.s);
        const preservedIdx = new Set<number>();
        for (const r of ranked) {
          if (preservedIdx.size >= COMPACT_MAX_PRESERVED) break;
          if (r.s > COMPACT_RELEVANCE_KEEP) preservedIdx.add(r.i);
        }
        // Tool-call pairs are atomic: keeping a call without its result (or the
        // reverse) makes the provider reject the whole request.
        closeToolCallPairs(preservedIdx, distantPast, recentPast);
        const preservedMessages = scored.filter((_, i) => preservedIdx.has(i)).map((s) => s.msg);
        const dropped = scored.filter((_, i) => !preservedIdx.has(i));

        // Structured digest of everything that did not survive verbatim.
        const tailText = dropped
          .map((s) => `[${String(s.msg.role).toUpperCase()}]: ${contentToText(s.msg.content) || JSON.stringify(s.msg.content)}`)
          .join("\n")
          .slice(0, 12_000);
        let digestLines: string[] = [];
        const cachedDigest = historyDigestBySession.get(event.sessionID);
        if (cachedDigest?.tailText === tailText) {
          digestLines = cachedDigest.lines;
        } else {
          try {
            const digest = await buildHistoryDigest(config, tailText);
            digestLines = digest.lines;
            if (digest.cacheable) historyDigestBySession.set(event.sessionID, { tailText, lines: digest.lines });
          } catch {
            digestLines = [];
          }
        }

        const compacted: any[] = [];
        if (digestLines.length > 0) {
          compacted.push({
            role: "system",
            type: "text",
            content: [
              {
                type: "text",
                text: `Earlier context in this session, compacted (the messages below were folded into these facts):\n${digestLines.join("\n")}`,
              },
            ],
          });
        }

        event.messages = dropOrphanToolParts([...compacted, ...preservedMessages, ...recentPast]);
        console.log(
          `[System One]: History compacted to ${event.messages.length} turns ` +
            `(${recentPast.length} recent + ${preservedMessages.length} preserved + ${digestLines.length} digest facts from ${dropped.length} messages).`
        );
      }

      // ---- SUB-ROUTINE B: PRE-EVALUATION AND COMPLEXITY INJECTION ----
      // Uses the cached request-level classification to set maxTokens and suggest
      // the confidence tool on medium/high tasks. Tool continuations reuse it.
      if (complexityScore !== null) {
        levelBySession.set(event.sessionID, level);
        if (!userEffortOverride) {
          // Clamp the level cap to opencode's pre-filled model-aware default
          // (model catalog output limit, fitted to the room the prompt leaves),
          // so a level cap never exceeds what the model can actually emit.
          const wanted = LEVEL_REQUEST[level].maxTokens;
          const cap = event.options.maxTokens;
          event.options.maxTokens =
            typeof cap === "number" && cap > 0 ? Math.min(wanted, cap) : wanted;
        }

        if (level === "simple") {
          console.log(`[System One]: Simple task (${(complexityScore * 100).toFixed(0)}%). Optimizing for speed.`);
        } else {
          console.log(`[System One]: ${level} complexity (${(complexityScore * 100).toFixed(0)}%). Optimizing for deep thinking.`);
          event.system.push({
            type: "text",
            text: `This is a ${level} complexity task. Before committing to a solution, consider calling the ${CONFIDENCE_TOOL} tool with your current plan and follow its verdict.`,
          });
        }
      }

      // ---- SUB-ROUTINE C: TOOL EXPOSURE (only the tools this task needs) ----
      // Drops tools whose schemas cannot help this request, so the model's input
      // carries fewer tool definitions. Fails open (keeps every tool) on any
      // classifier error and never drops the always-keep core or a tool the model
      // has already used this session. Runs last so it always has the final word
      // on event.tools for this request.
      applyToolExposure(
        config,
        event,
        forceAllTools,
        availableTools?.promptKey === promptKey ? availableTools.tools : undefined,
        exposurePlan,
        decisionCache.toolScoresByName,
        decisionCache.toolTierScore,
      );
    });

    // ==========================================
    // HOOK 2: EFFORT ON EVERY PRIMARY REQUEST
    // Applies the session's level to each request body, including tool continuations,
    // unless the agent has an explicit non-default effort/variant setting.
    // The dialect is detected per request from the model actually being requested
    // (event.model), so every model gets only the fields its own API accepts —
    // including when one gateway (OpenCode Go) proxies many models on one server.
    // Requests that speak none of the supported dialects stay untouched.
    // ==========================================
    await ctx.session.hook("http.request", async (event) => {
      if (event.kind !== "primary") return;
      if (dynamicEffortBySession.get(event.sessionID) !== true) return;
      const level = levelBySession.get(event.sessionID);
      if (!level) return;

      let body: any;
      try {
        body = JSON.parse(await event.request.clone().text());
      } catch {
        return;
      }

      const dialect = detectBackend(event.model, body, event.request.url);
      if (!dialect) return;

      try {
        if (dialect === "anthropic") {
          body.output_config = { ...body.output_config, effort: LEVEL_REQUEST[level].effort };
        } else if (dialect === "openai") {
          if (!applyOpenAiLevel(body, level, event.request.url)) return;
        } else if (dialect === "zai") {
          if (!applyZaiLevel(body, level, event.request.url)) return;
        } else if (dialect === "mimo") {
          if (!applyMimoLevel(body, level, event.request.url)) return;
        } else if (dialect === "gemini") {
          if (!applyGeminiLevel(body, level, event.request.url)) return;
        } else if (dialect === "qwen") {
          if (!applyQwenLevel(body, level, event.request.url)) return;
        } else if (dialect === "kimi") {
          if (!applyKimiLevel(body, level, event.request.url)) return;
        } else if (dialect === "grok") {
          if (!applyGrokLevel(body, level, event.request.url)) return;
        } else if (dialect === "minimax") {
          if (!applyMiniMaxLevel(body, level, event.request.url)) return;
        } else {
          // Local inference server, its kind probed once per origin.
          // Ollama and llama.cpp both take top-level reasoning_effort on
          // /v1/chat/completions (levels scale thinking, with model-defined
          // names and compatibility aliases on Ollama); llama.cpp additionally
          // takes chat_template_kwargs for Qwen-style on/off templates while
          // reasoning_effort covers gpt-oss-style ones. LM Studio's
          // OpenAI-compatible endpoint documents no reasoning field, so its
          // requests stay untouched.
          const pathname = event.request.url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
          if (!/\/chat\/completions$/i.test(pathname)) return;
          const server = await detectLocalServer(event.request.url);
          if (!server || server === "lmstudio") return;
          if (server === "llamacpp") {
            body.chat_template_kwargs = {
              ...body.chat_template_kwargs,
              enable_thinking: LEVEL_REQUEST[level].thinking,
            };
          }
          body.reasoning_effort = LOCAL_EFFORT[level];
        }
      } catch (error: any) {
        // The effort rewrite must never fail the primary request. A rejection by the
        // remote API cannot be caught here, which is why a request is only rewritten
        // after its dialect was confirmed.
        console.warn(`[Effort Warning]: Skipped effort rewrite for ${event.request.url}: ${error.message}`);
        return;
      }

      const headers = new Headers(event.request.headers);
      headers.delete("content-length");
      event.request = new Request(event.request.url, {
        method: event.request.method,
        headers,
        body: JSON.stringify(body),
      });
    });

    // ==========================================
    // DEBUG: LOG OUTGOING REQUEST BODY (enable with "debugLog" option)
    // ==========================================
    if (config.debugLog) {
      const logPath = config.debugLog;
      await ctx.session.hook("http.request", async (event) => {
        if (event.kind !== "primary") return;
        const body = await event.request.clone().text();
        const { appendFile } = await import("node:fs/promises");
        await appendFile(logPath, `--- ${new Date().toISOString()} ${event.request.url}\n${body}\n`);
      });
    }

    // ==========================================
    // TOOL: ON-DEMAND CONFIDENCE CHECK
    // The model passes its current line of thought and decides whether to restart.
    // ==========================================
    await ctx.tool.transform((editor) => {
      editor.add({
        name: CONFIDENCE_TOOL,
        description:
          "Ask System One to evaluate your current line of thought before you commit to it. Pass your reasoning so far, or your draft solution. Returns a confidence score and a verdict. If the verdict is RESTART, discard that line of thought and solve the problem again more directly.",
        input: {
          type: "object",
          properties: {
            thought: {
              type: "string",
              description: "Your current line of thought or draft solution to evaluate.",
            },
          },
          required: ["thought"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const sessionID: string = context?.sessionID ?? "";
          const thought = String(input?.thought ?? "").trim();
          if (!thought) return { content: "No thought provided. Pass your current reasoning in `thought`." };

          const level = levelBySession.get(sessionID) ?? "simple";
          const threshold = level === "simple" ? 0.75 : 0.85;

          try {
            const confidence = await askSystemOneQueued(
              `AI line of thought:\n${thought}`,
              "Does this line of thought seem direct, correct and without hesitation or redundant loops?"
            );

            if (confidence === null) {
              return { content: "System One confidence check unavailable. Continue with your current approach." };
            }

            const pct = (confidence * 100).toFixed(1);
            console.log(`[System One Tool]: Thought confidence ${pct}% (threshold ${threshold * 100}%).`);

            if (confidence < threshold) {
              return {
                content: `Confidence ${pct}% is below the ${threshold * 100}% threshold. Verdict: RESTART. Discard this line of thought and solve the problem again, focusing on the cleanest, most direct solution.`,
              };
            }
            return { content: `Confidence ${pct}%. Verdict: CONTINUE.` };
          } catch (error: any) {
            return { content: `System One confidence check failed (${error.message}). Continue with your current approach.` };
          }
        },
      });
    });

    // ==========================================
    // TOOL: RECOVER THE FULL TOOL SET FOR THIS USER REQUEST
    // ==========================================
    await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL_EXPOSURE_TOOL,
        description:
          "Recovery path when reflex_run did not produce the needed result or you need a different direct tool. Lists the tools available to this agent and restores all their tool schemas for the rest of this user request. This tool does not execute another tool; choose one from the returned inventory and call it directly.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async (_input: any, context: any) => {
          const sessionID = String(context?.sessionID ?? "");
          if (!sessionID) {
            return { content: `[${TOOL_EXPOSURE_TOOL}] Cannot identify the current session; automatic tool exposure was not changed.` };
          }

          const snapshot = availableToolsBySession.get(sessionID);
          if (!snapshot) {
            return { content: `[${TOOL_EXPOSURE_TOOL}] No tool snapshot was captured for this user request, so I could not restore the request's original tool set.` };
          }

          exposeAllToolsBySession.set(sessionID, snapshot.promptKey);
          const inventory = Object.entries(snapshot.tools)
            .map(([name, value]) => {
              const description = String((value as any)?.description ?? "").replace(/\s+/g, " ").trim();
              const summary = description.length > 240 ? `${description.slice(0, 237)}...` : description;
              return `- \`${name}\`${summary ? `: ${summary}` : ""}`;
            })
            .join("\n");

          console.log(`[System One Tools]: Full tool exposure requested for session ${sessionID}.`);
          return {
            content:
              `[${TOOL_EXPOSURE_TOOL}] Restored all ${Object.keys(snapshot.tools).length} tools for the rest of this user request. ` +
              `Their complete schemas will be included on the next model turn. No tool was executed. Choose a tool from this inventory and call it directly; automatic filtering resumes on the next user request.\n\n` +
              (inventory || "(No tools were available in the captured request.)"),
          };
        },
      });
    });

    // ==========================================
    // reflex_run: DECISION-MODEL TOOL DISPATCH (OPTIONAL FALLBACK)
    // A fallback the model reaches for ONLY when it cannot decide which underlying
    // tool to call for a task. It is not the default path — the model calls the real
    // tools directly whenever it knows which one fits. When it is unsure, its
    // execute() asks the System One decision model ("choice") which sub-tool handles
    // the task, dispatches that tool via its registered execute(), and FEEDS THE
    // SUB-TOOL'S REAL OUTPUT BACK into this tool's result so the model sees what
    // actually happened. The decision model is the configured model (same as every
    // other classifier call); arguments come from the model's own reflex_run call.
    // The shell guardrail runs before dispatch, so it is enforced however reflex_run
    // is invoked.
    // ==========================================
    const REFLEX_RUN_TOOL = "reflex_run";
    await ctx.tool.transform((editor) => {
      editor.add({
        name: REFLEX_RUN_TOOL,
        description:
          "Fallback dispatcher for when you cannot decide which underlying tool to call for a task. Pass the intent and any target (a file path, a shell command, a search query); Reflex picks the right tool, runs it, and returns its real output. Prefer calling tools directly when you already know which one to use — reach for this only when the correct tool is unclear.",
        input: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "What to do, as plain intent (e.g. 'read the config', 'run the test suite', 'find where parseFoo is defined').",
            },
            target: {
              type: "string",
              description: "The concrete target: a file path to read/edit, a shell command to run, or a search term. Optional.",
            },
          },
          required: ["task"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const task = String(input?.task ?? "").trim();
          const target = String(input?.target ?? "").trim();
          if (!task && !target) {
            return { content: "No task provided. Pass what to do in `task`, and a file path/command/query in `target`." };
          }

          // Pool-driven: read the REAL registered tool pool and dispatch from it —
          // no hardcoded tool catalog or guessed arg shapes. Meta-tools (reflex_run
          // itself and the Code Mode infrastructure) are not dispatch targets.
          const META = new Set(["reflex_run", TOOL_EXPOSURE_TOOL, "execute", "search", "skill", "question", "subagent"]);
          let registered: any[] = [];
          try {
            registered = [...(await ctx.tool.list())];
          } catch {
            registered = [];
          }
          const pool: Array<{ name: string; description: string; input: any }> = [];
          const byName = new Map<string, any>();
          for (const t of registered) {
            const name = String(t?.id ?? t?.name ?? "");
            if (!name || META.has(name)) continue;
            if (typeof t?.execute !== "function") continue;
            pool.push({ name, description: String(t?.description ?? name), input: (t as any)?.input });
            byName.set(name, t);
          }
          if (pool.length === 0) {
            return { content: "[reflex_run] No dispatchable tools are registered in this session." };
          }

          // Deterministic selection by schema fit: only tools whose required args the
          // model's task/target can actually satisfy are ever dispatched. If exactly
          // one fits, it is used with no classifier. If several fit, that is the one
          // genuine ambiguity and the decision model breaks the tie among THEM (it is
          // given the task + each tool's real schema as context, and every option is
          // already arg-satisfiable — not a blind pick). No fit -> report, never
          // dispatch an unfit tool.
          const fitting = fitTools(pool, task, target);
          if (fitting.length === 0) {
            return { content: `[reflex_run] No registered tool's required arguments can be satisfied by the given task/target. Call a tool directly with explicit arguments.` };
          }

          let chosen: ToolCandidate & { args: Record<string, any>; missing: string[]; fallback: boolean };
          if (fitting.length === 1) {
            chosen = fitting[0];
          } else {
            const state = `User task: ${task}${target ? `\nTarget: ${target}` : ""}`;
            const criteria: Record<string, string> = {};
            for (const t of fitting) {
              const schemaText = describeToolSchema(t.input);
              criteria[t.name] = schemaText ? `${t.description} | ${schemaText}` : t.description;
            }
            const picked = await askSystemOneChoice(
              config,
              state,
              "These tools can all take the given arguments. Which one best matches the task? Consider each tool's description and input schema.",
              criteria,
            );
            chosen = fitting.find((t) => t.name === picked?.choice) ?? fitting[0];
          }

          const chosenName = chosen.name;
          const entry = byName.get(chosenName);
          let args = chosen.args;
          let missing = chosen.missing;
          if (chosen.fallback) {
            // Schema not introspectable (Effect/TypeBox codec). Source args from the
            // tool's own description via the schema-token mapper; fall back to a single
            // conventional arg by the tool's broad category taken from its description.
            const inferred = buildArgsFromSchema({ properties: inferPropsFromDescription(entry?.description), required: [] }, task, target);
            args = inferred.args;
            if (Object.keys(args).length === 0) {
              const desc = String(entry?.description ?? "").toLowerCase();
              if (/(?:command|shell|exec|run\b)/.test(desc)) args = { command: target || task };
              else if (/(?:read|file|path|open)/.test(desc)) args = { path: target, filePath: target };
              else if (/(?:search|grep|find|pattern|query)/.test(desc)) args = { pattern: target || task, query: target || task };
              else if (/(?:fetch|web|url|http)/.test(desc)) args = { url: target };
              else if (/(?:write|content|create)/.test(desc)) args = { path: target, content: task };
              else return { content: `[reflex_run] Cannot infer the arguments for \`${chosenName}\` from its schema/description. Call it directly with explicit arguments.` };
            }
            missing = [];
          }
          const conf = fitting.length === 1 ? "schema-fit" : "tie-broken";
          if (missing.length > 0) {
            return {
              content: `[reflex_run] \`${chosenName}\` needs argument(s) the task/target did not supply: ${missing.join(", ")}. Re-invoke reflex_run with more detail, or call \`${chosenName}\` directly with explicit arguments.`,
            };
          }

          // Guardrail before dispatching a shell-like tool (its schema takes a command).
          const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
          const isShell = Boolean(command) || /command|cmd|script|exec/i.test(Object.keys(args).join(" "));
          if (isShell && command && (await isDangerousCommandGuarded(config, command, askSystemOneQueued))) {
            return { content: `[GUARDRAIL BLOCKED]: Potentially dangerous command aborted. Not running it: ${command}` };
          }

          // Dispatch and feed the sub-tool's REAL output back to the model.
          try {
            const result = await entry.execute(args, context);
            const output = truncateOutput(renderToolOutput(result));
            return { content: `[reflex_run] Delegated to \`${chosenName}\` (${conf} confident).\n\n${output}` };
          } catch (error: any) {
            return { content: `[reflex_run] Failed to run \`${chosenName}\`: ${error?.message ?? error}` };
          }
        },
      });
    });

    // ==========================================
    // HOOK 3: SHELL GUARDRAIL (PERMISSION EVALUATION)
    // Escalates shell commands to "deny" when the classifier flags them.
    // ==========================================
    await ctx.permission.hook("evaluate", async (event) => {
      const commandText =
        typeof event.metadata?.command === "string" ? event.metadata.command : event.resources.join(" ");

      if (config.debugLog) {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(
          config.debugLog,
          `--- ${new Date().toISOString()} permission action=${event.action} effect=${event.effect} resources=${JSON.stringify(event.resources)} metadata=${JSON.stringify(event.metadata ?? {})}\n`
        );
      }

      if (!SHELL_ACTIONS.has(event.action)) return;
      if (!commandText) return;

      try {
        const dangerScore = await askSystemOneQueued(
          `Command to be executed in terminal: ${commandText}`,
          "Determine if this command may damage system files, remove directories without backup or leak environment keys."
        );

        if (config.debugLog) {
          const { appendFile } = await import("node:fs/promises");
          await appendFile(config.debugLog, `--- guard score=${dangerScore} command=${JSON.stringify(commandText)}\n`);
        }

        if (dangerScore !== null && dangerScore > 0.75) {
          event.effect = "deny";
          event.message = "[GUARDRAIL BLOCKED]: Potentially dangerous command aborted.";
        }
      } catch (error: any) {
        console.warn(`[Guardrail Warning]: Failed to check command safety: ${error.message}`);
      }
    });

    // ==========================================
    // HOOK 4: SYNTAX CHECK AFTER EDITS
    // Reports parser errors back to the agent so it can fix them on the next turn.
    // ==========================================
    await ctx.tool.hook("execute.after", async (event: any) => {
      if (event.status !== "completed" || !EDIT_TOOLS.has(event.tool)) return;

      const rawPath = event.input?.filePath ?? event.args?.filePath;
      if (typeof rawPath !== "string" || !rawPath) return;

      const filePath = rawPath.startsWith("/") ? rawPath : `${ctx.location.directory}/${rawPath}`;

      try {
        let errors: string[] = [];
        try {
          errors = (await findSyntaxErrors(filePath)) ?? [];
        } catch (error: any) {
          console.warn(`[Syntax Check Warning]: Parser failed for ${filePath}: ${error.message}`);
        }
        const notes: string[] = [];

        if (errors.length > 0) {
          notes.push(
            `[Syntax check]: ${filePath} has ${errors.length} syntax error(s). Fix them before continuing:\n` +
              errors.map((e) => `- ${e}`).join("\n")
          );
        } else {
          const sessionID: string | undefined = event.sessionID ?? event.context?.sessionID;
          const level = sessionID ? levelBySession.get(sessionID) : undefined;

          if (level === "medium" || level === "high") {
            const { readFile } = await import("node:fs/promises");
            const content = await readFile(filePath, "utf8");
            const edited = event.input?.newString ?? event.input?.content ?? event.args?.newString ?? event.args?.content;
            const excerpt = excerptAroundEdit(content, edited);
            const bugScore = await askSystemOneQueued(
              `Excerpt of edited file ${filePath}. It contains only the edited code plus ${SEMANTIC_CHECK_CONTEXT_LINES} lines on each side, so code outside it is not shown:\n${excerpt}`,
              "Does this code contain a bug that would prevent it from running or produce a wrong result? Judge only the visible excerpt; do not assume bugs in code that is not shown."
            );
            const correctness = bugScore === null ? null : 1 - bugScore;
            if (correctness !== null && correctness < SEMANTIC_CHECK_CONFIDENCE) {
              notes.push(
                `[System One check]: The edit to ${filePath} is only ${(correctness * 100).toFixed(0)}% confident to be correct (threshold ${SEMANTIC_CHECK_CONFIDENCE * 100}%). Review it before continuing.`
              );
            }
          }
        }

        const key = `${event.sessionID ?? ""}:${filePath}`;
        if (notes.length === 0) {
          failuresByFile.delete(key);
          return;
        }

        const failures = (failuresByFile.get(key) ?? 0) + 1;
        if (failures === 1) {
          failuresByFile.set(key, failures);
          notes.push("Retry once: fix the problem above, then edit the file again.");
        } else {
          failuresByFile.delete(key);
          notes.push("The check still fails after one retry. Stop and ask the user how to proceed before editing this file again.");
        }

        if (typeof event.result?.content === "string") {
          event.result = { ...event.result, content: event.result.content + "\n\n" + notes.join("\n\n") };
        }
      } catch (error: any) {
        console.warn(`[Syntax Check Warning]: Skipped ${filePath}: ${error.message}`);
      }
    });
  }
});
