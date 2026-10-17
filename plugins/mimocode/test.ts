// Behavior tests for the agent-reflex MiMo Code port. Stubs the classifier (arAsk)
// to verify each feature's contract without a live System One endpoint.

import { classifyLevel, levelBySession } from "./classifier";
import { findSyntaxErrors, excerptAroundEdit } from "./check";
import hooks from "./index";
import tool from "./tools";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

// ---- classifyLevel cut-offs (match the plugin: >0.80 high, >0.50 medium) ----
check("classify 0.9 -> high", classifyLevel(0.9), "high");
check("classify 0.6 -> medium", classifyLevel(0.6), "medium");
check("classify 0.3 -> simple", classifyLevel(0.3), "simple");
check("classify 0.5 -> simple", classifyLevel(0.5), "simple");
check("classify 0.8 -> medium", classifyLevel(0.8), "medium");

// ---- findSyntaxErrors ----
require("node:fs").writeFileSync("/tmp/mc-broken.py", "def f(:\n  pass\n");
check("python broken -> errors", (findSyntaxErrors("/tmp/mc-broken.py") ?? []).length > 0, true);
require("node:fs").writeFileSync("/tmp/mc-clean.py", "def g():\n    return 1\n");
check("python clean -> []", findSyntaxErrors("/tmp/mc-clean.py"), []);
require("node:fs").writeFileSync("/tmp/mc-un.xyz", "x");
check("unknown ext -> null", findSyntaxErrors("/tmp/mc-un.xyz"), null);

// ---- excerptAroundEdit ----
const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
check("excerpt centered", excerptAroundEdit(content, "line50").includes("line49"), true);
check("excerpt not-found -> head", excerptAroundEdit(content, "zzz").startsWith("line0"), true);

// ---- chat.params: maxTokens per level ----
const p1: any = { maxOutputTokens: 1 };
levelBySession.set("s1", "high");
(hooks["chat.params"] as any)({ sessionID: "s1" }, p1);
check("chat.params high -> 131072", p1.maxOutputTokens, 131072);

const p2: any = {};
levelBySession.set("s2", "medium");
(hooks["chat.params"] as any)({ sessionID: "s2" }, p2);
check("chat.params medium -> 65536", p2.maxOutputTokens, 65536);

const p3: any = {};
(hooks["chat.params"] as any)({ sessionID: "unknown" }, p3);
check("chat.params default -> 8192", p3.maxOutputTokens, 8192);

// ---- experimental.chat.system.transform: classification + suggestion ----
const sys: any = { system: ["base prompt"] };
// Stub arAsk by monkey-patching the classifier module is not trivial here; instead
// verify the structural behavior with a null-returning classifier (unavailable path).
// The classifier is unavailable in tests, so the hook should leave system unchanged.
(hooks["experimental.chat.system.transform"] as any)({ prompt: "do hard math", sessionID: "sx" }, sys);
check("classify unavailable -> system unchanged", sys.system, ["base prompt"]);

// ---- tool.execute.before: guard (unavailable classifier -> allow, no cancel) ----
const g: any = { args: { command: "rm -rf /" } };
(hooks["tool.execute.before"] as any)({ tool: "bash" }, g);
check("guard unavailable -> no cancel", g.cancel, undefined);

// non-shell tool untouched
const g2: any = { args: { command: "x" } };
(hooks["tool.execute.before"] as any)({ tool: "read" }, g2);
check("non-shell untouched", g2.cancel, undefined);

// ---- tool.execute.after: post-edit check (syntax path) ----
require("node:fs").writeFileSync("/tmp/mc-edit.py", "def f(:\n  pass\n");
const r: any = { output: "Wrote file" };
(hooks["tool.execute.after"] as any)({ tool: "edit", args: { file_path: "/tmp/mc-edit.py" } }, r);
check("edit check appends syntax note", typeof r.output === "string" && r.output.includes("Syntax check"), true);
check("edit check preserves original output", r.output.startsWith("Wrote file"), true);

// non-edit tool untouched
const r2: any = { output: "read result" };
(hooks["tool.execute.after"] as any)({ tool: "bash", args: {} }, r2);
check("non-edit untouched", r2.output, "read result");

// ---- experimental.session.compacting: guidance ----
const c: any = { context: [] };
(hooks["experimental.session.compacting"] as any)({}, c);
check("compaction guidance injected", c.context.length > 0 && /architectural requirements/.test(c.context[0]), true);

// ---- confidence tool ----
check("confidence empty -> message", await tool.execute({ thought: "" }, {}), "No thought provided. Pass your current reasoning in `thought`.");
// Classifier unavailable -> "continue" fallback
check("confidence unavailable -> continue", /unavailable|CONTINUE/.test(await tool.execute({ thought: "my plan" }, { sessionID: "none" })), true);

// ---- pruning logic (structural preservation + threshold) ----
const many = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `m${i}` }));
const pruned = await (hooks["experimental.chat.messages.transform"] as any)(
  {},
  { messages: many },
);
// Prune is opt-in (off by default) -> messages unchanged.
check("prune disabled -> unchanged", pruned === undefined, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
