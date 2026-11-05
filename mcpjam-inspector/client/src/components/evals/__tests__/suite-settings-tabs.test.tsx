import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { setAppRouter } from "@/router-ref";
import { SuiteIterationsView } from "../suite-iterations-view";
import { EvalHeaderActionsSlot } from "../../evaluate/nav/eval-header-actions";
import type { EvalCase } from "../types";
import { baseSuite, noopNav } from "./settings-sheet-harness";

/**
 * Suite settings as three tabs (`evaluate-nav-enabled`). The sheet's own rows
 * are covered by `suite-settings-sheet.test.tsx`; these pin what the tabs add:
 * which rows each tab shows, one draft across Settings and Default
 * evaluators, Save only where it applies, and the flag-off sheet unchanged.
 */

const mocks = vi.hoisted(() => ({
  navFlag: true as boolean | undefined,
  track: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "evaluate-nav-enabled" ? mocks.navFlag : true,
}));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: async () => null }),
  useMutation: () => vi.fn(async () => ({})),
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQueries: () => ({}),
}));
vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-suite-capabilities")>()),
  useSuiteCapabilities: () => ({ state: "unavailable", capabilities: null }),
}));
vi.mock("@/components/billing/SharedSettingsGate", () => ({
  SharedSettingsGate: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));
vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => null,
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn() }),
}));
vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksAvailability: () => ({ state: "disabled" }),
  useGithubChecksSettings: () => ({
    availability: { state: "disabled" },
    repos: [],
  }),
}));
vi.mock("../suite-github-checks-section", () => ({
  SuiteGithubChecksSection: () => null,
}));
vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError: vi.fn() }));
vi.mock("@/hooks/useProjectComputer", () => ({
  useEphemeralCloudAvailable: () => true,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => true,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
  useEnsureAdhocEnvironments: () => vi.fn(),
  useModelMatrixCapability: () => false,
}));
vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({ runTrendData: [], modelStats: [] }),
  useSuiteDataFromMetrics: () => ({ runTrendData: [], modelStats: [] }),
  useRunDetailData: () => ({ caseGroupsForSelectedRun: [] }),
}));
vi.mock("../eval-export-modal", () => ({ EvalExportModal: () => null }));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => null,
}));

const CASES = [
  { _id: "case-1", title: "Draw a rectangle" },
  { _id: "case-2", title: "Sketch a two-node flow" },
] as EvalCase[];

const SETTINGS = "/evaluate/suite/suite-1/settings";

function renderAt(path: string) {
  const view = (
    <div>
      <div className="relative">
        <EvalHeaderActionsSlot />
      </div>
      <SuiteIterationsView
        suite={baseSuite}
        cases={CASES}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        onDeleteTestCasesBatch={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        organizationId="org-1"
        projectId="project-1"
        // What the page map hands today's screen for these addresses.
        route={
          path.endsWith("/cases")
            ? { type: "suite-overview", suiteId: "suite-1", view: "test-cases" }
            : { type: "suite-edit", suiteId: "suite-1" }
        }
        navigation={noopNav}
        hideRunActions
        suiteDetailOverview
      />
    </div>
  );
  const router = createMemoryRouter([{ path: "*", element: view }], {
    initialEntries: [path],
  });
  setAppRouter(router as never);
  render(<RouterProvider router={router} />);
  return router;
}

const headerActions = () => screen.getByTestId("eval-header-actions");
const sheet = () =>
  document.querySelector("fieldset") as HTMLFieldSetElement | null;

function editName(value: string) {
  const button = document.querySelector(
    '[data-setting-key="name"] button',
  ) as HTMLButtonElement;
  fireEvent.click(button);
  fireEvent.change(screen.getByLabelText("Suite name"), { target: { value } });
}

beforeEach(() => {
  mocks.navFlag = true;
  vi.clearAllMocks();
});
afterEach(() => setAppRouter(null));

describe("Suite settings tabs", () => {
  it("shows the Settings rows and hides Default evaluators on Settings", () => {
    renderAt(SETTINGS);
    expect(
      screen
        .getByTestId("suite-settings-tab-settings")
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(sheet()?.className).toContain(
      "[&>[data-setting-key=passOrFail]]:hidden",
    );
    expect(screen.getByTestId("suite-settings-tab-cases").textContent).toBe(
      "Test cases2",
    );
  });

  it("shows only Default evaluators on its tab", () => {
    renderAt(`${SETTINGS}/evaluators`);
    expect(sheet()?.className).toContain(
      "[&>:not([data-setting-key=passOrFail])]:hidden",
    );
  });

  it("puts Save settings and Back to suite in the breadcrumb bar", () => {
    renderAt(SETTINGS);
    const actions = within(headerActions());
    expect(actions.getByRole("button", { name: "Save settings" })).toBeTruthy();
    fireEvent.click(actions.getByRole("button", { name: "Back to suite" }));
    expect(noopNav.toSuiteOverview).toHaveBeenCalledWith("suite-1");
  });

  it("keeps one draft across Settings and Default evaluators", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const router = renderAt(SETTINGS);
    editName("Renamed");
    expect(
      within(headerActions()).queryByTestId("suite-settings-commit-bar"),
    ).not.toBeNull();

    fireEvent.click(screen.getByTestId("suite-settings-tab-evaluators"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`${SETTINGS}/evaluators`),
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(
      within(headerActions()).queryByTestId("suite-settings-commit-bar")
        ?.textContent,
    ).toContain("1 unsaved change");
  });

  it("lists the cases with no Save on Test cases", () => {
    renderAt(`${SETTINGS}/cases`);
    expect(screen.getByText("Draw a rectangle")).toBeTruthy();
    expect(sheet()?.hidden).toBe(true);
    const actions = within(headerActions());
    expect(actions.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(actions.getByRole("button", { name: "Back to suite" })).toBeTruthy();
  });

  it("opens a case at its settings address", async () => {
    const router = renderAt(`${SETTINGS}/cases`);
    fireEvent.click(screen.getByTestId("suite-settings-case-case-1"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`${SETTINGS}/cases/case-1`),
    );
  });

  it("reports the page view with its tab", () => {
    renderAt(`${SETTINGS}/evaluators`);
    expect(mocks.track).toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({ page: "suite-settings", tab: "evaluators" }),
    );
  });

  it("waits for the flag instead of flashing the old sheet", () => {
    mocks.navFlag = undefined;
    renderAt(SETTINGS);
    expect(screen.getByText("Loading suite settings...")).toBeTruthy();
    expect(sheet()).toBeNull();
  });

  it("renders today's sheet with the flag off", () => {
    mocks.navFlag = false;
    renderAt(SETTINGS);
    expect(screen.queryByTestId("suite-settings-tab-settings")).toBeNull();
    expect(sheet()?.className).toBe("m-0 min-w-0 space-y-8 border-0 p-0");
    expect(headerActions().childElementCount).toBe(0);
    expect(screen.getByRole("button", { name: "Back to suite" })).toBeTruthy();
    expect(mocks.track).not.toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.anything(),
    );
  });
});
