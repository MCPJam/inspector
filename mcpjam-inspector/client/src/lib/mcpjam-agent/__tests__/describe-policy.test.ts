import { expect, it } from "vitest";
import { EVAL_AGENT_TOOL_NAMES } from "@/shared/eval-agent-scope";
import { buildEvalAuthoringTools } from "@/lib/webmcp/groups/eval-authoring";
it("exposes only context, one question and a proposal to the Describe agent", () => {
  expect([...EVAL_AGENT_TOOL_NAMES].sort()).toEqual([
    "ui_eval_context",
    "ui_eval_propose_cases",
    "ui_eval_question",
  ]);
  const names = new Set(buildEvalAuthoringTools().map((t) => t.name));
  for (const name of EVAL_AGENT_TOOL_NAMES) expect(names.has(name)).toBe(true);
});
