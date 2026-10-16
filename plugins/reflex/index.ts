import { Plugin } from "@opencode/plugin";

type ProviderPreset = "llamacpp" | "ollama" | "lmstudio" | "custom";

// Default OpenAI-compatible endpoints for local runtimes.
const LOCAL_PRESETS: Record<string, string | undefined> = {
  llamacpp: "http://127.0.0.1:8080/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

const REQUEST_TIMEOUT_MS = 20_000;

// Requested settings per complexity level.
// effort: Anthropic output_config.effort. thinking: llama.cpp chat template enable_thinking (no levels there).
// maxTokens: level cap on generated tokens, sent through event.options (ignored by the
// OpenCode Go provider) and enforced on the wire for Z.ai GLM (max_completion_tokens).
const LEVEL_REQUEST = {
  simple: { maxTokens: 8192, effort: "low", thinking: false },
  medium: { maxTokens: 65536, effort: "medium", thinking: true },
  high: { maxTokens: 131072, effort: "high", thinking: true },
} as const;

type EffortLevel = keyof typeof LEVEL_REQUEST;

// Complexity score cut-offs: above 0.60 is medium, above 0.85 is high.
function classifyComplexity(score: number): EffortLevel {
  if (score > 0.85) return "high";
  if (score > 0.60) return "medium";
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

// Permission actions that carry a shell command.
const SHELL_ACTIONS = new Set(["bash", "shell", "terminal"]);

const CONFIDENCE_TOOL = "systemone_check_confidence";

// "openai": any OpenAI-compatible chat endpoint (llama.cpp, Ollama, LM Studio, remote providers).
// "systemone": the System One server's native /systemone endpoint (questions/answers API).
type Protocol = "openai" | "systemone";

// Backend of the main agent model, which decides the request field used for effort.
type PrimaryBackend = "anthropic" | "llamacpp" | "openai" | "zai";

interface SystemOneConfig {
  baseURL: string;
  model: string;
  apiKey?: string;
  protocol: Protocol;
  debugLog?: string;
  primaryBackend?: PrimaryBackend;
}

function resolveConfig(options: Record<string, unknown>): SystemOneConfig | null {
  const provider = (options.provider as ProviderPreset | undefined) ?? "custom";
  const baseURL = (options.baseURL as string | undefined) ?? LOCAL_PRESETS[provider];
  const model = options.model as string | undefined;
  if (!baseURL || !model) return null;

  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    model,
    apiKey: options.apiKey as string | undefined,
    protocol: options.protocol === "systemone" ? "systemone" : "openai",
    debugLog: typeof options.debugLog === "string" ? options.debugLog : undefined,
    primaryBackend:
      options.primaryBackend === "anthropic" ||
      options.primaryBackend === "llamacpp" ||
      options.primaryBackend === "openai" ||
      options.primaryBackend === "zai"
        ? options.primaryBackend
        : undefined,
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

// Asks a yes/no question to any OpenAI-compatible chat endpoint and returns P(YES) in [0, 1].
// Returns null when the model gives no usable number.
async function askProbability(config: SystemOneConfig, state: string, question: string): Promise<number | null> {
  if (config.protocol === "systemone") return askSystemOne(config, state, question);

  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 16,
      messages: [
        {
          role: "system",
          content: "You are a binary classifier. Reply with ONLY a decimal number between 0 and 1: the probability that the answer to the question is YES. No words, no explanation.",
        },
        { role: "user", content: `Context:\n${state}\n\nQuestion: ${question}` },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as any;
  const text: string = data.choices?.[0]?.message?.content ?? "";
  const visible = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const match = visible.match(/\d*\.?\d+/);
  if (!match) return null;

  let value = parseFloat(match[0]);
  if (value > 1 && value <= 100) value /= 100;
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : null;
}

async function askSystemOne(config: SystemOneConfig, state: string, question: string): Promise<number | null> {
  const response = await fetch(`${config.baseURL}/systemone`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      state,
      questions: { q: { type: "noul", instructions: question } },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as any;
  const value = Number(data.answers?.q?.noul);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : null;
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
            const keepProbability = await askProbability(
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
        const score = await askProbability(
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
    // ==========================================
    if (config.primaryBackend) {
      const backend = config.primaryBackend;
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

        if (backend === "anthropic") {
          body.output_config = { ...body.output_config, effort: LEVEL_REQUEST[level].effort };
        } else if (backend === "openai") {
          if (!applyOpenAiLevel(body, level, event.request.url)) return;
        } else if (backend === "zai") {
          // GLM models from 5.2 onwards, through the Z.ai API or the OpenCode Go gateway.
          if (!applyZaiLevel(body, level, event.request.url)) return;
        } else {
          body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: LEVEL_REQUEST[level].thinking };
        }

        const headers = new Headers(event.request.headers);
        headers.delete("content-length");
        event.request = new Request(event.request.url, {
          method: event.request.method,
          headers,
          body: JSON.stringify(body),
        });
      });
    }

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
            const confidence = await askProbability(
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
        const dangerScore = await askProbability(
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
            const bugScore = await askProbability(
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
