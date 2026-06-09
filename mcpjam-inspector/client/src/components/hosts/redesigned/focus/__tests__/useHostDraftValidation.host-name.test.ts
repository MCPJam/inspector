import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { collectHostAttentionIssues } from "../useHostDraftValidation";

describe("collectHostAttentionIssues (host display name)", () => {
  it("flags an empty host display name on the behavior tab", () => {
    // After the General tab was removed, hostDisplayName issues are
    // attributed to the Behavior tab so the badge stays visible while
    // the actual input lives in the sticky identity header.
    const draft = emptyHostConfigInputV2({
      modelId: "openai/gpt-5-mini",
      systemPrompt: "x",
    });
    const issues = collectHostAttentionIssues(draft, "   ");
    expect(
      issues.some((i) => i.tab === "behavior" && i.field === "hostDisplayName"),
    ).toBe(true);
  });

  it("does not flag host name when the parameter is omitted", () => {
    const draft = emptyHostConfigInputV2({
      modelId: "openai/gpt-5-mini",
      systemPrompt: "x",
    });
    const issues = collectHostAttentionIssues(draft);
    expect(issues.some((i) => i.field === "hostDisplayName")).toBe(false);
  });
});
