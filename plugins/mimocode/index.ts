// agent-reflex (MiMo Code) — main hook module.
//
// Ports the agent-reflex OpenCode plugin (plugins/opencode/index.ts) to MiMo Code.
// MiMo Code is OpenCode-derived and shares its plugin API (@mimo-ai/plugin ≈
// @opencode-ai/plugin), so this ports the business logic nearly 1:1. MiMo Code's
// community hook surface adds three hooks OpenCode lacks, which let this port reach
// features the shell-based ports (Claude Code, Codex, Antigravity) cannot:
//   - chat.params                 -> maxTokens per level (the plugin's level cap).
//   - experimental.chat.messages.transform -> decision-driven history compaction (HOOK 1a).
//   - experimental.session.compacting     -> compaction guidance (HOOK 1a's sibling).
//
// One honest caveat: chat.params exposes maxOutputTokens but NOT reasoning_effort
// or thinking. So on MiMo Code the "dynamic effort" feature is token-cap only; the
// thinking knob itself is not reachable from hooks. See README.
//
// MiMo Code loads file hooks from hooks/*.ts (the "plugin" array does NOT execute
// module code — a documented gotcha), compiling them with Bun.build and hot-reloading.

import { arAsk, classifyLevel, arLog, levelBySession, buildHistoryDigest } from "./classifier";
import { findSyntaxErrors, excerptAroundEdit, readFileText, CONTEXT_LINES } from "./check";

// Level -> generated-token cap. Mirrors the plugin's LEVEL_REQUEST.maxTokens.
// Simple disables thinking where the model allows; here the cap is the proxy for
// cost/latency since reasoning_effort is not reachable from hooks.
const LEVEL_MAX_TOKENS: Record<string, number> = { simple: 8192, medium: 65536, high: 131072 };

const GUARD_THRESHOLD = Number(process.env.AGENT_REFLEX_GUARD_THRESHOLD ?? "0.75");
const SEMANTIC_THRESHOLD = Number(process.env.AGENT_REFLEX_SEMANTIC_THRESHOLD ?? "0.75");

// History compaction (HOOK 1a) is opt-in: one classifier call per old message plus
// one batched digest call per model request is real latency/cost. Enable with
// AGENT_REFLEX_PRUNE=1.
const PRUNE_ENABLED = process.env.AGENT_REFLEX_PRUNE === "1";

// ---- decision-driven history compaction (ported from the plugin) ----
// Compaction keeps the most recent messages verbatim (the keep window, sized by
// complexity level so a task in flight never loses its working context), keeps a
// bounded set of high-relevance older messages verbatim, and folds the remaining
// older messages into one structured digest instead of discarding their detail.
// The digest is produced by the classifier through "choice" decisions, so nothing
// depends on a free-text generation call. Mirrors the plugin's compaction constants.
// Keep-window (most recent messages always kept verbatim) per complexity level.
// High-complexity work has the most moving parts, so it keeps the most context.
const COMPACT_KEEP_RECENT: Record<string, number> = { simple: 6, medium: 10, high: 14 };
// Trigger only when the history is meaningfully longer than the keep window.
const COMPACT_MIN_MESSAGES = 18;
// Relevance score for keeping an older message verbatim (above this it is preserved
// in full; at or below it the message is folded into the digest). Deliberately higher
// than a coin-flip so only clearly load-bearing messages survive — the rest are
// compressed, not thrown away.
const COMPACT_RELEVANCE_KEEP = 0.65;
// Bound on how many older messages are kept verbatim for relevance, so a long
// session cannot preserve its whole tail and defeat the compaction.
const COMPACT_MAX_PRESERVED = 8;


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

