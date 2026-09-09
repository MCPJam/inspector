import { describe, expect, it } from "vitest";
import { evalChatGuidance } from "../eval-chat-guidance";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
const scope: EvalAgentScope = {
  id: "scope",
  kind: "evals",
  version: 1,
  projectId: "p",
  suiteId: "s",
  suiteName: "Suite",
};
describe("entry-specific chat guidance", () => {
  it("guides an empty Describe case instead of suggesting improvements", () => {
    const guide = evalChatGuidance({
      ...scope,
      caseId: "draft:describe",
      hasCaseContent: false,
    });
    expect(guide.title).toBe("What behavior should this case verify?");
    expect(guide.suggestions.map((s) => s.label)).toContain(
      "Help me choose a behavior",
    );
    expect(JSON.stringify(guide)).not.toContain("focused improvement");
  });
  it("uses content over entry point, including an empty saved case", () => {
    expect(
      evalChatGuidance({ ...scope, caseId: "saved", hasCaseContent: false })
        .title,
    ).toBe("What behavior should this case verify?");
    expect(
      evalChatGuidance({
        ...scope,
        caseId: "draft:describe",
        hasCaseContent: true,
      }).title,
    ).toBe("What would you like to improve?");
  });
  it("distinguishes generating, reviewing drafts, and starting suite coverage", () => {
    expect(evalChatGuidance(scope).title).toBe("What coverage should we add?");
    expect(
      evalChatGuidance(scope, { status: "running", drafts: [] }).description,
    ).toContain("next generation pass");
    expect(
      evalChatGuidance(scope, { status: "ready", drafts: [{} as any] }).title,
    ).toBe("What should we refine?");
  });
});
