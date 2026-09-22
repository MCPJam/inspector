import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  collectHostAttentionIssues,
  hasBlockingErrors,
  saveDisabledReason,
} from "../useHostDraftValidation";

/**
 * The forward-client invariant, from the editor's side: a host that HAS a
 * model may not be saved without one, because every environment selecting that
 * host inherits it as the execution model. A host that never had one is
 * grandfathered so unrelated edits still save.
 */
describe("collectHostAttentionIssues (model)", () => {
  it("blocks Save when an edit clears a previously pinned model", () => {
    const draft = emptyHostConfigInputV2({ modelId: "", systemPrompt: "x" });
    const issues = collectHostAttentionIssues(draft, "Test Host", {
      savedModelId: "anthropic/claude-sonnet-4-5",
    });
    const modelIssue = issues.find((i) => i.field === "modelId");

    expect(modelIssue?.level).toBe("error");
    expect(modelIssue?.tab).toBe("behavior");
    expect(hasBlockingErrors(issues)).toBe(true);
    expect(
      saveDisabledReason({ isDirty: true, isSaving: false, issues })
    ).toContain("Pick a model");
  });

  it("keeps a legacy modelless host editable for unrelated changes", () => {
    const draft = emptyHostConfigInputV2({ modelId: "", systemPrompt: "x" });
    for (const savedModelId of [undefined, "", "   "]) {
      const issues = collectHostAttentionIssues(draft, "Test Host", {
        savedModelId,
      });
      expect(issues.find((i) => i.field === "modelId")?.level).toBe("warning");
      expect(hasBlockingErrors(issues)).toBe(false);
    }
  });

  it("raises nothing once a model is picked", () => {
    const draft = emptyHostConfigInputV2({
      modelId: "anthropic/claude-sonnet-4-5",
      systemPrompt: "x",
    });
    const issues = collectHostAttentionIssues(draft, "Test Host", {
      savedModelId: "",
    });
    expect(issues.some((i) => i.field === "modelId")).toBe(false);
    expect(hasBlockingErrors(issues)).toBe(false);
  });

  it("treats a whitespace-only model as unset", () => {
    const draft = emptyHostConfigInputV2({ modelId: "  ", systemPrompt: "x" });
    const issues = collectHostAttentionIssues(draft, "Test Host", {
      savedModelId: "openai/gpt-5-mini",
    });
    expect(issues.find((i) => i.field === "modelId")?.level).toBe("error");
  });
});
