import { describe, expect, it } from "vitest";
import { caseBackTarget, caseIdOf, routeAfterSave } from "../case-editor-nav";

describe("case editor navigation", () => {
  it("leads Back from a case to Suite settings › Test cases", () => {
    expect(
      caseBackTarget({ type: "case-settings", suiteId: "s", caseId: "c" }),
    ).toEqual({
      label: "Back to suite settings",
      route: { type: "suite-settings", suiteId: "s", tab: "cases" },
    });
    expect(caseBackTarget({ type: "case-new", suiteId: "s" }).route).toEqual({
      type: "suite-settings",
      suiteId: "s",
      tab: "cases",
    });
  });

  it("leads Back from the editor opened on a test run to that test run (D13)", () => {
    expect(
      caseBackTarget({
        type: "test-run-edit",
        suiteId: "s",
        runId: "r",
        caseId: "c",
      }),
    ).toEqual({
      label: "Back to test run",
      route: { type: "test-run", suiteId: "s", runId: "r", caseId: "c" },
    });
  });

  it("leads Back from Test Case Evaluators to the case", () => {
    expect(
      caseBackTarget({ type: "case-evaluators", suiteId: "s", caseId: "c" }),
    ).toEqual({
      label: "Back to test case",
      route: { type: "case-settings", suiteId: "s", caseId: "c" },
    });
  });

  it("moves a new case to its own page after the first save only", () => {
    expect(caseIdOf({ type: "case-new", suiteId: "s" })).toBeNull();
    expect(routeAfterSave({ type: "case-new", suiteId: "s" }, "c")).toEqual({
      type: "case-settings",
      suiteId: "s",
      caseId: "c",
    });
    expect(
      routeAfterSave({ type: "case-settings", suiteId: "s", caseId: "c" }, "c"),
    ).toBeNull();
  });
});
