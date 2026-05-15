import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";
import { collectHostAttentionIssues } from "../useHostDraftValidation";

describe("collectHostAttentionIssues (host display name)", () => {
  it("flags an empty host display name on the general tab", () => {
    const draft = emptyHostConfigInputV2({
      modelId: "openai/gpt-5-mini",
      systemPrompt: "x",
    });
    const issues = collectHostAttentionIssues(draft, "   ");
    expect(issues.some((i) => i.tab === "general" && i.field === "hostDisplayName")).toBe(
      true,
    );
  });

  it("does not flag host name when the parameter is omitted", () => {
    const draft = emptyHostConfigInputV2({
      modelId: "openai/gpt-5-mini",
      systemPrompt: "x",
    });
    const issues = collectHostAttentionIssues(draft);
    expect(issues.some((i) => i.tab === "general")).toBe(false);
  });
});
