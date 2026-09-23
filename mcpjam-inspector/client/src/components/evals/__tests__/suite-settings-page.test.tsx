import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  ciOwnedSuite,
  openSettingsRow,
  renderSettingsSheet,
  noopNav,
} from "./settings-sheet-harness";

/**
 * The settings sheet as a DRAFT (S1).
 *
 * The behaviour these pin is the difference between the sheet before and
 * after: nothing is written until the person says so, and when they do it is
 * one write carrying exactly what they changed.
 *
 * The failure modes worth a test are the ones a person would report as
 * "it saved something I didn't mean to":
 *
 *   - a control that still writes on change,
 *   - a save that sends fields the person never touched,
 *   - a conflict that silently discards their edits,
 *   - and a read-only suite that offers a save it cannot perform.
 */

const capability = vi.hoisted(() => ({ canUpgrade: false }));

const mocks = vi.hoisted(() => ({
  applySuiteSettings: vi.fn(async () => ({ revisionNumber: 4 })),
  updateTestSuite: vi.fn(async () => ({})),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: string) =>
    name === "testSuites:applySuiteSettings"
      ? mocks.applySuiteSettings
      : mocks.updateTestSuite,
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  // Per-run row loads (Evaluate only); legacy suite views request none.
  useQueries: () => ({}),
}));

// S3 — the settings sheet reads per-suite capabilities. `unavailable` is the
// pre-capabilities behaviour, which is what every assertion in this file was
// written against; a real read here would also need `useConvex` on the mock
// above, which this file deliberately does not provide.
vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-suite-capabilities")>();
  return {
    ...actual,
    useSuiteCapabilities: () => ({
      state: capability.canUpgrade ? "ready" : "unavailable",
      capabilities: capability.canUpgrade
        ? {
            verdictPolicyV2: { canUpgrade: true, deploymentMode: "enforce" },
            permissions: {},
            features: {},
            judge: {
              gating: { enabled: false, reason: "not_enabled_on_deployment" },
              role: "advisory",
              hasRubric: false,
              agreement: {
                reviews: 0,
                agreements: 0,
                rate: null,
                lowerBound: null,
                threshold: 0.8,
                minReviews: 20,
                eligible: false,
                reasons: ["insufficient_reviews"],
              },
              acknowledgement: null,
            },
            revisionNumber: 1,
          }
        : null,
    }),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
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
  SuiteGithubChecksSection: () => <div data-testid="github-checks-section" />,
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
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => true }));
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
vi.mock("@mcpjam/design-system/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  capability.canUpgrade = false;
});

describe("suite settings page", () => {
  it("shows the three sections in order without tabs and a disabled clean Save", () => {
    const { container } = renderSettingsSheet();
    expect(
      container.querySelector('nav[aria-label="Settings sections"]'),
    ).toBeNull();
    const sections = ["policy", "environments", "passOrFail"].map((key) =>
      container.querySelector(`[data-setting-key="${key}"]`)!,
    );
    expect(sections.every(Boolean)).toBe(true);
    expect(
      sections[0].compareDocumentPosition(sections[1]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      sections[1].compareDocumentPosition(sections[2]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save settings" }),
    ).toBeDisabled();
    expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to suite" }));
    expect(noopNav.toSuiteOverview).toHaveBeenCalledWith("suite-1");
  });

  it("puts dirty Save and Discard in the header and persists a name edit", async () => {
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "name");
    fireEvent.change(screen.getByRole("textbox", { name: "Suite name" }), {
      target: { value: "Renamed suite" },
    });
    const bar = screen.getByTestId("suite-settings-commit-bar");
    expect(bar.closest("fieldset")).toBeNull();
    const name = container.querySelector('[data-setting-key="name"]')!;
    expect(name.parentElement?.contains(bar)).toBe(true);
    expect(
      screen.getAllByRole("button", { name: "Save settings" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.applySuiteSettings).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull(),
    );
  });

  it("offers no scope switch, whatever the deployment allows", () => {
    // #5088 asserted the opposite half of this: that an ALLOWED upgrade
    // renders an enabled "Switch to verdict policy v2" button. That affordance
    // is deliberately gone, so the assertion is inverted rather than dropped —
    // the deployment still reports that capability and the server still
    // enforces it, but no client surface consults it now: there is no
    // scope-switch operation anywhere in the app, the CLI or MCP. Changing
    // scope takes a hand-written PATCH.
    //
    // Why it had to go: the button's own proposal divided the stored percent by
    // 100. That preserves the NUMBER and moves the BAR for every suite with
    // more than one case, because a suite-wide percent and a per-case fraction
    // are measured over different populations. It also wrote its two draft
    // fields into the ordinary batched settings save, so it rode along with
    // unrelated edits and required an audit note only when the quality gate
    // happened to be dirty in the same batch.
    //
    // Asserted under BOTH capability answers, which is stronger than the
    // original: there is no wording under which this page proposes a scope
    // change, not merely none when the deployment forbids it.
    const unavailable = renderSettingsSheet();
    expect(screen.queryByText("Switch to verdict policy v2")).toBeNull();
    unavailable.unmount();
    capability.canUpgrade = true;
    renderSettingsSheet();
    expect(screen.queryByText("Advanced")).toBeNull();
    expect(screen.queryByText("Switch to verdict policy v2")).toBeNull();
    expect(screen.queryByText(/already on verdict policy v2/i)).toBeNull();
  });

  it("keeps CI-owned settings readable with Back and no Save", () => {
    renderSettingsSheet({ suite: ciOwnedSuite });
    expect(screen.getByTestId("suite-settings-locked")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back to suite" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  });
});
