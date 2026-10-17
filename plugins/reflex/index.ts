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

// Requested settings per complexity level.
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
    // on the wire instead (the field OpenCode itself sends on this route).
    body.max_completion_tokens = LEVEL_REQUEST[level].maxTokens;
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
  // Local inference servers (llama.cpp, Ollama) on loopback or LAN hosts.
  if (isLocalHost(url)) return "local";
  return null;
}

// Permission actions that carry a shell command.
const SHELL_ACTIONS = new Set(["bash", "shell", "terminal"]);

const CONFIDENCE_TOOL = "systemone_check_confidence";

// Effort dialect a primary request may speak, decided per request from the model
// being requested. "local": a local inference server (llama.cpp or Ollama) on a
// loopback or LAN host.
type EffortDialect = "anthropic" | "openai" | "zai" | "mimo" | "gemini" | "qwen" | "local";

interface SystemOneConfig {
  baseURL: string;
  model: string;
  // Optional classifier fallback: retried once (same endpoint and key) when the
  // primary model rejects the request, e.g. when a limited-time free model
  // window closes.
  fallbackModel?: string;
  apiKey?: string;
  debugLog?: string;
}

function resolveConfig(options: Record<string, unknown>): SystemOneConfig | null {
  const provider = (options.provider as ProviderPreset | undefined) ?? "custom";
  const baseURL = (options.baseURL as string | undefined) ?? PRESET_BASE_URLS[provider];
  const model = options.model as string | undefined;
  if (!baseURL || !model) return null;

  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    model,
    fallbackModel: typeof options.fallbackModel === "string" ? options.fallbackModel : undefined,
    apiKey: options.apiKey as string | undefined,
    debugLog: typeof options.debugLog === "string" ? options.debugLog : undefined,
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => b.text || b.content || "").join(" ");
  return "";
}

function isStructuralMessage(msg: any): boolean {
  if (msg?.role === "tool") return true;
  return Array.isArray(msg?.content) && msg.content.some((part: any) => part?.type && part.type !== "text");
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

    // Estado por sessão: complexidade da tarefa atual
    const levelBySession = new Map<string, EffortLevel>();

    // Consecutive failed checks per session and file. Reset when a check passes.
    const failuresByFile = new Map<string, number>();

    // ==========================================
    // HOOK 1: CONTEXT (COMPACTION + PARAMETERS + SUGGESTION)
    // Runs before every model call of the agent loop.
    // ==========================================
    await ctx.session.hook("context", async (event) => {
      const messages = event.messages || [];
      if (messages.length < 1) return;

      // ---- SUB-ROUTINE A: CUSTOM COMPACTION ----
      if (messages.length > 16) {
        console.log(`\n[System One]: Analyzing token relevance for history pruning...`);

        const distantPast = messages.slice(0, -4);
        const recentPast = messages.slice(-4);
        const preservedMessages: any[] = [];

        // Avalia individualmente quais mensagens merecem ser mantidas
        for (const msg of distantPast) {
          // Tool calls and their results must stay paired, so structural messages are never pruned
          if (isStructuralMessage(msg)) {
            preservedMessages.push(msg);
            continue;
          }

          const msgContent = contentToText(msg.content) || JSON.stringify(msg.content);

          try {
            // Decisão binária: preserva se a probabilidade de relevância for maior que 40%
            const keepProbability = await askSystemOne(
              config,
              `Old history message:\n[${String(msg.role).toUpperCase()}]: ${msgContent}`,
              "Does this message contain architectural requirements, scope definitions or crucial rules the model needs to remember to code on?"
            );

            // Fallback de segurança (null) preserva a mensagem
            if (keepProbability === null || keepProbability > 0.40) {
              preservedMessages.push(msg);
            } else {
              console.log(`[System One Prune]: Discarding redundant turn from [${msg.role}].`);
            }
          } catch {
            preservedMessages.push(msg);
          }
        }

        // Substitui o histórico pesado apenas pelas mensagens sobreviventes + contexto recente
        event.messages = [...preservedMessages, ...recentPast];
        console.log(`[System One]: Pruning complete. History optimized to ${event.messages.length} turns.`);
      }

      // ---- SUB-ROUTINE B: PRE-EVALUATION AND COMPLEXITY INJECTION ----
      const lastMessage = event.messages[event.messages.length - 1];
      const userPrompt = contentToText(lastMessage.content);

      if (!userPrompt || userPrompt.includes("[object Object]")) return;

      try {
        const score = await askSystemOne(
          config,
          `User prompt: ${userPrompt.trim()}`,
          "Does this prompt require deep logic thinking, complex algorithms or mathematical/concurrence bugs?"
        );
        if (score === null) return;

        const level = classifyComplexity(score);
        levelBySession.set(event.sessionID, level);
        event.options.maxTokens = LEVEL_REQUEST[level].maxTokens;

        if (level === "simple") {
          console.log(`[System One]: Simple task (${(score * 100).toFixed(0)}%). Optimizing for speed.`);
        } else {
          console.log(`[System One]: ${level} complexity (${(score * 100).toFixed(0)}%). Optimizing for deep thinking.`);
          event.system.push({
            type: "text",
            text: `This is a ${level} complexity task. Before committing to a solution, consider calling the ${CONFIDENCE_TOOL} tool with your current plan and follow its verdict.`,
          });
        }
      } catch (error: any) {
        console.warn(`[Modulator Warning]: Failed to modulate parameters: ${error.message}`);
      }
    });

    // ==========================================
    // HOOK 2: EFFORT ON EVERY PRIMARY REQUEST
    // Applies the session's level to each request body, including tool continuations.
    // The dialect is detected per request from the model actually being requested
    // (event.model), so every model gets only the fields its own API accepts —
    // including when one gateway (OpenCode Go) proxies many models on one server.
    // Requests that speak none of the supported dialects stay untouched.
    // ==========================================
    await ctx.session.hook("http.request", async (event) => {
      if (event.kind !== "primary") return;
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
            const confidence = await askSystemOne(
              config,
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
        const dangerScore = await askSystemOne(
          config,
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
            const bugScore = await askSystemOne(
              config,
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
