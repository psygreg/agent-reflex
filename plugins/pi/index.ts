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

import { arAsk, arAskMany, arAskChoice, arAskChoiceMany, classifyLevel, config, arLog } from "./classifier";
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
  usedTools: new Set<string>(),
};

// History compaction (OpenCode's HOOK 1a) is decision-driven: it keeps the most
// recent messages verbatim (the keep window, sized by complexity level so a task
// in flight never loses its working context), keeps a bounded set of high-relevance
// older messages verbatim, and folds the remaining older messages into one
// structured digest instead of discarding their detail. The digest is produced by
// the classifier through "choice" decisions, so nothing depends on free-text
// generation.
//
// Opt-in because compaction makes one classifier call per old message plus a
// batched digest call before every model request — real latency/cost. Enable with
// AGENT_REFLEX_PRUNE=1.
const COMPACT_ENABLED = process.env.AGENT_REFLEX_PRUNE === "1";

// Keep-window (most recent messages always kept verbatim) per complexity level.
// High-complexity work has the most moving parts, so it keeps the most context.
const COMPACT_KEEP_RECENT: Record<string, number> = { simple: 6, medium: 10, high: 14 };

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

// maxTokens per level (OpenCode sets event.options.maxTokens; on Pi the wire field
// is injected via before_provider_request, like the pi-params package does). Opt-in
// with AGENT_REFLEX_MAXTOKENS=1 because it overrides the provider's own cap. Caps
// match the plugin's LEVEL_REQUEST.maxTokens (simple 8192, medium 65536, high 131072).
const MAXTOKENS_ENABLED = process.env.AGENT_REFLEX_MAXTOKENS === "1";
const LEVEL_MAX_TOKENS: Record<string, number> = { simple: 8192, medium: 65536, high: 131072 };

// Tool exposure (OpenCode HOOK 1c): give the model only the tools this task needs,
// so the request carries fewer tool schemas. Pi exposes the clean primitive for
// this — pi.getAllTools() / pi.getActiveTools() / pi.setActiveTools(names) — so
// unlike the shell ports (Claude Code, Codex, Qwen, Antigravity) real token
// savings are possible here. ON by default; disable with AGENT_REFLEX_TOOLS=0 (or
// "all"). The decision is driven by System One and always fails open (keeps every
// tool) on any classifier error, and never drops an always-keep core tool or one
// the model has already used this session.
//
// Filtering stays conservative: the always-keep core is the common direct tools
// (read/search/edit/shell/task), so the model keeps the tools it reaches for
// constantly and only the long tail (web, exec, subagents, …) is trimmed to what
// the task clearly needs or the model already used this session. reflex_run (the
// decision-model dispatch tool) is an optional fallback and is likewise kept, so
// the model can reach for it when it cannot decide which tool to call — it is not
// relied on as the default path.
const TOOL_EXPOSURE_ENABLED = (process.env.AGENT_REFLEX_TOOLS ?? "auto") === "auto";
const TOOL_GROUP_THRESHOLD = 0.35;

// Always-keep core: the common direct tools (find/read/search/edit/shell/task) are
// never removed, so the model always has the tools it reaches for most. reflex_run
// is kept as the optional fallback dispatch path and is never removed either.
const TOOL_CORE = new Set(["read", "grep", "glob", "edit", "write", "bash", "shell", "task", "reflex_run"]);

// Tool exposure judges PURPOSE GROUPS, not individual tools (mirrors the OpenCode
// plugin): one decision question per group ("is this kind of tool needed at
// all?") and the verdict applies to every tool in it. That is both a better
// question for the classifier and the compensation for it underscoring individual
// tools — a group that stays keeps its whole family.
interface ToolGroup {
  id: string;
  purpose: string;
  match: (name: string) => boolean;
}

