/**
 * The Triggers tab under the `scheduled-evals-enabled` flag.
 *
 * Schedule is its OWN flag now, split out of `synthetic-monitors` so it can
 * stay dark while the monitor scorers ship. With it off the tab must degrade
 * cleanly rather than half-render: GitHub Checks alone, and no right rail —
 * `SuiteSettingsSubsectionNav` returns `null` at one subsection, so a rail
 * listing a single jump link would mean the row leaked back in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { showSettingsGroup, withDataRouter } from "./settings-sheet-harness";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";

// `vi.hoisted` so the state exists before the hoisted `vi.mock` factory can
// read it — the repo convention for a mutable flag mock.
const flagState = vi.hoisted(() => ({
  scheduledEvals: false,
  syntheticMonitors: false,
}));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) => {
    if (key === "scheduled-evals-enabled") return flagState.scheduledEvals;
    if (key === "synthetic-monitors") return flagState.syntheticMonitors;
    return false;
  },
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn() }),
}));

// GitHub Checks is the OTHER row in this tab, and the one that must survive
// Schedule going dark. Available, and stubbed to an inert marker.
vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksAvailability: () => ({ state: "enabled" }),
  useGithubChecksSettings: () => ({
    availability: { state: "enabled" },
    repos: [],
  }),
}));
vi.mock("../suite-github-checks-section", () => ({
  SuiteGithubChecksSection: () => <div data-testid="github-checks-section" />,
}));

// The Schedule row's own body — a marker, so its presence is decided by the
// gate above it rather than by whether the editor happens to render.
vi.mock("../suite-automation-row", () => ({
  SuiteAutomationRow: () => <div data-testid="schedule-row" />,
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
    <div data-testid="suite-environment-bar" />
  ),
}));
vi.mock("../eval-export-modal", () => ({ EvalExportModal: () => null }));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));
vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/use-suite-capabilities")
  >();
  return {
    ...actual,
    useSuiteCapabilities: () => ({ state: "unavailable", capabilities: null }),
  };
});

const noopNav = {
  toSuiteOverview: vi.fn(),
  toRunDetail: vi.fn(),
  toTestDetail: vi.fn(),
  toTestEdit: vi.fn(),
  toSuiteEdit: vi.fn(),
};

const suite: EvalSuite = {
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

function renderTriggersTab() {
  const { container } = render(
    withDataRouter(
      <SuiteIterationsView
        suite={suite}
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
      />,
    ),
  );
  showSettingsGroup(container, "Triggers");
  return container;
}

describe("Triggers tab — Schedule flag", () => {
  beforeEach(() => {
    class FakeIntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    flagState.scheduledEvals = false;
    flagState.syntheticMonitors = false;
  });

  it("renders GitHub Checks alone, with no subsection rail, when the flag is off", () => {
    const container = renderTriggersTab();
    expect(screen.queryByTestId("schedule-row")).toBeNull();
    expect(screen.getByTestId("github-checks-section")).toBeTruthy();
    // One subsection left, so the rail must not render at all.
    expect(
      container.querySelector('[aria-label="Settings subsections"]'),
    ).toBeNull();
  });

  // The flag Schedule USED to answer to. It must no longer bring the row back,
  // or the split has not actually happened.
  it("stays hidden when only synthetic-monitors is on", () => {
    flagState.syntheticMonitors = true;
    const container = renderTriggersTab();
    expect(screen.queryByTestId("schedule-row")).toBeNull();
    expect(
      container.querySelector('[aria-label="Settings subsections"]'),
    ).toBeNull();
  });

  it("renders the Schedule row and the rail when the flag is on", () => {
    flagState.scheduledEvals = true;
    const container = renderTriggersTab();
    expect(screen.getByTestId("schedule-row")).toBeTruthy();
    expect(screen.getByTestId("github-checks-section")).toBeTruthy();
    expect(
      container.querySelector('[aria-label="Settings subsections"]'),
    ).toBeTruthy();
  });
});
