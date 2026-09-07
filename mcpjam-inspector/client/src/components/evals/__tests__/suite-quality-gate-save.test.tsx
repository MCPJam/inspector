import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  openSettingsRow,
  renderSettingsSheet,
} from "./settings-sheet-harness";
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

vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => mocks.capabilities(),
}));

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

function reviewOpener() {
  return screen.getByRole("button", { name: "Review and save" });
}

describe("quality-gate review requires a reason without a deadlock", () => {
  it("opens Review and save before a reason exists, and only final Save waits", async () => {
    const user = userEvent.setup();
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "qualityGateNoGatingScoreErrors");
    await user.click(
      screen.getByRole("switch", { name: "Any gating scorer errored" }),
    );

    expect(reviewOpener()).toBeEnabled();
    fireEvent.click(reviewOpener());
    expect(screen.getByText(QUALITY_GATE_REASON_HINT)).toBeTruthy();
    expect(saveButton()).toBeDisabled();

    await user.type(
      screen.getByLabelText("Why you are making this change"),
      "Tighten the release bar.",
    );
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.applySuiteSettings).toHaveBeenCalled());
    const args = mocks.applySuiteSettings.mock.calls[0][0] as {
      gatePolicy: unknown;
      revision: { note?: string };
    };
    expect(args.gatePolicy).toEqual({ noGatingScoreErrors: true });
    expect(args.revision.note).toBe("Tighten the release bar.");
  });

  it("refuses a cleared reason, then still allows entry after close and reopen", async () => {
    const user = userEvent.setup();
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "qualityGateNoGatingScoreErrors");
    await user.click(
      screen.getByRole("switch", { name: "Any gating scorer errored" }),
    );
    fireEvent.click(reviewOpener());
    const note = screen.getByLabelText("Why you are making this change");
    await user.type(note, "A reason");
    expect(saveButton()).toBeEnabled();
    await user.clear(note);
    expect(saveButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByLabelText("Why you are making this change")).toBeNull();
    expect(reviewOpener()).toBeEnabled();
    fireEvent.click(reviewOpener());
    expect(
      (screen.getByLabelText("Why you are making this change") as HTMLTextAreaElement)
        .value,
    ).toBe("");
    expect(saveButton()).toBeDisabled();
    await user.type(
      screen.getByLabelText("Why you are making this change"),
      "Re-entered after close.",
    );
    expect(saveButton()).toBeEnabled();
  });

  it("keeps the unsaved policy after a revision conflict", async () => {
    mocks.applySuiteSettings.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), {
        data: { code: "EVAL_SUITE_REVISION_CONFLICT", current: 7 },
      }),
    );
    const user = userEvent.setup();
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "qualityGateNoGatingScoreErrors");
    await user.click(
      screen.getByRole("switch", { name: "Any gating scorer errored" }),
    );
    fireEvent.click(reviewOpener());
    await user.type(
      screen.getByLabelText("Why you are making this change"),
      "Try to save.",
    );
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.getByTestId("suite-settings-commit-bar")).toBeTruthy();
    expect(reviewOpener()).toBeEnabled();
    expect(mocks.updateTestSuite).not.toHaveBeenCalled();
  });
});
