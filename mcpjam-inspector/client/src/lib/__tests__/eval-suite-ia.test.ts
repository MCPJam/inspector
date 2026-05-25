import { describe, expect, it } from "vitest";
import {
  getSuiteWorkspaceSection,
  suiteOverviewViewToWorkspaceSection,
  SUITE_DASHBOARD_ROUTE_VIEW,
  workspaceSectionToSuiteOverviewView,
} from "../eval-suite-ia";

describe("eval-suite-ia", () => {
  it("keeps the default suite route mapped to Dashboard", () => {
    expect(SUITE_DASHBOARD_ROUTE_VIEW).toBe("runs");
    expect(suiteOverviewViewToWorkspaceSection()).toBe("dashboard");
    expect(suiteOverviewViewToWorkspaceSection("runs")).toBe("dashboard");
    expect(workspaceSectionToSuiteOverviewView("dashboard")).toBe("runs");
  });

  it("maps IA labels onto the existing route views", () => {
    expect(suiteOverviewViewToWorkspaceSection("test-cases")).toBe("cases");
    expect(suiteOverviewViewToWorkspaceSection("executions")).toBe("runs");
    expect(workspaceSectionToSuiteOverviewView("cases")).toBe("test-cases");
    expect(workspaceSectionToSuiteOverviewView("runs")).toBe("executions");
  });

  it("derives the active workspace section from drill-down routes", () => {
    expect(
      getSuiteWorkspaceSection({
        type: "run-detail",
        suiteId: "suite-1",
        runId: "run-1",
      }),
    ).toBe("runs");
    expect(
      getSuiteWorkspaceSection({
        type: "test-edit",
        suiteId: "suite-1",
        testId: "case-1",
      }),
    ).toBe("cases");
    expect(
      getSuiteWorkspaceSection({ type: "suite-edit", suiteId: "suite-1" }),
    ).toBe("settings");
  });
});
