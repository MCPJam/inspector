import type { EvalRoute, SuiteOverviewView } from "./eval-route-types";

export type SuiteWorkspaceSection = "dashboard" | "cases" | "runs" | "settings";

export const SUITE_DASHBOARD_ROUTE_VIEW = "runs" satisfies SuiteOverviewView;

export const SUITE_WORKSPACE_SECTIONS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "cases", label: "Cases" },
  { id: "runs", label: "Runs" },
  { id: "settings", label: "Settings" },
] as const satisfies ReadonlyArray<{
  id: SuiteWorkspaceSection;
  label: string;
}>;

export function suiteOverviewViewToWorkspaceSection(
  view?: SuiteOverviewView,
): Exclude<SuiteWorkspaceSection, "settings"> {
  switch (view ?? SUITE_DASHBOARD_ROUTE_VIEW) {
    case "test-cases":
      return "cases";
    case "executions":
      return "runs";
    case "runs":
    default:
      return "dashboard";
  }
}

export function workspaceSectionToSuiteOverviewView(
  section: Exclude<SuiteWorkspaceSection, "settings">,
): SuiteOverviewView {
  switch (section) {
    case "cases":
      return "test-cases";
    case "runs":
      return "executions";
    case "dashboard":
    default:
      return SUITE_DASHBOARD_ROUTE_VIEW;
  }
}

export function getSuiteWorkspaceSection(
  route: EvalRoute,
): SuiteWorkspaceSection | null {
  if (route.type === "suite-edit") {
    return "settings";
  }

  if (route.type === "suite-overview") {
    return suiteOverviewViewToWorkspaceSection(route.view);
  }

  if (route.type === "run-detail") {
    return "runs";
  }

  if (route.type === "test-detail" || route.type === "test-edit") {
    return "cases";
  }

  return null;
}
