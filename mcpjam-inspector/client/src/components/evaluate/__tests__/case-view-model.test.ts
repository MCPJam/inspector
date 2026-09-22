import { describe, expect, it } from "vitest";
import {
  caseViewModel,
  capturedCaseChanged,
} from "../case-workspace/case-view-model";
const steps = [{ id: "p", kind: "prompt" as const, prompt: "Captured prompt" }];
describe("case view snapshots", () => {
  it.each(["draft", "live", "historical"] as const)(
    "preserves ordered data in %s mode",
    (mode) => {
      const source = { steps, expectedOutput: "Captured outcome" };
      const view = caseViewModel(mode, source);
      expect(view.steps).toEqual(steps);
      expect(view.expectedOutput).toBe(source.expectedOutput);
      expect(view.readOnly).toBe(mode !== "draft");
      expect(view.availability.steps).toBe(true);
    },
  );
  it("does not invent steps or inherit draft data for missing snapshots", () => {
    expect(caseViewModel("historical", undefined).steps).toEqual([]);
    expect(caseViewModel("historical", undefined).availability.steps).toBe(
      false,
    );
    expect(caseViewModel("historical", { steps: [] }).availability.steps).toBe(
      true,
    );
    expect(
      capturedCaseChanged({ steps, expectedOutput: "Current" }, undefined),
    ).toBe(false);
  });
  it("converts legacy captured prompts and compares only captured fields", () => {
    const legacy = { query: "Captured prompt" };
    expect(caseViewModel("historical", legacy).steps[0]).toMatchObject({
      kind: "prompt",
      prompt: "Captured prompt",
    });
    expect(
      capturedCaseChanged({ steps, expectedOutput: "New outcome" }, legacy),
    ).toBe(false);
    expect(
      capturedCaseChanged(
        { steps: [{ ...steps[0], prompt: "Changed" }] },
        legacy,
      ),
    ).toBe(true);
  });
});