// First match wins, so the specific families come before the generic ones (a
// webfetch must land in "web", never in "read"). The last group is the catch-all:
// unclassified tools are judged as "other", never silently kept or dropped.
const TOOL_GROUPS: ToolGroup[] = [
  // WEB: reaching the network.
  { id: "web", purpose: "reaching the web: fetching URLs, web search", match: (n) => /^(web|fetch|browse|http|url)/.test(n) || /_(web|fetch|browse|url|http)$/.test(n) },
  // SHELL: running commands or external processes.
  { id: "shell", purpose: "running shell commands or external processes", match: (n) => /^(bash|shell|exec|terminal|run|command|powershell|cmd)/.test(n) || /_(exec|run|command|shell|terminal)$/.test(n) },
  // EDIT: creating or modifying files.
  { id: "edit", purpose: "creating or modifying files", match: (n) => /^(edit|write|patch|multiedit|create|replace)/.test(n) || /_(edit|write|patch|create|replace)$/.test(n) },
  // READ: inspecting files and the repo.
  { id: "read", purpose: "reading, listing and searching files", match: (n) => /^(read|grep|glob|ls|list|find|cat|search|lookup|query)/.test(n) || /_(read|search|find|list|grep|glob|lookup|query|cat)$/.test(n) },
  // AGENTS: delegation and prompting.
  { id: "agents", purpose: "delegating work to subagents, skills or prompts", match: (n) => /^(task|subagent|delegate|skill|question|agent|workflow)/.test(n) || /_(task|agent|delegate|skill|question)$/.test(n) },
  // OTHER: the long tail of specialized helpers.
  { id: "other", purpose: "other specialized helper tools", match: () => true },
];

function toolGroupOf(name: string): ToolGroup {
  return TOOL_GROUPS.find((group) => group.match(name)) ?? TOOL_GROUPS[TOOL_GROUPS.length - 1];
}

// Groups candidate tools by purpose, preserving name order within each group.
function groupCandidates(candidates: string[]): Map<ToolGroup, string[]> {
  const byGroup = new Map<ToolGroup, string[]>();
  for (const name of candidates) {
    const group = toolGroupOf(name);
    const names = byGroup.get(group) ?? [];
    names.push(name);
    byGroup.set(group, names);
  }
  return byGroup;
}

// Fallback tiers when the batched group questions are unsupported (backend
// answers one question). Cumulative group-id sets, ordered narrow -> wide:
// simple -> READ, medium -> EDIT, high -> FULL (every group), using the same
// complexity cut-offs as the thinking level.
const TOOL_TIERS: Record<string, Set<string> | null> = {
  simple: new Set(["read"]),
  medium: new Set(["read", "edit"]),
  high: null,
};

function tierForScore(score: number): Set<string> | null {
  return TOOL_TIERS[classifyLevel(score)];
}

// Applies System One tool exposure: narrows the active tool set to what this task
// needs. Two decision paths (mirrors the OpenCode plugin):
//  1. Group batch — one arAskMany call scores every candidate GROUP by purpose;
//     tools whose group scored below TOOL_GROUP_THRESHOLD are dropped. A group the
//     backend did not answer is kept (fail-open per group), and a kept group keeps
//     its whole family of tools.
//  2. Tier fallback — if the batch returned no answers (single-question backend),
//     one scalar arAsk call picks a tier (READ/EDIT/FULL) and everything outside it
//     is dropped.
// Keeps the always-keep core and anything already used this session. Fails open
// (keeps every active tool) on any error or null score.
async function applyToolExposure(pi: any, prompt: string): Promise<void> {
  if (!TOOL_EXPOSURE_ENABLED) return;

  let all: string[];
  try {
    all = (pi.getAllTools?.() ?? []).map((t: any) => (typeof t === "string" ? t : t?.name ?? t?.toolName ?? "")).filter(Boolean);
  } catch {
    return;
  }
  if (all.length === 0) return;

  const active: string[] = (pi.getActiveTools?.() ?? all).map((t: any) => (typeof t === "string" ? t : t?.name ?? t?.toolName ?? "")).filter(Boolean);
  const pool = active.length > 0 ? active : all;

  const candidates = pool.filter((name) => !TOOL_CORE.has(name) && !state.usedTools.has(name));
  if (candidates.length === 0) return;

  const stateText = `User request: ${prompt.trim()}`;
  const keep = new Set<string>();

  try {
    const questionsById: Record<string, string> = {};
    for (const [group, names] of groupCandidates(candidates)) {
      questionsById[group.id] = `Would any "${group.id}" tool be needed to fully answer this user request? They cover ${group.purpose}. Candidates: ${names.slice(0, 8).join(", ")}. Answer YES only if this tool group is likely required.`;
    }
    const scores = await arAskMany(stateText, questionsById);

    const answered = candidates.filter((name) => typeof scores[toolGroupOf(name).id] === "number");
    if (answered.length > 0) {
      for (const name of pool) {
        const score = scores[toolGroupOf(name).id];
        // Keep core/used tools, tools whose GROUP has no answer, and tools whose
        // group scored at/above threshold (a kept group keeps its whole family).
        if (TOOL_CORE.has(name) || state.usedTools.has(name) || typeof score !== "number" || score >= TOOL_GROUP_THRESHOLD) {
          keep.add(name);
        }
      }
    } else {
      // Batch unsupported -> one scalar picks a tier.
      const needScore = await arAsk(
        stateText,
        "Does solving this request require running shell commands, editing or writing files, or anything beyond reading and searching? YES means it needs more than read-only tools.",
      );
      if (needScore === null) return; // fail-open: keep all active tools
      const tier = tierForScore(needScore);
      for (const name of pool) {
        if (TOOL_CORE.has(name) || state.usedTools.has(name) || (tier && tier.has(toolGroupOf(name).id))) keep.add(name);
      }
    }

    if (keep.size === 0 || keep.size >= pool.length) return; // nothing to trim
    pi.setActiveTools([...keep]);
    arLog(`tools: exposed ${keep.size}/${pool.length} (${[...keep].sort().join(",")})`);
  } catch (error: any) {
    arLog(`tools: exposure failed (${error?.message ?? error}); keeping all`);
  }
}

