import { describe, expect, it, vi } from "vitest";
import {
  renderSettingsSheet,
  showSettingsKey,
  v2Suite,
} from "./settings-sheet-harness";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";

/**
 * WHAT THE SETTINGS PAGE MOUNTS.
 *
 * Every other settings ratchet renders a COMPONENT and asserts its rows. None
 * of them asserted what the PAGE mounts — which is how the scorer table, the
 * judge card, the rubric editor, the gate panel, the backtest, verdict
 * validity, the v1→v2 upgrade and the computer image all left the page in one
 * PR without a single test going red. Their own suites kept passing, in
 * isolation, guarding components no user could reach.
 *
 * So this file asserts reachability and nothing else. It is deliberately dumb:
 * if a control that edits a live backend field is removed from the page, this
 * fails, and whoever removed it has to say so out loud by deleting a named
 * expectation rather than by silently dropping a mount.
 *
 * Adding a row here is cheap. Removing one should not be.
 */

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/use-suite-capabilities")
  >();
  return {
    ...actual,
    // "unavailable" is the honest default for a mount test: it is what a
    // deployment that predates the capabilities query answers, and every row
    // below must be reachable there too.
    useSuiteCapabilities: () => ({ state: "unavailable", capabilities: null }),
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn() }),
}));
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
  useModelMatrixCapability: () => true,
}));
vi.mock("@/components/environment-composer/use-eval-compose-capable", () => ({
  useEvalComposeCapable: () => ({ capable: true, pending: false }),
}));
vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({ runTrendData: [], modelStats: [] }),
  useRunDetailData: () => ({ caseGroupsForSelectedRun: [] }),
}));
vi.mock("../suite-header", () => ({
  SuiteHeader: () => <div data-testid="suite-header" />,
}));
vi.mock("@/components/evals/suite-clients-settings", () => ({
  SuiteClientsSettings: () => (
    <div data-testid="suite-clients-table">Client table</div>
  ),
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

describe("the suite settings page mounts its editors", () => {
  /**
   * Each entry: the control, and the field it edits. The field is the reason
   * the row has to be here — every one of them still reaches the backend and
   * still changes what a run does, so a page without the control leaves it
   * writable only through the API.
   */
  const REQUIRED_ROWS: readonly {
    key: string;
    edits: string;
  }[] = [
    { key: "policy", edits: "verdictPolicyDefaults / defaultPassCriteria" },
    { key: "passOrFail", edits: "the scorers, the matcher and the judge" },
    { key: "checks", edits: "defaultPredicates" },
    { key: "matchOptions", edits: "defaultMatchOptions" },
    { key: "judge", edits: "judgeConfig" },
    { key: "judgeRubric", edits: "judgeRubric" },
    { key: "validity", edits: "verdictPolicyDefaults.validity" },
    { key: "qualityGateBaseline", edits: "gatePolicy.baseline" },
  ];

  it("renders every control that edits a live suite field", () => {
    const { container } = renderSettingsSheet({ suite: v2Suite });
    const missing = REQUIRED_ROWS.filter(({ key }) => {
      showSettingsKey(container, key as EvalSuiteSettingKey, {}, v2Suite);
      return !container.querySelector(`[data-setting-key="${key}"]`);
    }).map(({ key, edits }) => `${key} (edits ${edits})`);
    expect(
      missing,
      `Settings controls that are no longer mounted. Each still writes to the backend, so removing the control does not remove the setting — it only removes the way to see and change it:\n  ${missing.join(
        "\n  ",
      )}`,
    ).toEqual([]);
  });

  it("renders the judge card, so the judge is configurable at all", () => {
    // The sharpest instance of the general failure: `SuiteJudgeCard` mounts
    // ONLY inside the scorer table, so unmounting one section took the judge's
    // model, threshold, auto-run, gating role and rubric with it — the entire
    // visible half of the judge program — while `judgeConfig` kept deciding
    // whether runs passed.
    const { container } = renderSettingsSheet({ suite: v2Suite });
    showSettingsKey(container, "judge", {}, v2Suite);
    expect(
      container.querySelector(
        '[data-testid="suite-judge-card-goalCompletion"]',
      ),
    ).toBeTruthy();
  });

  it("groups the scorers by the six user-value stages", () => {
    const { container } = renderSettingsSheet({ suite: v2Suite });
    showSettingsKey(container, "checks", {}, v2Suite);
    expect(container.querySelectorAll("[data-stage-group]")).toHaveLength(6);
  });
});
