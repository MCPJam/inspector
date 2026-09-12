import { expect, it } from "vitest";
import { evalChatGuidance } from "../eval-chat-guidance";
import {
  evalAgentSystemPrompt,
  type EvalAgentScope,
} from "@/shared/eval-agent-scope";
const scope: EvalAgentScope = {
  id: "s",
  kind: "evals",
  version: 1,
  projectId: "p",
  suiteId: "suite",
  suiteName: "Suite",
  caseId: "draft:describe",
};
it("keeps guidance focused on creating tests even when the draft has content", () => {
  for (const hasCaseContent of [false, true]) {
    const guide = evalChatGuidance({ ...scope, hasCaseContent });
    expect(guide.title).toBe("What do you want to test?");
    expect(guide.suggestions.map((s) => s.label)).toEqual([
      "Suggest a test from my tools",
    ]);
  }
});
it("instructs the model to propose cases and leave creation to the application", () => {
  const prompt = evalAgentSystemPrompt(scope);
  expect(prompt).toContain("Never ask questions in prose");
  expect(prompt).toContain("ui_eval_propose_cases");
  expect(prompt).toContain("A proposal does not edit or save anything");
  expect(prompt).not.toContain("ui_eval_edit_case");
});
