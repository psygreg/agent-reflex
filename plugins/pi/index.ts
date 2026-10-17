// agent-reflex (Pi) — main extension factory.
//
// Ports the agent-reflex OpenCode plugin (plugins/opencode/index.ts) to Pi. Unlike
// the shell ports (Claude Code, Codex, Antigravity, Qwen Code), Pi exposes BOTH
// the pieces the other agents lack:
//   - pi.setThinkingLevel() — dynamic per-turn reasoning effort (the plugin's
//     headline feature). Pi translates the unified level to each model's native
//     wire field via its own thinkingLevelMap, replacing the OpenCode plugin's
//     hand-rolled per-vendor dialects.
//   - the context event — can return a rewritten message list, so custom history
//     pruning (OpenCode's HOOK 1a) is genuinely possible here.
//
// Registered in the factory:
//   - before_agent_start: classify the prompt's complexity, set the thinking
//     level, and (medium/high) suggest a confidence check.
//   - tool_call: shell guardrail — block a dangerous command before it runs.
//   - tool_result: post-edit syntax + bug check, findings appended to the result.
//   - confidence_check tool + /confidence command: on-demand confidence scoring.

import { arAsk, classifyLevel, config, arLog } from "./classifier";
import { findSyntaxErrors, excerptAroundEdit, readFileText, CONTEXT_LINES } from "./check";

// Complexity -> Pi thinking level. simple disables thinking where the model
// allows (Pi clamps to the model's thinkingLevelMap), matching the "simple
// disables thinking" convention used for MiMo/Qwen. medium/high push effort up.
const LEVEL_THINKING: Record<string, "off" | "low" | "high"> = {
  simple: "off",
  medium: "low",
  high: "high",
};

const GUARD_THRESHOLD = Number(process.env.AGENT_REFLEX_GUARD_THRESHOLD ?? "0.75");
const SEMANTIC_THRESHOLD = Number(process.env.AGENT_REFLEX_SEMANTIC_THRESHOLD ?? "0.75");

// Shell/bash tool names across Pi's built-in and common custom tools.
const SHELL_TOOLS = new Set(["bash", "shell", "execute_bash", "run_command", "terminal"]);
const EDIT_TOOLS = new Set(["edit", "write", "write_file", "edit_file", "apply_patch", "multiedit", "str_replace_editor"]);

// Per-session state (level + failure counts), keyed by session id. Pi state is
// in-memory per extension runtime; a reload clears it, which is acceptable.
const state = {
  level: "simple" as "simple" | "medium" | "high",
  failures: new Map<string, number>(),
};

// History pruning (OpenCode's HOOK 1a) is opt-in: it makes one classifier call per
// old message before every model request, which is real latency/cost. Enable with
// AGENT_REFLEX_PRUNE=1. Rules match the OpenCode plugin: only prune when the
// history is long (>16), keep the last 4 verbatim, never drop structural messages
// (tool calls/results), and drop a message only when its relevance score is <= 0.40.
const PRUNE_ENABLED = process.env.AGENT_REFLEX_PRUNE === "1";
const PRUNE_MIN_MESSAGES = 16;
const PRUNE_KEEP_RECENT = 4;
const PRUNE_KEEP_THRESHOLD = 0.4;

// maxTokens per level (OpenCode sets event.options.maxTokens; on Pi the wire field
// is injected via before_provider_request, like the pi-params package does). Opt-in
// with AGENT_REFLEX_MAXTOKENS=1 because it overrides the provider's own cap. Caps
// match the plugin's LEVEL_REQUEST.maxTokens (simple 8192, medium 65536, high 131072).
const MAXTOKENS_ENABLED = process.env.AGENT_REFLEX_MAXTOKENS === "1";
const LEVEL_MAX_TOKENS: Record<string, number> = { simple: 8192, medium: 65536, high: 131072 };

function isStructuralMessage(msg: any): boolean {
  if (msg?.role === "tool" || msg?.role === "toolResult") return true;
  return Array.isArray(msg?.content) && msg.content.some((part: any) => part?.type && part.type !== "text");
}

function messageToText(msg: any): string {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part === "string" ? part : part?.text ?? part?.content ?? "")).join(" ");
  }
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return "";
  }
}

