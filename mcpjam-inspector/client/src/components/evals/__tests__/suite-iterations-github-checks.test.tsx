import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDataRouter } from "./settings-sheet-harness";
import { render, screen } from "@testing-library/react";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";

/**
 * The GitHub Checks availability read is allowed to THROW.
 *
 * It is a backend-decided gate, and the backend refuses (rather than answers)
 * for a caller who is not a signed-in member of the org — `useQuery` re-throws
 * that during render. These tests pin the consequence: the suite settings sheet
 * loses the GitHub Checks section and nothing else.
 */

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn(() => vi.fn()),
  useQuery: vi.fn(),
  availability: vi.fn(),
  reportBoundaryError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: any) => (mocks.useMutation as any)(name),
  useQuery: (name: any, args: any) => (mocks.useQuery as any)(name, args),
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn() }),
}));

vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksAvailability: (organizationId: unknown) =>
    mocks.availability(organizationId),
}));

vi.mock("../suite-github-checks-section", () => ({
  SuiteGithubChecksSection: () => <div data-testid="github-checks-section" />,
}));

vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError: (...args: unknown[]) =>
    mocks.reportBoundaryError(...args),
}));

vi.mock("@/hooks/useProjectComputer", () => ({
  useEphemeralCloudAvailable: () => true,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));

vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({ runTrendData: [], modelStats: [] }),
  useRunDetailData: () => ({ caseGroupsForSelectedRun: [] }),
}));

vi.mock("../suite-header", () => ({
  SuiteHeader: () => <div data-testid="suite-header" />,
}));

vi.mock("@/components/evals/suite-environment-composer-bar", () => ({
  SuiteEnvironmentComposerBar: () => (
    <div data-testid="suite-environment-bar">composer</div>
  ),
}));

vi.mock("../eval-export-modal", () => ({ EvalExportModal: () => null }));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));

// S3 — capabilities `unavailable` is the "behave exactly as before" case, and
// it is what these tests want: the GitHub row's own gate is the availability
// read, not the capabilities query.
vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({ state: "unavailable", capabilities: null }),
}));

const noopNav = {
  toSuiteOverview: vi.fn(),
  toRunDetail: vi.fn(),
  toTestDetail: vi.fn(),
  toTestEdit: vi.fn(),
  toSuiteEdit: vi.fn(),
};

const baseSuite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u",
  name: "Test Suite",
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};

function renderSettingsSheet() {
  return render(
      withDataRouter(
    <SuiteIterationsView
      suite={baseSuite}
      cases={[]}
      iterations={[]}
      allIterations={[]}
      runs={[]}
      runsLoading={false}
      aggregate={null}
      onRerun={vi.fn()}
      onCancelRun={vi.fn()}
      onDelete={vi.fn()}
      onDeleteRun={vi.fn()}
      onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
      connectedServerNames={new Set()}
      canDeleteSuite
      rerunningSuiteId={null}
      cancellingRunId={null}
      deletingSuiteId={null}
      deletingRunId={null}
      availableModels={[]}
      organizationId="org-1"
      projectId="project-1"
      route={{ type: "suite-edit", suiteId: "suite-1" }}
      navigation={noopNav}
    />)
    );
}

describe("SuiteIterationsView GitHub Checks gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMutation.mockReturnValue(vi.fn());
    mocks.useQuery.mockImplementation(() => undefined);
    // The throwing cases run the REAL boundary, whose componentDidCatch (and
    // React itself) logs the full error + component stack. That noise on a
    // passing run buries real failures, so it stays out of the output.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the settings sheet up when the availability read throws", () => {
    mocks.availability.mockImplementation(() => {
      throw new Error(
        "[CONVEX Q(github/checkRepoConfigs:getGithubChecksSettingsAvailability)] Server Error"
      );
    });

    const { container } = renderSettingsSheet();

    // The sheet survived: a sibling section still rendered.
    expect(screen.getByText("Minimum iterations")).toBeTruthy();
    // The section whose gate refused is now a DISABLED ROW that says so,
    // rather than nothing at all. A row that vanishes makes a refused gate,
    // a missing permission and a backend that could not answer look identical
    // — and none of them is a thing the reader can act on from an empty space.
    expect(screen.queryByTestId("github-checks-section")).toBeNull();
    const row = container.querySelector('[data-setting-key="githubChecks"]');
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-disabled-reason")).toBe(
      "GitHub Checks could not be loaded for this organization"
    );
  });

  it("still reports the swallowed error to the error sinks", () => {
    mocks.availability.mockImplementation(() => {
      throw new Error("Not a member of this organization");
    });

    renderSettingsSheet();

    // The fallback ROW is a UI choice, never a telemetry one: a boundary that
    // renders something helpful still has to report what it caught.
    expect(mocks.reportBoundaryError).toHaveBeenCalled();
    expect(mocks.reportBoundaryError.mock.calls[0]?.[2]).toBe(
      "suite_github_checks"
    );
  });

  it("hides the section when the backend answers `disabled`", () => {
    mocks.availability.mockReturnValue({ state: "disabled" });

    const { container } = renderSettingsSheet();

    // `disabled` is the backend ANSWERING, not failing — the boundary never
    // trips, so the row stays hidden exactly as before.
    expect(screen.getByText("Minimum iterations")).toBeTruthy();
    expect(screen.queryByTestId("github-checks-section")).toBeNull();
    expect(
      container.querySelector('[data-setting-key="githubChecks"]')
    ).toBeNull();
    expect(mocks.reportBoundaryError).not.toHaveBeenCalled();
  });

  it("renders the section when the backend answers `enabled`", () => {
    mocks.availability.mockReturnValue({ state: "enabled" });

    renderSettingsSheet();

    expect(screen.getByText("GitHub Checks")).toBeTruthy();
    expect(screen.getByTestId("github-checks-section")).toBeTruthy();
  });
});