// Tool-call pairing helpers: a provider request must keep an assistant message
// with tool_calls together with its matching tool result(s). If compaction
// keeps one half while folding the other into the digest, the API rejects the
// request with "Cannot resolve tool name for tool_call_id=...".
function toolCallLinkIds(msg: any): string[] {
  const ids: string[] = [];
  if (msg?.tool_call_id) ids.push(String(msg.tool_call_id));
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

type ChatMsg = { role?: string; content?: unknown; tool_calls?: unknown };
function toChatMsg(msg: any): ChatMsg {
  const out: ChatMsg = {};
  if (msg?.role !== undefined) out.role = msg.role;
  if (msg?.content !== undefined) out.content = msg.content;
  if (msg?.tool_calls !== undefined) out.tool_calls = msg.tool_calls;
  return out;
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
    const wanted = LEVEL_MAX_TOKENS[level];
    if (!wanted) return;
    try {
      // Clamp to any pre-filled cap so the level cap never exceeds what the
      // model can actually emit (when MiMo Code leaves it unset, use as-is).
      const cap = output?.maxOutputTokens;
      output.maxOutputTokens =
        typeof cap === "number" && cap > 0 ? Math.min(wanted, cap) : wanted;
      arLog(`maxTokens set ${output.maxOutputTokens} for level=${level}`);
    } catch (error: any) {
      arLog(`maxTokens rewrite failed: ${error?.message ?? error}`);
    }
  },

  // ---- experimental.chat.messages.transform: decision-driven history compaction (HOOK 1a) ----
  // MiMo Code lets a hook return a rewritten message list — the capability the shell
  // ports lack. This is the plugin's SUB-ROUTINE A: keep the recent tail verbatim
  // (sized by the session's complexity level), keep a bounded set of high-relevance
  // older messages verbatim, and fold the rest into one structured digest so their
  // detail is compressed rather than discarded. Opt-in via AGENT_REFLEX_PRUNE=1
  // (one classifier call per old message + one batched digest call per request).
  "experimental.chat.messages.transform": async (input: any, output: any) => {
    if (!PRUNE_ENABLED) return;
    const messages: any[] = Array.isArray(output?.messages) ? output.messages : Array.isArray(input?.messages) ? input.messages : [];
    // Keep-window sized by the session's complexity level (defaults to simple when
    // the level is unknown), so a task in flight never loses its working context.
    const level = String(input?.sessionID ? (levelBySession.get(input.sessionID) ?? "simple") : "simple");
    const keepRecent = COMPACT_KEEP_RECENT[level] ?? COMPACT_KEEP_RECENT.simple;
    if (messages.length <= COMPACT_MIN_MESSAGES) return;

    const distantPast = messages.slice(0, -keepRecent);
    const recentPast = messages.slice(-keepRecent);

    // Score every distant message for relevance (structural tool messages included —
    // they dominate a long session). A null score (classifier unavailable) counts as
    // relevant so we fail open, but the preserve bound below still holds.
    const scored: Array<{ msg: any; score: number | null }> = [];
    for (const msg of distantPast) {
      const text = contentToText(msg?.content) || JSON.stringify(msg?.content ?? "");
      let score: number | null = null;
      try {
        score = await arAsk(
          `Old history message:\n[${String(msg?.role).toUpperCase()}]: ${text}`,
          "Is this message load-bearing context the model still needs — a requirement, rule, key decision, API shape, or prior finding that later work depends on? Answer YES only if losing it would change the answer.",
        );
      } catch {
        score = null;
      }
      scored.push({ msg, score });
    }

    // Keep the highest-relevance older messages verbatim, bounded so a long session
    // cannot preserve its whole tail.
    const ranked = scored
      .map((s, i) => ({ ...s, i, s: s.score ?? 1 }))
      .sort((a, b) => b.s - a.s);
    const preservedIdx = new Set<number>();
    for (const r of ranked) {
      if (preservedIdx.size >= COMPACT_MAX_PRESERVED) break;
      if (r.s > COMPACT_RELEVANCE_KEEP) preservedIdx.add(r.i);
    }
    // Tool-call pairs are atomic: keeping a call without its result (or the
    // reverse) makes the provider reject the whole request with
    // "Cannot resolve tool name for tool_call_id=...". Force-preserve partners.
    const allMsgs = [...distantPast, ...recentPast];
    const idToIdx = new Map<string, number>();
    for (let i = 0; i < allMsgs.length; i++) {
      for (const id of toolCallLinkIds(allMsgs[i])) idToIdx.set(id, i);
    }
    for (let j = distantPast.length; j < allMsgs.length; j++) {
      for (const id of toolCallLinkIds(allMsgs[j])) {
        const i = idToIdx.get(id);
        if (i !== undefined && i < distantPast.length) preservedIdx.add(i);
      }
    }
    let grown = true;
    while (grown) {
      grown = false;
      for (const i of [...preservedIdx]) {
        for (const id of toolCallLinkIds(allMsgs[i])) {
          const j = idToIdx.get(id);
          if (j !== undefined && !preservedIdx.has(j)) {
            preservedIdx.add(j);
            grown = true;
          }
        }
      }
    }
    // Preserve far-past messages one-to-one ONLY when their original structural
    // role is safe for the raw-history fallback: plain text, or a tool call whose
    // result is preserved with it. Anything else becomes a line in the digest.
    // This matters because a bare assistant `tool_calls` message works as a
    // hidden request to the provider, but other styles (e.g. an assistant
    // message with a `tool_use` content block and NO `tool_calls` field) do not:
    // one provider silently drops them, leaving the paired `tool_result` as a
    // dangling reference, and another rejects the whole request with
    // "unexpected `tool_use_id` found in `tool_result` blocks" / "tool result's
    // tool id not found (2013)". A message that *looks* like part of a call
    // pair but has no recognizable call id gets no partner from
    // `toolCallLinkIds`, so it must never be kept verbatim.
    const preservedMessages: ChatMsg[] = [];
    const dropped: { msg: any }[] = [];
    for (const i of [...preservedIdx]) {
      const msg = scored[i].msg;
      let linkable = !isToolCallPairMember(msg);
      if (!linkable) {
        const ids = toolCallLinkIds(msg);
        // Keep the pair only when BOTH halves are in the retained set and the
        // result half is genuinely recognized (its content is a tool result).
        linkable = ids.length > 0 && ids.every((id) => {
          const j = idToIdx.get(id);
          return j !== undefined && (preservedIdx.has(j) || j >= distantPast.length);
        }) && ids.some((id) => {
          const j = idToIdx.get(id);
          return j !== undefined && isToolResultContent(allMsgs[j]?.content);
        });
      }
      if (linkable) {
        preservedMessages.push(toChatMsg(msg));
        preservedIdx.delete(i);
      } else {
        dropped.push({ msg });
      }
    }
    for (let i = 0; i < scored.length; i++) {
      if (preservedIdx.has(i)) {
        preservedMessages.push(toChatMsg(scored[i].msg));
      } else if (!dropped.some((d) => d.msg === scored[i].msg)) {
        dropped.push(scored[i]);
      }
    }

    // Structured digest of everything that did not survive verbatim.
    const tailText = dropped
      .map((s) => `[${String(s.msg?.role).toUpperCase()}]: ${contentToText(s.msg?.content) || JSON.stringify(s.msg?.content ?? "")}`)
      .join("\n")
      .slice(0, 12_000);
    let digestLines: string[] = [];
    try {
      digestLines = await buildHistoryDigest(tailText);
    } catch {
      digestLines = [];
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

    const compactedList = [...compacted, ...preservedMessages, ...recentPast];
    arLog(`compact: history ${messages.length} -> ${compactedList.length} messages (${recentPast.length} recent + ${preservedMessages.length} preserved + ${digestLines.length} digest facts from ${dropped.length} messages)`);
    output.messages = compactedList;
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