function extractFilePath(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["file_path", "filePath", "path", "TargetFile", "targetFile", "file"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function extractEdited(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["new_string", "newString", "content", "new_contents", "ReplacementContent", "replacement", "newContent"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export default function (pi: any) {
  // ---- before_agent_start: complexity classification + dynamic effort ----
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    if (!prompt.trim()) return undefined;

    const score = await arAsk(
      `User prompt: ${prompt.trim()}`,
      "Does this prompt require deep logic thinking, complex algorithms or mathematical/concurrence bugs?",
    );
    if (score === null) return undefined; // classifier unavailable -> leave effort alone

    const level = classifyLevel(score);
    state.level = level;
    arLog(`classify score=${score.toFixed(3)} level=${level}`);

    // Dynamic effort: the plugin's headline feature, now on Pi via the native
    // thinking-level control. Pi clamps to the model's thinkingLevelMap, so a
    // model that cannot reach "off" falls to its nearest supported level.
    try {
      const target = LEVEL_THINKING[level];
      if (typeof pi.getThinkingLevel === "function" && pi.getThinkingLevel() !== target) {
        pi.setThinkingLevel(target);
        arLog(`effort set thinkingLevel=${target} (requested ${level})`);
      }
    } catch (error: any) {
      arLog(`effort set failed: ${error?.message ?? error}`);
    }

    if (level === "simple") return undefined;

    const pct = Math.round(score * 100);
    return {
      message: {
        customType: "agent-reflex-classify",
        content: `This is a ${level} complexity task (${pct}%). Before committing to a solution, consider running the confidence check with your current plan and follow its verdict.`,
        display: false,
      },
    };
  });

  // ---- context: custom history pruning (OpenCode HOOK 1a, opt-in) ----
  // Pi is the one non-OpenCode agent where this is possible: the context event
  // receives a deep copy of the messages and can return a rewritten list.
  pi.on("context", async (event: any, _ctx: any) => {
    if (!PRUNE_ENABLED) return undefined;
    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
    if (messages.length <= PRUNE_MIN_MESSAGES) return undefined;

    const distantPast = messages.slice(0, -PRUNE_KEEP_RECENT);
    const recentPast = messages.slice(-PRUNE_KEEP_RECENT);
    const preserved: any[] = [];

    for (const msg of distantPast) {
      // Tool calls and their results must stay paired, so structural messages are never pruned.
      if (isStructuralMessage(msg)) {
        preserved.push(msg);
        continue;
      }
      const text = messageToText(msg);
      try {
        const keepProbability = await arAsk(
          `Old history message:\n[${String(msg?.role).toUpperCase()}]: ${text}`,
          "Does this message contain architectural requirements, scope definitions or crucial rules the model needs to remember to code on?",
        );
        // Classifier unavailable (null) preserves the message (fail open).
        if (keepProbability === null || keepProbability > PRUNE_KEEP_THRESHOLD) {
          preserved.push(msg);
        } else {
          arLog(`prune: discarded turn from [${msg?.role}]`);
        }
      } catch {
        preserved.push(msg);
      }
    }

    const pruned = [...preserved, ...recentPast];
    arLog(`prune: history ${messages.length} -> ${pruned.length} messages`);
    return { messages: pruned };
  });

  // ---- before_provider_request: maxTokens per level (opt-in) ----
  // Rewrites the outgoing provider payload's token cap for the current level. The
  // payload shape differs per provider, so this sets the common cap fields and
  // leaves the rest of the payload untouched.
  pi.on("before_provider_request", (event: any, _ctx: any) => {
    if (!MAXTOKENS_ENABLED) return undefined;
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    const cap = LEVEL_MAX_TOKENS[state.level];
    if (!cap) return undefined;

    try {
      const next = { ...payload };
      // OpenAI-style and Anthropic-style token caps; Google's lives under
      // generationConfig. Set whichever the payload already uses, else the common one.
      if ("max_tokens" in next || "max_completion_tokens" in next || !("generationConfig" in next)) {
        next.max_tokens = cap;
      }
      if (next.generationConfig && typeof next.generationConfig === "object") {
        next.generationConfig = { ...next.generationConfig, maxOutputTokens: cap };
      }
      arLog(`maxTokens set ${cap} for level=${state.level}`);
      return next;
    } catch (error: any) {
      arLog(`maxTokens rewrite failed: ${error?.message ?? error}`);
      return undefined;
    }
  });

  // ---- tool_call: shell guardrail (hard block) ----
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const name = String(event?.toolName ?? "").toLowerCase();
    if (!SHELL_TOOLS.has(name)) return undefined;

    const command =
      (typeof event?.input?.command === "string" && event.input.command) ||
      (typeof event?.input?.cmd === "string" && event.input.cmd) ||
      (typeof event?.input?.script === "string" && event.input.script) ||
      "";
    if (!command.trim()) return undefined;

    arLog(`guard tool=${name} command=${command.slice(0, 200)}`);
    const score = await arAsk(
      `Command to be executed in terminal: ${command}`,
      "Determine if this command may damage system files, remove directories without backup or leak environment keys.",
    );
    arLog(`guard score=${score ?? "null"}`);

    if (score === null) return undefined; // classifier unavailable -> allow

    if (score > GUARD_THRESHOLD) {
      return {
        block: true,
        reason: "[GUARDRAIL BLOCKED]: Potentially dangerous command aborted.",
      };
    }
    return undefined;
  });

  // ---- tool_result: post-edit syntax + bug check ----
  pi.on("tool_result", async (event: any, _ctx: any) => {
    const name = String(event?.toolName ?? "").toLowerCase();
    if (!EDIT_TOOLS.has(name)) return undefined;

    const filePath = extractFilePath(event?.input);
    if (!filePath || !filePath.includes(".")) return undefined;

    const edited = extractEdited(event?.input);
    const notes: string[] = [];

    const errors = findSyntaxErrors(filePath);
    if (errors && errors.length > 0) {
      notes.push(
        `[Syntax check]: ${filePath} has ${errors.length} syntax error(s). Fix them before continuing:\n` +
          errors.map((e) => `- ${e}`).join("\n"),
      );
    } else if (state.level === "medium" || state.level === "high") {
      // Clean syntax (or no parser): semantic bug check on medium/high complexity.
      const content = readFileText(filePath);
      const excerpt = excerptAroundEdit(content, edited);
      const bug = await arAsk(
        `Excerpt of edited file ${filePath}. It contains only the edited code plus ${CONTEXT_LINES} lines on each side, so code outside it is not shown:\n${excerpt}`,
        "Does this code contain a bug that would prevent it from running or produce a wrong result? Judge only the visible excerpt; do not assume bugs in code that is not shown.",
      );
      if (bug !== null) {
        const correctness = 1 - bug;
        if (correctness < SEMANTIC_THRESHOLD) {
          const pct = Math.round(correctness * 100);
          notes.push(
            `[System One check]: The edit to ${filePath} is only ${pct}% confident to be correct (threshold ${Math.round(
              SEMANTIC_THRESHOLD * 100,
            )}%). Review it before continuing.`,
          );
        }
      }
    }

    if (notes.length === 0) {
      state.failures.delete(filePath);
      return undefined;
    }

    // Retry-once / then-ask-the-user escalation (per file).
    const fails = state.failures.get(filePath) ?? 0;
    if (fails === 0) {
      state.failures.set(filePath, 1);
      notes.push("Retry once: fix the problem above, then edit the file again.");
    } else {
      state.failures.delete(filePath);
      notes.push("The check still fails after one retry. Stop and ask the user how to proceed before editing this file again.");
    }

    // Append the notes to the tool result the model sees (never blocks the edit).
    const combined = notes.join("\n\n");
    const content = Array.isArray(event?.content) ? event.content : [];
    return {
      content: [...content, { type: "text", text: `\n\n[agent-reflex] ${combined}` }],
    };
  });

  // ---- confidence_check tool ----
  pi.registerTool({
    name: "confidence_check",
    label: "Confidence check",
    description:
      "Ask System One to evaluate your current line of thought before you commit to it. Pass your reasoning so far, or your draft solution. Returns a confidence score and a verdict. If the verdict is RESTART, discard that line of thought and solve the problem again more directly.",
    parameters: {
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
    async execute(_toolCallId: string, params: any) {
      const thought = String(params?.thought ?? "").trim();
      if (!thought) {
        return { content: [{ type: "text", text: "No thought provided. Pass your current reasoning in `thought`." }], details: {} };
      }

      const threshold = state.level === "simple" ? 0.75 : 0.85;
      const confidence = await arAsk(
        `AI line of thought:\n${thought}`,
        "Does this line of thought seem direct, correct and without hesitation or redundant loops?",
      );

      if (confidence === null) {
        return {
          content: [{ type: "text", text: "System One confidence check unavailable. Continue with your current approach." }],
          details: {},
        };
      }

      const pct = confidence * 100;
      arLog(`confidence=${confidence.toFixed(3)} threshold=${threshold}`);
      if (confidence < threshold) {
        return {
          content: [
            {
              type: "text",
              text: `Confidence ${pct.toFixed(1)}% is below the ${threshold * 100}% threshold. Verdict: RESTART. Discard this line of thought and solve the problem again, focusing on the cleanest, most direct solution.`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `Confidence ${pct.toFixed(1)}%. Verdict: CONTINUE.` }],
        details: {},
      };
    },
  });

  // ---- /confidence command ----
  pi.registerCommand("confidence", {
    description: "Evaluate your current line of thought (CONTINUE/RESTART) with the System One classifier",
    handler: async (args: string, ctx: any) => {
      const thought = String(args ?? "").trim();
      if (!thought) {
        ctx.ui.notify("Usage: /confidence <your current line of thought>", "warning");
        return;
      }
      const threshold = state.level === "simple" ? 0.75 : 0.85;
      const confidence = await arAsk(
        `AI line of thought:\n${thought}`,
        "Does this line of thought seem direct, correct and without hesitation or redundant loops?",
      );
      if (confidence === null) {
        ctx.ui.notify("System One confidence check unavailable. Continue with your current approach.", "warning");
        return;
      }
      const pct = confidence * 100;
      if (confidence < threshold) {
        ctx.ui.notify(`Confidence ${pct.toFixed(1)}% (threshold ${threshold * 100}%). Verdict: RESTART.`, "error");
      } else {
        ctx.ui.notify(`Confidence ${pct.toFixed(1)}%. Verdict: CONTINUE.`, "info");
      }
    },
  });
}
