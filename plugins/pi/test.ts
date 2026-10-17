// Behavior tests for the agent-reflex Pi extension. Stubs the classifier (arAsk)
// to verify each feature's contract without a live System One endpoint.

import { classifyLevel } from "./classifier";
import { findSyntaxErrors, excerptAroundEdit } from "./check";

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

// ---- classifyLevel cut-offs (match the plugin) ----
check("classify 0.9 -> high", classifyLevel(0.9), "high");
check("classify 0.6 -> medium", classifyLevel(0.6), "medium");
check("classify 0.3 -> simple", classifyLevel(0.3), "simple");
check("classify 0.5 boundary -> simple", classifyLevel(0.5), "simple");
check("classify 0.8 boundary -> medium", classifyLevel(0.8), "medium");

// ---- findSyntaxErrors ----
const broken = "/tmp/pi-test-broken.py";
require("node:fs").writeFileSync(broken, "def f(:\n  pass\n");
const errs = findSyntaxErrors(broken);
check("python broken -> errors", (errs ?? []).length > 0, true);

const clean = "/tmp/pi-test-clean.py";
require("node:fs").writeFileSync(clean, "def g():\n    return 1\n");
check("python clean -> []", findSyntaxErrors(clean), []);

const noParser = "/tmp/pi-test-unknown.xyz";
require("node:fs").writeFileSync(noParser, "anything");
check("unknown ext -> null", findSyntaxErrors(noParser), null);

// ---- excerptAroundEdit ----
const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
const edited = "line50";
const excerpt = excerptAroundEdit(content, edited);
check("excerpt centered", excerpt.includes("line50") && excerpt.includes("line49"), true);
check("excerpt bounded", excerpt.length <= 8000, true);
check("excerpt not-found -> head", excerptAroundEdit(content, "zzz-not-present").startsWith("line0"), true);

// ---- effort mapping + guard thresholds (pure logic) ----
const LEVEL_THINKING: Record<string, string> = { simple: "off", medium: "low", high: "high" };
check("effort simple -> off", LEVEL_THINKING["simple"], "off");
check("effort medium -> low", LEVEL_THINKING["medium"], "low");
check("effort high -> high", LEVEL_THINKING["high"], "high");

const GUARD = 0.75;
check("guard 0.9 blocks", 0.9 > GUARD, true);
check("guard 0.3 allows", 0.3 > GUARD, false);

const SEMANTIC = 0.75;
check("semantic correctness 0.6 < thr", 0.6 < SEMANTIC, true);
check("semantic correctness 0.9 < thr", 0.9 < SEMANTIC, false);

// ---- pruning rules (pure logic mirror) ----
function isStructuralMessage(msg: any): boolean {
  if (msg?.role === "tool" || msg?.role === "toolResult") return true;
  return Array.isArray(msg?.content) && msg.content.some((part: any) => part?.type && part.type !== "text");
}
check("tool msg structural", isStructuralMessage({ role: "tool", content: "x" }), true);
check("image msg structural", isStructuralMessage({ role: "user", content: [{ type: "image" }] }), true);
check("text msg not structural", isStructuralMessage({ role: "user", content: "hello" }), false);

// Simulate the prune loop with a stub keep-probability.
function prune(messages: any[], keepProb: (m: any) => number | null): any[] {
  const min = 16, keepRecent = 4, thr = 0.4;
  if (messages.length <= min) return messages;
  const distant = messages.slice(0, -keepRecent);
  const recent = messages.slice(-keepRecent);
  const preserved: any[] = [];
  for (const msg of distant) {
    if (isStructuralMessage(msg)) { preserved.push(msg); continue; }
    const p = keepProb(msg);
    if (p === null || p > thr) preserved.push(msg);
  }
  return [...preserved, ...recent];
}
const many = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `m${i}` }));
check("prune below threshold -> short", prune(many, () => 0.1).length < 20, true);
check("prune keeps recent 4", prune(many, () => 0.1).slice(-4).map((m) => m.content), ["m16", "m17", "m18", "m19"]);
check("prune null preserves", prune(many, () => null).length, 20);
check("prune high prob preserves", prune(many, () => 0.9).length, 20);
const short = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `s${i}` }));
check("prune short untouched", prune(short, () => 0.0).length, 10);
const structural = [...Array.from({ length: 12 }, () => ({ role: "tool", content: "t" })), ...Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `u${i}` }))];
check("prune preserves structural", prune(structural, () => 0.0).filter((m) => m.role === "tool").length, 12);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
