---
name: confidence
description: Ask the System One classifier to evaluate the current line of thought or draft solution and return a confidence verdict. Use before committing to a solution on a medium or high complexity task. Returns CONTINUE or RESTART.
---

# Confidence check

Evaluate the current line of thought or draft solution with the System One
classifier and follow its verdict.

1. Gather the current line of thought or draft solution as one block of text.
2. Run the confidence check script with that text:

   ```
   "${PLUGIN_ROOT:-$HOME/.codex/plugins/agent-reflex}/scripts/confidence.sh" check
   ```

   Pass the thought through stdin. The script returns a confidence percentage and
   a verdict.

3. Interpret the verdict:
   - **CONTINUE** — the line of thought is direct, correct, and without redundant
     loops. Proceed with it.
   - **RESTART** — the confidence is below the threshold for the current
     complexity level. Discard that line of thought and solve the problem again,
     focusing on the cleanest, most direct solution.

If the script reports the classifier is unavailable, continue with the current
approach and note that the check could not run.

Thresholds: simple 0.75, medium/high 0.85 (the plugin's default). The level is
read from the state the classify hook stored for this session; when absent the
simple threshold applies.
