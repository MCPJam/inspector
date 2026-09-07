import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { SettingsRow } from "@/components/setting/SettingsRow";
import { render } from "@testing-library/react";
import { QUALITY_GATE_THRESHOLD_HINT } from "../suite-policy-controls";
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
}));

vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({ state: "unavailable", capabilities: null }),
}));

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

  it("shows the header name editor and every row for the active tab", () => {
    const { container } = renderSettingsSheet();
    expect(
      container.querySelector('[data-setting-key="name"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-setting-key="policy"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-stage-group="selection"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-setting-key="checks"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-setting-key="environments"]'),
    ).toBeNull();
  });

  it("shows the user-value chain under Grading without not measured copy", () => {
    const { container } = renderSettingsSheet({ suite: v2Suite });
    openSettingsRow(container, "judge");
    expect(
      container.querySelector('[data-stage-group="userValue"]'),
    ).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain("not measured");
  });

  it("keeps v2 rows from claiming every case uses the default", () => {
    const { container } = renderSettingsSheet({ suite: v2Suite });
    const policy = container.querySelector('[data-setting-key="policy"]');
    expect(policy?.textContent).toContain(QUALITY_GATE_THRESHOLD_HINT);
    expect(policy?.textContent?.toLowerCase()).not.toContain("every case uses");
  });

  it("marks environments, schedule, github, and delete as immediate writers", () => {
    const { container } = renderSettingsSheet();
    for (const key of ["environments", "schedule", "githubChecks", "deleteSuite"]) {
      openSettingsRow(container, key);
      const row = container.querySelector(`[data-setting-key="${key}"]`);
      expect(row?.textContent, key).toContain("Applies immediately");
    }
  });

  it("opens a row from the harness helper", () => {
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "name");
    expect(screen.getByRole("textbox", { name: "Suite name" })).toBeTruthy();
  });

  it("renders Railway-style section tabs and subsection rail under Grading", () => {
    renderSettingsSheet({ suite: v2Suite });
    const tabs = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(tabs).queryByRole("button", { name: "Name" })).toBeNull();
    expect(within(tabs).getByRole("button", { name: "Grading" })).toBeTruthy();
    const subsections = screen.getByRole("navigation", {
      name: "Settings subsections",
    });
    expect(
      within(subsections).getByRole("button", { name: "Quality gate" }),
    ).toBeTruthy();
    expect(
      within(subsections).getByRole("button", { name: "Scorers" }),
    ).toBeTruthy();
    expect(
      within(subsections).getByRole("button", { name: "Judges" }),
    ).toBeTruthy();
    expect(
      within(subsections).queryByRole("button", { name: /User value/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("tablist", { name: "User value chain" }),
    ).toBeNull();
  });

  it("keeps every grading stage in the scrollable column and scrolls on rail click", () => {
    const { container } = renderSettingsSheet({ suite: v2Suite });
    expect(
      container.querySelector('[data-stage-group="selection"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-stage-group="response"]'),
    ).toBeTruthy();
    const subsections = screen.getByRole("navigation", {
      name: "Settings subsections",
    });
    const scrollIntoView = vi.fn();
    const checksAnchor = container.querySelector('[data-setting-key="checks"]');
    expect(checksAnchor).toBeTruthy();
    checksAnchor!.scrollIntoView = scrollIntoView;
    fireEvent.click(
      within(subsections).getByRole("button", { name: "Scorers" }),
    );
    expect(scrollIntoView).toHaveBeenCalled();
    for (const button of within(subsections).getAllByRole("button")) {
      expect(button).not.toHaveAttribute("aria-current");
    }
  });

  it("titles the Where-it-runs row for the axes it can edit", () => {
    // Capable: cells, so the row is Environments. Not capable: the legacy
    // client axis, and calling that "Environments" names something the person
    // can neither see nor use.
    const capable = renderSettingsSheet();
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      ).getByRole("button", { name: "Where it runs" }),
    );
    expect(
      capable.container.querySelector('[data-setting-key="environments"]')
        ?.textContent,
    ).toContain("Environments");
    capable.unmount();

    composeCapability.value = false;
    const legacy = renderSettingsSheet();
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      ).getByRole("button", { name: "Where it runs" }),
    );
    expect(
      legacy.container.querySelector('[data-setting-key="environments"]')
        ?.textContent,
    ).toContain("Clients");
  });

  it("shows both Where-it-runs rows together, environments first, with no rail", () => {
    const { container } = renderSettingsSheet();
    const tabs = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(tabs).getByRole("button", { name: "Where it runs" }));
    const keys = [...container.querySelectorAll("[data-setting-key]")].map(
      (node) => node.getAttribute("data-setting-key"),
    );
    expect(keys.indexOf("environments")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("computerEnvironment")).toBeGreaterThan(
      keys.indexOf("environments"),
    );
    expect(
      container.querySelector('[data-testid="suite-environment-bar"]'),
    ).toBeTruthy();
    expect(
      screen.queryByRole("navigation", { name: "Settings subsections" }),
    ).toBeNull();
  });

});
