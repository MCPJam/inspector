import { describe, expect, it } from "vitest";
import {
  EVAL_NAV_STEP_PARAM,
  testRunEditPath,
  testRunCaseKey,
} from "../test-run-links";
import { fixtureIteration } from "./test-run-fixtures";

const ids = { suiteId: "s", runId: "r", testCaseId: "c" };

describe("testRunEditPath", () => {
  it("opens the editor from this test run", () => {
    expect(testRunEditPath(ids)).toBe("/evaluate/suite/s/runs/r/cases/c/edit");
  });
  it("adds the preview key as ?step=, encoded", () => {
    expect(EVAL_NAV_STEP_PARAM).toBe("step");
    expect(testRunEditPath(ids, "check:a/b")).toBe(
      "/evaluate/suite/s/runs/r/cases/c/edit?step=check%3Aa%2Fb",
    );
  });
  it("keys a test run by the iteration's case id", () => {
    expect(testRunCaseKey(fixtureIteration("i", "r"))).toBe("case-sketch");
  });
});
