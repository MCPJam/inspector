import { describe, expect, it } from "vitest";
import { saveDisabledReason } from "../useHostDraftValidation";
import type { HostAttentionIssue } from "../../types";

const err = (message: string): HostAttentionIssue => ({
  level: "error",
  tab: "behavior",
  field: "hostDisplayName",
  message,
});
const warn = (message: string): HostAttentionIssue => ({
  level: "warning",
  tab: "behavior",
  field: "modelId",
  message,
});

describe("saveDisabledReason", () => {
  it("returns null while saving (spinner already communicates)", () => {
    expect(
      saveDisabledReason({ isDirty: true, isSaving: true, issues: [err("x")] }),
    ).toBeNull();
  });

  it("returns null when the button is enabled (dirty, no blocking errors)", () => {
    expect(
      saveDisabledReason({ isDirty: true, isSaving: false, issues: [] }),
    ).toBeNull();
  });

  it("explains that nothing has changed when the draft is clean", () => {
    expect(
      saveDisabledReason({ isDirty: false, isSaving: false, issues: [] }),
    ).toMatch(/no unsaved changes/i);
  });

  it("does NOT claim a model is required — an unset model never gates Save", () => {
    // The reporter's exact case: dirty draft with only the model warning.
    // Save is enabled, so there is no disabled reason to show.
    expect(
      saveDisabledReason({
        isDirty: true,
        isSaving: false,
        issues: [warn("Pick a model before chatting")],
      }),
    ).toBeNull();
  });

  it("surfaces blocking validation errors verbatim over the clean message", () => {
    const reason = saveDisabledReason({
      isDirty: false,
      isSaving: false,
      issues: [err("Client name is required"), warn("Empty system prompt")],
    });
    expect(reason).toBe("Client name is required");
  });

  it("joins multiple blocking errors", () => {
    const reason = saveDisabledReason({
      isDirty: true,
      isSaving: false,
      issues: [
        err("Client name is required"),
        err("Request timeout must be a positive number"),
      ],
    });
    expect(reason).toBe(
      "Client name is required · Request timeout must be a positive number",
    );
  });
});
