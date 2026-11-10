import { describe, expect, it } from "vitest";
import { conformanceVerdict } from "../conformance-verdict";

describe("conformanceVerdict", () => {
  it("names the verdict the same way everywhere", () => {
    expect(conformanceVerdict("failed", 0)).toEqual({
      label: "Not conformant",
      tone: "bad",
    });
    expect(conformanceVerdict("incomplete", 0)).toEqual({
      label: "Incomplete run",
      tone: "warn",
    });
    expect(conformanceVerdict("passed", 2)).toEqual({
      label: "Conformant, with advice",
      tone: "ok",
    });
    expect(conformanceVerdict("passed", 0)).toEqual({
      label: "Conformant",
      tone: "ok",
    });
  });

  it("never reads a missing or unknown outcome as a pass", () => {
    for (const outcome of [null, undefined, "unknown"]) {
      expect(conformanceVerdict(outcome, 0)).toEqual({
        label: "Incomplete run",
        tone: "warn",
      });
    }
  });

  it("does not let advice soften a failure", () => {
    expect(conformanceVerdict("failed", 3).label).toBe("Not conformant");
  });
});
