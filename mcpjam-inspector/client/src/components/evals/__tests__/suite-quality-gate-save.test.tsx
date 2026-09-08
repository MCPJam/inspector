import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  baseSuite,
  noopNav,
  openSettingsRow,
  renderSettingsSheet,
  withDataRouter,
} from "./settings-sheet-harness";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";
import { QUALITY_GATE_REASON_HINT } from "../suite-quality-gate-section";

const mocks = vi.hoisted(() => ({
  applySuiteSettings: vi.fn(async () => ({ revisionNumber: 4 })),
  updateTestSuite: vi.fn(async () => ({})),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  capabilities: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: string) =>
    name === "testSuites:applySuiteSettings"
      ? mocks.applySuiteSettings
      : mocks.updateTestSuite,
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-suite-capabilities")>();
  return {
    ...actual,
    useSuiteCapabilities: () => mocks.capabilities(),
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
}));
vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({ runTrendData: [], modelStats: [] }),
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

function readyCapabilities() {
  return {
    state: "ready" as const,
    capabilities: {
      suiteId: "suite-1",
      organizationId: "org-1",
      permissions: {
        "suite.view": true,
        "suite.edit": true,
        "suite.configure": true,
        "suite.delete": true,
        "suite.schedule": true,
        "suite.environments": true,
        "run.launch": true,
        "gate.waive": true,
        "judge.review": true,
        "baseline.set": true,
      },
      features: {
        computers: { enabled: true },
        scheduledEvals: { enabled: true },
      },
      verdictPolicyV2: {
        deploymentMode: "enforce",
        suiteMode: null,
        canUpgrade: true,
      },
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
      qualityGate: { storage: true, evaluator: true },
      revisionNumber: 1,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilities.mockReturnValue(readyCapabilities());
});

function saveButton() {
  return screen.getByRole("button", { name: "Save settings" });
}

describe("quality-gate direct save", () => {
  it("saves in one click with an automatic revision note", async () => {
    const user = userEvent.setup();
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "qualityGateBaseline");
    await user.selectOptions(
      screen.getByLabelText("Quality gate baseline"),
      "run",
    );
    await user.type(screen.getByLabelText("Baseline run id"), "run-1");
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    expect(
      screen.queryByLabelText("Why you are making this change"),
    ).toBeNull();
    await waitFor(() =>
      expect(mocks.applySuiteSettings).toHaveBeenCalledTimes(1),
    );
    const args = mocks.applySuiteSettings.mock.calls[0][0] as {
      gatePolicy: unknown;
      revision: { note?: string; source: string };
    };
    expect(args.gatePolicy).toMatchObject({
      baseline: { kind: "run", runId: "run-1" },
    });
    expect(args.revision.source).toBe("ui");
    expect(args.revision.note).toMatch(/^Updated suite settings: .+\.$/);
  });

  it("keeps the unsaved policy after a revision conflict", async () => {
    mocks.applySuiteSettings.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), {
        data: { code: "EVAL_SUITE_REVISION_CONFLICT", current: 7 },
      }),
    );
    const user = userEvent.setup();
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "qualityGateBaseline");
    await user.selectOptions(
      screen.getByLabelText("Quality gate baseline"),
      "run",
    );
    await user.type(screen.getByLabelText("Baseline run id"), "run-1");
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.getByTestId("suite-settings-commit-bar")).toBeTruthy();
    expect(saveButton()).toBeEnabled();
    expect(mocks.updateTestSuite).not.toHaveBeenCalled();
  });
});

/**
 * A REVIEW DIALOG MUST NOT OUTLIVE THE SUITE OR THE LOCK IT WAS OPENED UNDER.
 *
 * `SuiteIterationsView` stays mounted across suite switches — no `key` at any
 * of its three call sites — so `reviewOpen` is state that survives a change of
 * suite, and the settings draft is rebased onto whatever arrives.
 *
 * Withholding the dialog from render while `editingDisabled` hid it without
 * closing it: on the next unlocked suite the gate passed again and the dialog
 * came back, over that suite's changes, asking someone to confirm a save they
 * never started. Hiding is not closing.
 */
function SwitchableSheet({ suites }: { suites: EvalSuite[] }) {
  const [index, setIndex] = useState(0);
  return (
    <>
      <button data-testid="advance" onClick={() => setIndex((i) => i + 1)}>
        advance
      </button>
      <SuiteIterationsView
        suite={suites[index]}
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
        route={{ type: "suite-edit", suiteId: suites[index]._id }}
        navigation={noopNav}
      />
    </>
  );
}

// SKIPPED: the Evaluate settings sheet saves from the commit bar directly and
// no longer opens a review dialog, so there is nothing here to outlive the
// suite. The lock still hides the commit bar (see suite-settings-sheet tests).
describe.skip("the review dialog does not outlive its suite", () => {
  it("closes when the suite locks, and stays closed on the next suite", async () => {
    const user = userEvent.setup();
    const unlocked = { ...baseSuite, _id: "suite-1" };
    // Same id: the lock ARRIVING on the suite being edited, which is a CI run
    // stamping the row underneath an open review.
    const locked = { ...unlocked, source: "sdk" as const };
    const other = { ...baseSuite, _id: "suite-2", name: "Another Suite" };

    const { container } = render(
      withDataRouter(<SwitchableSheet suites={[unlocked, locked, other]} />),
    );

    // The simplified sheet exposes only the baseline; dirty the draft there.
    openSettingsRow(container, "qualityGateBaseline");
    await user.selectOptions(
      screen.getByLabelText("Quality gate baseline"),
      "run",
    );
    await user.type(screen.getByLabelText("Baseline run id"), "run-1");
    fireEvent.click(reviewOpener());
    expect(screen.getByRole("dialog")).toBeTruthy();

    // The lock arrives on the suite being reviewed.
    fireEvent.click(screen.getByTestId("advance"));
    expect(screen.queryByRole("dialog")).toBeNull();

    // And moving on to an unlocked suite must not resurrect it. This is the
    // half a render-time gate alone gets wrong: `reviewOpen` would still be
    // true, and `!editingDisabled` is true again here.
    fireEvent.click(screen.getByTestId("advance"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * ABSENCE IS NOT AN ASSERTION ABOUT THE SUITE.
 *
 * Guarding `verdictPolicyV2` with `?.` stopped the crash but left the reason
 * copy falling through to "This suite is already on verdict policy v2" — a
 * claim about the SUITE, made on the word of a deployment that never reported
 * a mode. A missing block means the deployment does not offer the upgrade,
 * which is what `DEPLOYMENT_REASON_COPY` already says, and is the same rule
 * applied to a missing `ownership` block elsewhere in this change.
 */
// SKIPPED: the Evaluate settings sheet no longer renders the verdict policy
// upgrade control (`VerdictPolicyUpgradeButton`) or its disabled reason, so
// there is no copy here for this case to read. Re-enable when the upgrade
// affordance returns to the sheet.
describe.skip("a capabilities answer with no verdictPolicyV2", () => {
  it("says the deployment does not offer it, not that the suite is already on it", () => {
    const withoutPolicy = readyCapabilities();
    delete (withoutPolicy.capabilities as Record<string, unknown>)
      .verdictPolicyV2;
    mocks.capabilities.mockReturnValue(withoutPolicy);

    const { container } = renderSettingsSheet();
    openSettingsRow(container, "minimumIterations");

    expect(
      screen.queryByText(/already on verdict policy v2/i),
    ).toBeNull();
    expect(container.textContent).toContain("Not available on this deployment");
  });
});
