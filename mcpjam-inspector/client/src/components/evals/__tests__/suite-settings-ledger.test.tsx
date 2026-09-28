import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { SettingsRow } from "@/components/setting/SettingsRow";
import { render } from "@testing-library/react";
import { PASS_THRESHOLD_HINT } from "../suite-policy-controls";
import {
  openSettingsRow,
  renderSettingsSheet,
  v2Suite,
} from "./settings-sheet-harness";

const composeCapability = vi.hoisted(() => ({
  value: true as boolean | undefined,
}));

const mocks = vi.hoisted(() => ({
  applySuiteSettings: vi.fn(async () => ({ revisionNumber: 4 })),
  updateTestSuite: vi.fn(async () => ({})),
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
  useModelMatrixCapability: () => composeCapability.value,
}));
// The Where-it-runs row follows the backend CAPABILITY (can this deployment
// compose client x model cells), not the named-environments flag above.
vi.mock("@/components/environment-composer/use-eval-compose-capable", () => ({
  useEvalComposeCapable: () => ({
    capable: composeCapability.value === true,
    pending: composeCapability.value === undefined,
  }),
}));
vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({ runTrendData: [], modelStats: [] }),
  useSuiteDataFromMetrics: () => ({ runTrendData: [], modelStats: [] }),
  useRunDetailData: () => ({ caseGroupsForSelectedRun: [] }),
}));
vi.mock("../suite-header", () => ({
  SuiteHeader: () => (
    <div data-testid="suite-header">
      <div data-setting-key="name">
        <span className="sr-only">Name</span>
        <button type="button">Test Suite</button>
        <input aria-label="Suite name" />
      </div>
    </div>
  ),
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

describe("the general Settings tab is unchanged", () => {
  it("SettingsRow is still the static label|value form", () => {
    const { container } = render(
      <SettingsRow label="Version" value="v1.2.3" />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-state]")).toBeNull();
    expect(container.querySelector("[data-setting-key]")).toBeNull();
    expect(container.firstElementChild?.className).toContain(
      "flex items-center justify-between",
    );
    expect(container.textContent).toContain("Version");
    expect(container.textContent).toContain("v1.2.3");
  });
});

describe("suite settings ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    composeCapability.value = true;
  });

  it("shows the header name editor and every visible section on one page", () => {
    const { container } = renderSettingsSheet();
    expect(container.querySelector('[data-setting-key="name"]')).toBeTruthy();
    expect(
      container.querySelector('[data-setting-key="deleteSuite"]'),
    ).toBeNull();
    expect(
      container.querySelector('nav[aria-label="Settings sections"]'),
    ).toBeNull();
    expect(container.querySelector('[data-setting-key="schedule"]')).toBeNull();
    expect(
      container.querySelector('[data-setting-key="githubChecks"]'),
    ).toBeNull();
    expect(container.querySelector('[data-setting-key="policy"]')).toBeTruthy();
    expect(
      container.querySelector('[data-stage-group="selection"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-setting-key="checks"]')).toBeTruthy();
    expect(
      container.querySelector('[data-setting-key="environments"]'),
    ).toBeTruthy();
  });

  it("shows the user-value chain under Grading without not measured copy", () => {
    const { container } = renderSettingsSheet({ suite: v2Suite });
    expect(
      container.querySelector('[data-stage-group="userValue"]'),
    ).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain("not measured");
  });

  it("keeps the per-case criterion row from claiming every case uses the default", () => {
    const { container } = renderSettingsSheet({ suite: v2Suite });
    const policy = container.querySelector('[data-setting-key="policy"]');
    expect(policy?.textContent).toContain(PASS_THRESHOLD_HINT);
    expect(policy?.textContent?.toLowerCase()).not.toContain("every case uses");
  });

  it("splits the grading rows so each names one question", () => {
    // One row titled "Quality gate" used to hold the criterion, the count and
    // the gate. A reader looking for the threshold their runs are decided
    // against had to open a heading about regressions to find it.
    const { container } = renderSettingsSheet({ suite: v2Suite });
    for (const [key, heading] of [
      ["policy", "Pass criteria"],
      ["iterations", "Iterations"],
      ["qualityGate", "Quality gate"],
    ] as const) {
      const row = container.querySelector(`[data-setting-key="${key}"]`);
      expect(row, key).toBeTruthy();
      expect(row?.textContent, key).toContain(heading);
    }
  });

  it("offers no scope switch beside the threshold", () => {
    // The switch re-decides every multi-case suite: its own proposal divided
    // the stored percent by 100, which moves the bar even though the number
    // looks preserved. Changing it takes a hand-written PATCH rather than any
    // affordance this app ships — and no copy on this page names a policy
    // version.
    const { container } = renderSettingsSheet({ suite: v2Suite });
    const text = container.textContent?.toLowerCase() ?? "";
    expect(text).not.toContain("verdict policy v2");
    expect(text).not.toContain("switch to verdict policy");
    expect(text).not.toContain("upgrade");
  });

  it("omits the immediate-save badge for environments", () => {
    const { container } = renderSettingsSheet();
    for (const key of ["environments"]) {
      openSettingsRow(container, key);
      const row = container.querySelector(`[data-setting-key="${key}"]`);
      expect(row?.textContent, key).not.toContain("Applies immediately");
    }
  });

  it("opens a row from the harness helper", () => {
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "name");
    expect(screen.getByRole("textbox", { name: "Suite name" })).toBeTruthy();
  });

  it("shows the scorers table, grouped by stage, with its editors", () => {
    // WAS "shows a stage-first table without a duplicate flow or grading rail",
    // which pinned a checkbox list whose 21 rows named checks the product does
    // not run and whose save the backend refused. The stage GROUPING was the
    // good half of that design and is kept — the scorer table has always
    // grouped by the same six stages — but each group now lists the graders
    // that actually run, and the judge, rubric and matcher editors are on the
    // page again rather than asserted absent.
    const { container } = renderSettingsSheet({ suite: v2Suite });
    expect(
      screen.getByRole("heading", { name: "Evaluators" }),
    ).toBeTruthy();
    expect(container.querySelectorAll("[data-stage-group]")).toHaveLength(6);
    expect(
      screen.queryByRole("tablist", { name: "User value chain" }),
    ).toBeNull();
    for (const key of ["judge", "judgeRubric", "matchOptions", "validity"]) {
      expect(
        container.querySelector(`[data-setting-key="${key}"]`),
        key,
      ).toBeTruthy();
    }
  });

  it("titles the Where-it-runs row for the axes it can edit", () => {
    // Legacy deployments keep their client-only label.
    const capable = renderSettingsSheet();
    expect(
      capable.container.querySelector('[data-setting-key="environments"]')
        ?.textContent,
    ).toContain("Where it runs");
    capable.unmount();

    composeCapability.value = false;
    const legacy = renderSettingsSheet();
    expect(
      legacy.container.querySelector('[data-setting-key="environments"]')
        ?.textContent,
    ).toContain("Clients");
  });

  it("shows the client table beside the computer image row", () => {
    const { container } = renderSettingsSheet();
    const keys = [...container.querySelectorAll("[data-setting-key]")].map(
      (node) => node.getAttribute("data-setting-key"),
    );
    expect(keys.indexOf("environments")).toBeGreaterThanOrEqual(0);
    // With capabilities READY the image row is visible for any project suite —
    // it edits `computerEnvironmentId`, which decides the image every trial
    // boots. The flag only gates the fallback path, covered by the
    // capabilities-unavailable case in the manifest ratchet.
    expect(keys).toContain("computerEnvironment");
    expect(
      container.querySelector('[data-testid="suite-clients-table"]'),
    ).toBeTruthy();
    expect(
      screen.queryByRole("navigation", { name: "Settings subsections" }),
    ).toBeNull();
  });
});
