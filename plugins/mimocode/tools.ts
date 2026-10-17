// agent-reflex (MiMo Code) — confidence_check custom tool.
//
// A MiMo Code custom tool (.mimocode/tools/agent-reflex-confidence.ts). Port of the
// OpenCode plugin's systemone_check_confidence tool: scores the model's current line
// of thought with the System One classifier and returns CONTINUE/RESTART.

import { arAsk, arLog, levelBySession } from "./classifier";

export default {
  description:
    "Ask System One to evaluate your current line of thought before you commit to it. Pass your reasoning so far, or your draft solution. Returns a confidence score and a verdict. If the verdict is RESTART, discard that line of thought and solve the problem again more directly.",
  args: {
    thought: {
      type: "string",
      description: "Your current line of thought or draft solution to evaluate.",
    },
  },
  async execute(args: any, ctx: any) {
    const thought = String(args?.thought ?? "").trim();
    if (!thought) return "No thought provided. Pass your current reasoning in `thought`.";

    // Threshold by the session's stored complexity level (default simple).
    const sessionID: string = ctx?.sessionID ?? "";
    const level = (sessionID && levelBySession.get(sessionID)) || "simple";
    const threshold = level === "simple" ? 0.75 : 0.85;

    const confidence = await arAsk(
      `AI line of thought:\n${thought}`,
      "Does this line of thought seem direct, correct and without hesitation or redundant loops?",
    );

    if (confidence === null) {
      return "System One confidence check unavailable. Continue with your current approach.";
    }

    const pct = confidence * 100;
    arLog(`confidence=${confidence.toFixed(3)} threshold=${threshold}`);
    if (confidence < threshold) {
      return `Confidence ${pct.toFixed(1)}% is below the ${threshold * 100}% threshold. Verdict: RESTART. Discard this line of thought and solve the problem again, focusing on the cleanest, most direct solution.`;
    }
    return `Confidence ${pct.toFixed(1)}%. Verdict: CONTINUE.`;
  },
};
