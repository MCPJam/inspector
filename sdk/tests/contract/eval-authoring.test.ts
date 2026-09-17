import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stepsSchema } from "../../src/contract/steps.js";
import {
  authoredEvalCaseSchema,
  authoredCaseBlockedReason,
  evalAuthoringDraftSchema,
} from "../../src/contract/eval-authoring.js";

describe("shared authoring contract", () => {
  it("keeps the worker model schema identical to the SDK step schema", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../src/contract/__fixtures__/eval-authoring-steps-schema.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    // Native Zod conversion preserves open record values; the AI helper closes them.
    expect(fixture).toEqual(
      z.toJSONSchema(stepsSchema, { target: "draft-7", unrepresentable: "any" })
    );
  });
  it("preserves prompt-only imports and explicit-check cases", () => {
    const legacy = authoredEvalCaseSchema.parse({
      title: "Existing case",
      steps: [{ id: "p", kind: "prompt", prompt: "Find a document" }],
      expectedOutput: "Document found",
    });
    expect(authoredCaseBlockedReason(legacy)).toBeUndefined();
    expect(legacy.runs).toBe(5);
    expect(legacy.models).toEqual([]);
    const checked = authoredEvalCaseSchema.parse({
      ...legacy,
      expectedOutput: undefined,
      checks: {
        mode: "replace",
        list: [{ type: "responseContains", needle: "found" }],
      },
    });
    expect(authoredCaseBlockedReason(checked)).toBeUndefined();
  });
  it("retains human evidence and revision-scoped review", () => {
    const draft = evalAuthoringDraftSchema.parse({
      version: 1,
      draftId: "d",
      revision: 2,
      case: {
        title: "Refusal",
        steps: [{ id: "p", kind: "prompt", prompt: "Invalid request" }],
        isNegativeTest: true,
      },
      issues: [],
      additions: [],
      review: "required",
      evidenceNotes: ["The project ID was supplied by the reviewer."],
    });
    expect(draft.evidenceNotes).toHaveLength(1);
    expect(draft.review).toBe("required");
  });
});
