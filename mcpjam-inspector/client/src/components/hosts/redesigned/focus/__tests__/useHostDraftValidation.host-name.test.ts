import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  collectHostAttentionIssues,
  hasBlockingErrors,
} from "../useHostDraftValidation";

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
    expect(hasBlockingErrors(issues)).toBe(true);
  });

  it("does not flag host name when the parameter is omitted", () => {
    const draft = emptyHostConfigInputV2({
      modelId: "openai/gpt-5-mini",
      systemPrompt: "x",
    });
    const issues = collectHostAttentionIssues(draft);
    expect(issues.some((i) => i.field === "hostDisplayName")).toBe(false);
  });

  it("does not block saving host settings when no model is selected", () => {
    const draft = emptyHostConfigInputV2({
      modelId: "",
      systemPrompt: "x",
    });
    const issues = collectHostAttentionIssues(draft, "Test Host");
    const modelIssue = issues.find((i) => i.field === "modelId");

    expect(modelIssue?.level).toBe("warning");
    expect(hasBlockingErrors(issues)).toBe(false);
  });
});