// Tool ids a message links to (the call it makes or the call it answers).
// Local copy of toolCallLinkIds from plugins/opencode/index.ts: message-level
// ids (tool_call_id), tool_calls ids, and typed tool_use/tool-call/
// tool_result/tool-result content-part ids.
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

// Index of the message holding the other half of this tool-call pair (the
// result for a call, or the call for a result), or undefined when there is
// none. Pairing scans the whole list: compaction can separate a call from its
// result by unrelated messages, so adjacency is not enough.
function findPairMemberIndex(msg: any, msgs: any[], self: number): number | undefined {
  const ids = new Set(toolCallLinkIds(msg));
  if (ids.size === 0) return undefined;
  for (let j = 0; j < msgs.length; j++) {
    if (j === self) continue;
    if (toolCallLinkIds(msgs[j]).some((id) => ids.has(id))) return j;
  }
  return undefined;
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

// Builds the structured digest from the compacted tail. For each bucket, the
// tail's own sentences that match the bucket's theme become candidate values, and
// one batched "choice" call asks the classifier to pick the single most
// representative one — so the digest preserves the SPECIFIC fact ("auth uses
// event-sourcing") rather than merely noting that the topic came up. Buckets with
// no matching sentences are skipped. Returns the digest lines, or an empty array
// when the classifier gives nothing usable (the caller then keeps the tail's most
// relevant messages and nothing is lost outright).
async function buildHistoryDigest(tailText: string): Promise<string[]> {
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
  if (Object.keys(questionsById).length === 0) return [];

  const answers = await arAskChoiceMany(tailText, questionsById);

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

// Returns true when a shell command looks dangerous per the System One guardrail.
// Shared by the tool_call hook and reflex_run dispatch so the guard is enforced
// no matter how a command reaches execution. Fails open (returns false = allowed)
// when the classifier is unavailable, matching the plugin's never-block-when-down
// convention.
async function isDangerousCommand(command: string): Promise<boolean> {
  const score = await arAsk(
    `Command to be executed in terminal: ${command}`,
    "Determine if this command may damage system files, remove directories without backup or leak environment keys.",
  );
  return score !== null && score > GUARD_THRESHOLD;
}

// Truncates a long tool output for the model-facing result and points at the rest.
function truncateOutput(text: string, limit = 24_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[agent-reflex] output truncated (${text.length} chars total). Re-run with a narrower scope to see more.`;
}

interface ToolCandidate {
  name: string;
  description: string;
  input: any;
}

// Deterministic tool selection by SCHEMA FIT: only tools whose required args the
// model's task/target can satisfy are returned. A tool whose required args cannot be
// filled is never dispatched (that is what 400s).
function fitTools(
  candidates: ToolCandidate[],
  task: string,
  target: string,
): Array<{ name: string; description: string; input: any; args: Record<string, any>; missing: string[]; fallback: boolean }> {
  const fitting: Array<{ name: string; description: string; input: any; args: Record<string, any>; missing: string[]; fallback: boolean }> = [];
  for (const c of candidates) {
    const built = buildArgsFromSchema(c.input, task, target);
    const fits = built.fallback ? true : built.missing.length === 0;
    if (fits) fitting.push({ name: c.name, description: c.description, input: c.input, args: built.args, missing: built.missing, fallback: built.fallback });
  }
  return fitting;
}

// Renders a tool's real input schema as compact readable text for the decision model.
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

// Derives pseudo input-property hints from a tool's free-text description for
// codec-style schemas that are not introspectable.
function inferPropsFromDescription(description: string): Record<string, any> {
  const d = String(description ?? "").toLowerCase();
  const props: Record<string, any> = {};
  if (/(?:command|shell|exec|run\b|terminal)/.test(d)) props.command = { type: "string", description: "shell command to execute" };
  if (/(?:read|file|path|open|load|cat\b)/.test(d)) props.path = { type: "string", description: "file path to read" };
  if (/(?:write|create|save|content|overwrite)/.test(d)) { props.path = props.path ?? { type: "string", description: "file path" }; props.content = { type: "string", description: "text content to write" }; }
  if (/(?:edit|replace|update|patch|new string)/.test(d)) { props.path = props.path ?? { type: "string", description: "file path to edit" }; props.new_string = { type: "string", description: "replacement text" }; }
  if (/(?:search|grep|find|pattern|query|match|glob)/.test(d)) props.pattern = { type: "string", description: "search pattern or query" };
  if (/(?:fetch|web|url|http|download|page)/.test(d)) props.url = { type: "string", description: "url to fetch" };
  return props;
}

// Builds args MECHANICALLY from the real input JSON schema (types + required + field
// name/description tokens only; no tool-intent guessing). Required-but-unsourced
// fields are reported missing. `fallback` signals a non-introspectable schema.
function buildArgsFromSchema(schema: any, task: string, target: string): { args: Record<string, any>; missing: string[]; fallback: boolean } {
  const args: Record<string, any> = {};
  const missing: string[] = [];
  const props: Record<string, any> = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required: string[] = Array.isArray(schema?.required) ? schema.required : Object.keys(props);
  if (Object.keys(props).length === 0 && required.length === 0) return { args: {}, missing: [], fallback: true };

  // Value source purely from the property's own name + description tokens. `payload`
  // flags fields consuming task TEXT so multi-payload schemas are detected as
  // ambiguous and none is filled (no guessing which the task text belongs to).
  const classify = (name: string, def: any): "task" | "target" | "payload" | undefined => {
    const hay = `${name} ${typeof def?.description === "string" ? def.description : ""}`.toLowerCase();
    if (/(?:command|cmd|script|exec|shell|\brun\b)/.test(hay)) return "target";
    if (/(?:path|file|filename|dir|directory|location)/.test(hay)) return "target";
    if (/(?:pattern|query|search|regex|glob|match|filter)/.test(hay)) return "target";
    if (/(?:url|href|uri|link|address)/.test(hay)) return "target";
    if (/(?:\bcontent\b|new_?string|replacement|\bbody\b|\bpayload\b|\binstructions\b)/.test(hay)) return "task";
    if (/(?:old_?string|_?string\b|\btext\b|\bsnippet\b|\bcode\b|\bvalue\b)/.test(hay)) return "payload";
    return undefined;
  };

  const taskSourced: string[] = [];
  for (const [name, def] of Object.entries(props)) {
    const declaredType = (def as any)?.type;
    const cls = classify(name, def);
    if (cls === "target") {
      if (target !== "") {
        args[name] = declaredType === "number" || declaredType === "integer" ? Number(target) || 0 : declaredType === "boolean" ? Boolean(target) : String(target);
        continue;
      }
      if (required.includes(name)) missing.push(name);
      continue;
    }
    if (cls === "task" || cls === "payload") {
      taskSourced.push(name);
      continue;
    }
    if (required.includes(name)) missing.push(name);
  }
  if (taskSourced.length === 1 && task !== "") {
    const name = taskSourced[0];
    const declaredType = (props[name] as any)?.type;
    args[name] = declaredType === "number" || declaredType === "integer" ? Number(task) || 0 : declaredType === "boolean" ? Boolean(task) : String(task);
  } else {
    for (const name of taskSourced) {
      if (required.includes(name)) missing.push(name);
    }
  }
  for (const name of required) {
    if (!(name in args) && !missing.includes(name)) missing.push(name);
  }
  return { args, missing, fallback: false };
}

// Renders a nested tool result into plain text the model can read. Pi tool results
// carry a content array of parts (text/etc.); this flattens it and falls back to
// JSON for unexpected shapes. This is what feeds the sub-tool's real output back
// through reflex_run to the model.
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

export default function (pi: any) {
  // ---- before_agent_start: tool exposure + complexity classification + effort ----
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    if (!prompt.trim()) return undefined;

    // Tool exposure runs first and independently of the complexity score, so the
    // model still gets a trimmed tool set when the classifier is unavailable or the
    // complexity question returns null. It fails open internally.
    await applyToolExposure(pi, prompt);

    const score = await arAsk(
      `User prompt: ${prompt.trim()}`,
      "Does this prompt require deep logic thinking, complex algorithms or mathematical/concurrence bugs, multi-step refactoring, or work with many moving parts and long context the model must retain?",
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

  // ---- context: custom history compaction (OpenCode HOOK 1a, opt-in) ----
  // Pi is the one non-OpenCode agent where this is possible: the context event
  // receives a deep copy of the messages and can return a rewritten list. Keeps the
  // most recent messages verbatim (keep window sized by the current level), keeps a
  // bounded set of high-relevance older messages verbatim, and folds the remaining
  // older messages into one structured digest so their detail is compressed rather
  // than discarded.
  //
  // Local copy of the shared pair-closing helper (see plugins/opencode/
  // index.ts, and plugins/mimocode/index.ts, which cannot import helpers):
  // tool-call pairs are atomic, so pruning must never leave an unpaired
  // tool_use / tool_result. findPairMemberIndex links a call and its result by
  // their shared tool id (msg.tool_call_id / tool_calls / typed content parts).
  function closeToolCallPairs(preservedIdx: Set<number>, distant: any[], recent: any[]): void {
    const pairMembers = [...distant, ...recent];
    for (let round = 0; round < 32; round++) {
      const before = preservedIdx.size;
      for (const i of [...preservedIdx]) {
        const j = findPairMemberIndex(pairMembers[i], pairMembers, i);
        if (j !== undefined && j < distant.length) preservedIdx.add(j);
      }
      for (const i of distant.keys()) {
        if (!preservedIdx.has(i)) continue;
        const j = findPairMemberIndex(pairMembers[i], pairMembers, i);
        if (j !== undefined && j >= distant.length) preservedIdx.add(i);
      }
      if (preservedIdx.size === before) break;
    }
  }
  pi.on("context", async (event: any, _ctx: any) => {
    if (!COMPACT_ENABLED) return undefined;
    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
    if (messages.length <= COMPACT_MIN_MESSAGES) return undefined;

    const keepRecent = COMPACT_KEEP_RECENT[state.level] ?? COMPACT_KEEP_RECENT.medium;
    const distantPast = messages.slice(0, -keepRecent);
    const recentPast = messages.slice(-keepRecent);

    // Structural messages (tool calls/results) are scored too — they dominate a
    // long session and are the main reason it "doesn't compact enough". Only a
    // structural message that is clearly load-bearing survives verbatim; the rest
    // fold into the digest. The keep window still protects in-flight work.
    const scored: Array<{ msg: any; score: number | null }> = [];
    for (const msg of distantPast) {
      const text = messageToText(msg) || JSON.stringify(msg.content);
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
    // reverse) leaves an unpaired tool_use / tool_result that the API rejects.
    // Each preserved pair member drags its partner in, and pairs cut by the
    // keep-window boundary keep the distant half too (the recent half is
    // always sent). `pairMembers` must cover distant past + recent window.
    closeToolCallPairs(preservedIdx, distantPast, recentPast);
    const preservedMessages = scored.filter((_, i) => preservedIdx.has(i)).map((s) => s.msg);
    const dropped = scored.filter((_, i) => !preservedIdx.has(i));

    // Structured digest of everything that did not survive verbatim.
    const tailText = dropped
      .map((s) => `[${String(s.msg?.role).toUpperCase()}]: ${messageToText(s.msg) || JSON.stringify(s.msg?.content)}`)
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
        content: `Earlier context in this session, compacted (the messages below were folded into these facts):\n${digestLines.join("\n")}`,
      });
    }

    const compactedMessages = [...compacted, ...preservedMessages, ...recentPast];
    arLog(
      `compact: history ${messages.length} -> ${compactedMessages.length} messages ` +
        `(${recentPast.length} recent + ${preservedMessages.length} preserved + ${digestLines.length} digest facts from ${dropped.length} dropped)`,
    );
    return { messages: compactedMessages };
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
    // Remember every tool the model reaches for so tool exposure keeps it on later
    // turns of the same task (a multi-step task never loses a tool mid-flight).
    if (name) state.usedTools.add(name);
    if (!SHELL_TOOLS.has(name)) return undefined;

    const command =
      (typeof event?.input?.command === "string" && event.input.command) ||
      (typeof event?.input?.cmd === "string" && event.input.cmd) ||
      (typeof event?.input?.script === "string" && event.input.script) ||
      "";
    if (!command.trim()) return undefined;

    arLog(`guard tool=${name} command=${command.slice(0, 200)}`);
    if (await isDangerousCommand(command)) {
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

  // ---- reflex_run: decision-model tool dispatch (OPTIONAL FALLBACK) ----
  // A fallback the model reaches for ONLY when it cannot decide which underlying
  // tool to call for a task. It is not the default path — the model calls the real
  // tools directly whenever it knows which one fits. When it is unsure, its
  // execute() asks the System One decision model ("choice") which sub-tool handles
  // the task, dispatches that tool via ctx.executeTool, and FEEDS THE SUB-TOOL'S
  // REAL OUTPUT BACK into this tool's result so the model sees what actually
  // happened. The decision model picks the tool; arguments come from the model's
  // own reflex_run call. The shell guardrail runs before dispatch, so it is
  // enforced however reflex_run is invoked. Nested calls do not add transcript
  // entries (Pi reports them to the calling tool only), which is why the output is
  // surfaced here.
  pi.registerTool({
    name: "reflex_run",
    label: "Reflex run",
    description:
      "Fallback dispatcher for when you cannot decide which underlying tool to call for a task. Pass the intent and any target (a file path, a shell command, a search query); Reflex picks the right tool, runs it, and returns its real output. Prefer calling tools directly when you already know which one to use — reach for this only when the correct tool is unclear.",
    parameters: {
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
    async execute(_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) {
      const task = String(params?.task ?? "").trim();
      const target = String(params?.target ?? "").trim();
      if (!task && !target) {
        return { content: [{ type: "text", text: "No task provided. Pass what to do in `task`, and a file path/command/query in `target`." }], details: {} };
      }

      // Pool-driven: read the REAL callable tool pool and dispatch from it — no
      // hardcoded tool catalog or guessed arg shapes. Meta-tools (reflex_run itself
      // and the Code Mode infrastructure) are not dispatch targets.
      const META = new Set(["reflex_run", "execute", "search", "skill", "question", "subagent", "codemode", "tool_search"]);
      const pool: Array<{ name: string; description: string; input: any }> = [];
      try {
        for (const t of pi.getAllTools?.() ?? []) {
          const name = String(typeof t === "string" ? t : (t?.name ?? t?.toolName ?? ""));
          if (!name || META.has(name)) continue;
          const schema = (t as any)?.parameters ?? (t as any)?.input ?? (t as any)?.inputSchema;
          pool.push({ name, description: String((t as any)?.description ?? name), input: schema });
        }
      } catch {
        // getAllTools unavailable -> fall back to ctx.tools names below
      }
      // Restrict to tools the current context can execute when that list is present.
      let callables: string[] | null = null;
      try {
        const c = (ctx?.tools ?? []).map((t: any) => (typeof t === "string" ? t : t?.name ?? t?.toolName ?? "")).filter(Boolean);
        if (c.length > 0) callables = c;
      } catch {
        callables = null;
      }
      let candidates = pool;
      if (callables) candidates = pool.filter((t) => callables!.includes(t.name));
      if (candidates.length === 0) {
        return { content: [{ type: "text", text: "[reflex_run] No dispatchable tools are registered in this session." }], details: {} };
      }

      // Deterministic selection by schema fit: only tools whose required args the
      // model's task/target can satisfy are dispatched. Single fit -> no classifier.
      // Several fit -> decision model tie-breaks among THEM with full schema context.
      const fitting = fitTools(candidates, task, target);
      if (fitting.length === 0) {
        return { content: [{ type: "text", text: "[reflex_run] No registered tool's required arguments can be satisfied by the given task/target. Call a tool directly with explicit arguments." }], details: {} };
      }

      let chosen: ToolCandidate & { args: Record<string, any>; missing: string[]; fallback: boolean };
      if (fitting.length === 1) {
        chosen = fitting[0];
      } else {
        const criteria: Record<string, string> = {};
        for (const t of fitting) {
          const schemaText = describeToolSchema(t.input);
          criteria[t.name] = schemaText ? `${t.description} | ${schemaText}` : t.description;
        }
        const state = `User task: ${task}${target ? `\nTarget: ${target}` : ""}`;
        const picked = await arAskChoice(
          state,
          "These tools can all take the given arguments. Which one best matches the task? Consider each tool's description and input schema.",
          criteria,
        );
        chosen = fitting.find((t) => t.name === picked?.choice) ?? fitting[0];
      }

      const chosenName = chosen.name;
      const chosenTool = candidates.find((t) => t.name === chosenName)!;
      let args = chosen.args;
      let missing = chosen.missing;
      const conf = fitting.length === 1 ? "schema-fit" : "tie-broken";
      arLog(`reflex_run task="${task.slice(0, 120)}" -> ${chosenName} (${conf})`);

      if (chosen.fallback) {
        const inferred = buildArgsFromSchema({ properties: inferPropsFromDescription(chosenTool.description), required: [] }, task, target);
        args = inferred.args;
        if (Object.keys(args).length === 0) {
          const desc = String(chosenTool.description ?? "").toLowerCase();
          if (/(?:command|shell|exec|run\b)/.test(desc)) args = { command: target || task };
          else if (/(?:read|file|path|open)/.test(desc)) args = { path: target, filePath: target };
          else if (/(?:search|grep|find|pattern|query)/.test(desc)) args = { pattern: target || task, query: target || task };
          else if (/(?:fetch|web|url|http)/.test(desc)) args = { url: target };
          else if (/(?:write|content|create)/.test(desc)) args = { path: target, content: task };
          else return { content: [{ type: "text", text: `[reflex_run] Cannot infer the arguments for \`${chosenName}\` from its schema/description. Call it directly with explicit arguments.` }], details: {} };
        }
        missing = [];
      }
      if (missing.length > 0) {
        return {
          content: [{ type: "text", text: `[reflex_run] \`${chosenName}\` needs argument(s) the task/target did not supply: ${missing.join(", ")}. Re-invoke reflex_run with more detail, or call \`${chosenName}\` directly with explicit arguments.` }],
          details: { missingArgs: missing },
        };
      }

      // Guardrail before dispatching a shell-like tool (its schema takes a command).
      const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
      const isShell = Boolean(command) || /command|cmd|script|exec/i.test(Object.keys(args).join(" "));
      if (isShell && command && (await isDangerousCommand(command))) {
        return {
          content: [{ type: "text", text: "[GUARDRAIL BLOCKED]: Potentially dangerous command aborted. Not running it." }],
          details: { guarded: true, command },
        };
      }

      // Dispatch and feed the sub-tool's REAL output back to the model.
      try {
        const result = await ctx.executeTool(chosenName, args, {
          signal: _signal,
          onUpdate: typeof onUpdate === "function" ? onUpdate : undefined,
        });
        const output = truncateOutput(renderToolOutput(result));
        return {
          content: [
            { type: "text", text: `[reflex_run] Delegated to \`${chosenName}\` (${conf} confident).\n\n${output}` },
          ],
          details: { delegatedTo: chosenName, selection: conf, args },
          usage: result?.usage,
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `[reflex_run] Failed to run \`${chosenName}\`: ${error?.message ?? error}` }],
          details: { delegatedTo: chosenName, error: String(error?.message ?? error) },
        };
      }
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
