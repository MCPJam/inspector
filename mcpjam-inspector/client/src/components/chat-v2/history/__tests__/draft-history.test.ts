import { describe, expect, it } from "vitest";
import {
  buildDraftHistoryPreview,
  resolveRestoredDraftInput,
} from "../draft-history";

describe("draft history helpers", () => {
  it("uses only typed input for the persisted draft preview", () => {
    expect(
      buildDraftHistoryPreview({
        input: "  typed draft  ",
        mcpPromptResults: [{ name: "prompt-only" }] as any,
        skillResults: [{ name: "skill-only" }] as any,
        fileAttachments: [{ file: new File(["x"], "notes.txt") }] as any,
      }),
    ).toBe("typed draft");
  });

  it("does not turn prompt-only, skill-only, or file-only drafts into plain text previews", () => {
    expect(
      buildDraftHistoryPreview({
        input: "",
        mcpPromptResults: [{ name: "prompt-only" }] as any,
        skillResults: [],
        fileAttachments: [],
      }),
    ).toBe("");
    expect(
      buildDraftHistoryPreview({
        input: "",
        mcpPromptResults: [],
        skillResults: [{ name: "skill-only" }] as any,
        fileAttachments: [],
      }),
    ).toBe("");
    expect(
      buildDraftHistoryPreview({
        input: "",
        mcpPromptResults: [],
        skillResults: [],
        fileAttachments: [{ file: new File(["x"], "notes.txt") }] as any,
      }),
    ).toBe("");
  });

  it("restores only the saved draft input", () => {
    expect(resolveRestoredDraftInput({ draftInput: "hello" })).toBe("hello");
    expect(resolveRestoredDraftInput()).toBe("");
  });
});
