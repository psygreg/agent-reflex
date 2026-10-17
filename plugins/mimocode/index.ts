// agent-reflex (MiMo Code) — main hook module.
//
// Ports the agent-reflex OpenCode plugin (plugins/opencode/index.ts) to MiMo Code.
// MiMo Code is OpenCode-derived and shares its plugin API (@mimo-ai/plugin ≈
// @opencode-ai/plugin), so this ports the business logic nearly 1:1. MiMo Code's
// community hook surface adds three hooks OpenCode lacks, which let this port reach
// features the shell-based ports (Claude Code, Codex, Antigravity) cannot:
//   - chat.params                 -> maxTokens per level (the plugin's level cap).
//   - experimental.chat.messages.transform -> custom history pruning (HOOK 1a).
//   - experimental.session.compacting     -> compaction guidance (HOOK 1a's sibling).
//
// One honest caveat: chat.params exposes maxOutputTokens but NOT reasoning_effort
// or thinking. So on MiMo Code the "dynamic effort" feature is token-cap only; the
// thinking knob itself is not reachable from hooks. See README.
//
// MiMo Code loads file hooks from hooks/*.ts (the "plugin" array does NOT execute
// module code — a documented gotcha), compiling them with Bun.build and hot-reloading.

import { arAsk, classifyLevel, arLog, levelBySession } from "./classifier";
import { findSyntaxErrors, excerptAroundEdit, readFileText, CONTEXT_LINES } from "./check";

// Level -> generated-token cap. Mirrors the plugin's LEVEL_REQUEST.maxTokens.
// Simple disables thinking where the model allows; here the cap is the proxy for
// cost/latency since reasoning_effort is not reachable from hooks.
const LEVEL_MAX_TOKENS: Record<string, number> = { simple: 8192, medium: 65536, high: 131072 };

const GUARD_THRESHOLD = Number(process.env.AGENT_REFLEX_GUARD_THRESHOLD ?? "0.75");
const SEMANTIC_THRESHOLD = Number(process.env.AGENT_REFLEX_SEMANTIC_THRESHOLD ?? "0.75");

// History pruning (HOOK 1a) is opt-in: one classifier call per old message before
// every model request is real latency/cost. Enable with AGENT_REFLEX_PRUNE=1.
const PRUNE_ENABLED = process.env.AGENT_REFLEX_PRUNE === "1";
const PRUNE_MIN_MESSAGES = 16;
const PRUNE_KEEP_RECENT = 4;
const PRUNE_KEEP_THRESHOLD = 0.4;


function isStructuralMessage(msg: any): boolean {
  if (msg?.role === "tool" || msg?.role === "toolResult") return true;
  return Array.isArray(msg?.content) && msg.content.some((part: any) => part?.type && part.type !== "text");
}

