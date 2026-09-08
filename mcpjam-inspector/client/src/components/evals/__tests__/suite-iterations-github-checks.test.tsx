import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withDataRouter,
} from "./settings-sheet-harness";
import { render, screen } from "@testing-library/react";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";

/** Simplified suite settings omit organization-wide GitHub Checks controls. */

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
  useGithubChecksSettings: () => ({
    availability: { state: "enabled" },
    repos: [],
  }),
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
vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/use-suite-capabilities")
  >();
  return {
    ...actual,
    useSuiteCapabilities: () => ({
      state: "unavailable",
      capabilities: null,
    }),
  };
});

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
    class FakeIntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
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

  it.each(["enabled", "disabled", "throws"])(
    "keeps organization GitHub controls off the simplified page (%s)",
    (availability) => {
      mocks.availability.mockImplementation(() => {
        if (availability === "throws") throw new Error("Not a member");
        return { state: availability };
      });
      const { container } = renderSettingsSheet();
      expect(screen.queryByRole("button", { name: "Triggers" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("github-checks-section")).not.toBeInTheDocument();
      expect(container.querySelector('[data-setting-key="githubChecks"]')).toBeNull();
      expect(mocks.availability).not.toHaveBeenCalled();
      expect(mocks.reportBoundaryError).not.toHaveBeenCalled();
    },
  );
});