function contentToText(content: any): string {
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
  for (const key of ["new_string", "newString", "content", "new_contents", "patchText", "ReplacementContent"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

// Hooks object: MiMo Code's file-hooks default export shape.
export default {
  // ---- chat.params: maxTokens per level (the level cap) ----
  // Rewrites the outgoing request's generated-token cap for the current level.
  // This is the one request param MiMo Code hooks can reach (reasoning_effort is
  // not exposed here), so "dynamic effort" on MiMo Code is token-cap only.
  "chat.params": async (input: any, output: any) => {
    const level = levelBySession.get(input?.sessionID ?? "") ?? "simple";
    const cap = LEVEL_MAX_TOKENS[level];
    if (!cap) return;
    try {
      output.maxOutputTokens = cap;
      arLog(`maxTokens set ${cap} for level=${level}`);
    } catch (error: any) {
      arLog(`maxTokens rewrite failed: ${error?.message ?? error}`);
    }
  },

  // ---- experimental.chat.messages.transform: custom history pruning (HOOK 1a) ----
  // MiMo Code lets a hook return a rewritten message list — the capability the shell
  // ports lack. Opt-in via AGENT_REFLEX_PRUNE=1 (one classifier call per old message).
  "experimental.chat.messages.transform": async (input: any, output: any) => {
    if (!PRUNE_ENABLED) return;
    const messages: any[] = Array.isArray(output?.messages) ? output.messages : Array.isArray(input?.messages) ? input.messages : [];
    if (messages.length <= PRUNE_MIN_MESSAGES) return;

    const distantPast = messages.slice(0, -PRUNE_KEEP_RECENT);
    const recentPast = messages.slice(-PRUNE_KEEP_RECENT);
    const preserved: any[] = [];

    for (const msg of distantPast) {
      if (isStructuralMessage(msg)) {
        preserved.push(msg);
        continue;
      }
      const text = contentToText(msg?.content) || JSON.stringify(msg?.content ?? "");
      try {
        const keepProbability = await arAsk(
          `Old history message:\n[${String(msg?.role).toUpperCase()}]: ${text}`,
          "Does this message contain architectural requirements, scope definitions or crucial rules the model needs to remember to code on?",
        );
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
    output.messages = pruned;
  },

  // ---- experimental.chat.system.transform: complexity classification + suggestion ----
  // Classifies the prompt, stores the level (drives chat.params + the post-edit check),
  // and for medium/high adds a confidence-check suggestion to the system prompt.
  "experimental.chat.system.transform": async (input: any, output: any) => {
    const prompt = typeof input?.prompt === "string" ? input.prompt : typeof input?.message === "string" ? input.message : "";
    const sessionID = input?.sessionID ?? "";
    if (!prompt.trim()) return;

    const score = await arAsk(
      `User prompt: ${prompt.trim()}`,
      "Does this prompt require deep logic thinking, complex algorithms or mathematical/concurrence bugs?",
    );
    if (score === null) return; // classifier unavailable -> leave effort alone

    const level = classifyLevel(score);
    if (sessionID) levelBySession.set(sessionID, level);
    arLog(`classify score=${score.toFixed(3)} level=${level}`);

    if (level === "simple") return;

    const pct = Math.round(score * 100);
    const note = `This is a ${level} complexity task (${pct}%). Before committing to a solution, consider calling the systemone_check_confidence tool with your current plan and follow its verdict.`;
    if (Array.isArray(output?.system)) {
      output.system.push(note);
    }
  },

  // ---- tool.execute.before: shell guardrail (hard block) ----
  "tool.execute.before": async (input: any, output: any) => {
    const tool = String(input?.tool ?? "").toLowerCase();
    if (tool !== "bash" && tool !== "shell") return;

    const command = output?.args?.command ?? output?.args?.cmd ?? "";
    if (!String(command).trim()) return;

    arLog(`guard tool=${tool} command=${String(command).slice(0, 200)}`);
    const score = await arAsk(
      `Command to be executed in terminal: ${command}`,
      "Determine if this command may damage system files, remove directories without backup or leak environment keys.",
    );
    arLog(`guard score=${score ?? "null"}`);

    if (score === null) return; // classifier unavailable -> allow

    if (score > GUARD_THRESHOLD) {
      output.cancel = true;
      output.cancelReason = "[GUARDRAIL BLOCKED]: Potentially dangerous command aborted.";
    }
  },

  // ---- tool.execute.after: post-edit syntax + bug check ----
  // Appends findings to the tool result the model sees (output.output), so it feeds
  // back inline with the edit — unlike Antigravity's one-turn delay.
  "tool.execute.after": async (input: any, output: any) => {
    const tool = String(input?.tool ?? "").toLowerCase();
    const isEdit = tool === "edit" || tool === "write" || tool === "apply_patch" || tool === "multiedit" || tool === "str_replace_editor";
    if (!isEdit) return;

    const filePath = extractFilePath(input?.args ?? output?.args);
    if (!filePath || !filePath.includes(".")) return;

    const edited = extractEdited(input?.args ?? output?.args);
    const notes: string[] = [];

    const errors = findSyntaxErrors(filePath);
    if (errors && errors.length > 0) {
      notes.push(
        `[Syntax check]: ${filePath} has ${errors.length} syntax error(s). Fix them before continuing:\n` +
          errors.map((e) => `- ${e}`).join("\n"),
      );
    } else {
      const level = levelBySession.get(input?.sessionID ?? "");
      if (level === "medium" || level === "high") {
        const content = readFileText(filePath);
        const excerpt = excerptAroundEdit(content, edited);
        const bugScore = await arAsk(
          `Excerpt of edited file ${filePath}. It contains only the edited code plus ${CONTEXT_LINES} lines on each side, so code outside it is not shown:\n${excerpt}`,
          "Does this code contain a bug that would prevent it from running or produce a wrong result? Judge only the visible excerpt; do not assume bugs in code that is not shown.",
        );
        const correctness = bugScore === null ? null : 1 - bugScore;
        if (correctness !== null && correctness < SEMANTIC_THRESHOLD) {
          notes.push(
            `[System One check]: The edit to ${filePath} is only ${Math.round(correctness * 100)}% confident to be correct (threshold ${Math.round(
              SEMANTIC_THRESHOLD * 100,
            )}%). Review it before continuing.`,
          );
        }
      }
    }

    if (notes.length === 0) return;

    // Append to the tool result string (MiMo Code: output.output, NOT output.result).
    const combined = `\n\n[agent-reflex] ${notes.join("\n\n")}`;
    if (typeof output?.output === "string") {
      output.output = output.output + combined;
    } else if (output && typeof output === "object") {
      output.output = combined.trim();
    }
  },

  // ---- experimental.session.compacting: compaction guidance ----
  // Steer the compaction summary to keep architectural requirements, scope, and rules.
  "experimental.session.compacting": async (_input: any, output: any) => {
    try {
      if (Array.isArray(output?.context)) {
        output.context.push(
          "Preserve architectural requirements, scope definitions, and crucial rules the model needs to remember to code. Keep tool call/result pairings intact. Drop redundant conversational turns.",
        );
      }
    } catch (error: any) {
      arLog(`compaction guidance failed: ${error?.message ?? error}`);
    }
  },
};
