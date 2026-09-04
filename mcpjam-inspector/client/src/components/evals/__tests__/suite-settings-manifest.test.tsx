import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_SUITE_SETTINGS_MANIFEST,
  EVAL_SUITE_SETTING_KEYS,
} from "@/shared/eval-suite-settings-manifest";
import { renderSettingsSheet, v2Suite } from "./settings-sheet-harness";

/**
 * The RENDER half of the settings-parity ratchet.
 *
 * The manifest declares how every settings row is reachable from the SDK / CLI
 * / MCP. `SettingsSection` takes a manifest key and stamps `data-setting-key`,
 * so an unlisted row does not typecheck — but a type error can be cast away,
 * and the delete row is stamped by hand rather than through the component.
 * This test closes both gaps by reading what actually rendered.
 *
 * Its companion (`server/routes/v1/__tests__/eval-suite-settings-parity.test.ts`)
 * checks the other direction: that each entry's `api:` path is really accepted
 * by the public PATCH schema and each `op:` names a real operation.
 */

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn(() => vi.fn()),
  useQuery: vi.fn(),
  availability: vi.fn(),
  reportBoundaryError: vi.fn(),
  featureEnabled: vi.fn(),
  capabilities: vi.fn(),
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

// Every gate held OPEN. The ratchet is about what this sheet can render, not
// about which flags happen to be on for one organization: a row hidden behind
// a gate is still a row someone has to reach from an agent.
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => true,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => true,
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

vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => mocks.capabilities(),
}));

function renderedSettingKeys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-setting-key]")).map(
    (node) => node.getAttribute("data-setting-key") ?? ""
  );
}

describe("eval suite settings manifest — render parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMutation.mockReturnValue(vi.fn());
    mocks.useQuery.mockImplementation(() => undefined);
    // Every gate OPEN: the ratchet is about what the sheet can render, not
    // about which flags happen to be on for one org. A row hidden behind a
    // gate is still a row someone has to reach from an agent.
    mocks.availability.mockReturnValue({ state: "enabled" });
    // `unavailable` is the pre-capabilities behaviour, so the coverage checks
    // above measure the sheet an old backend produces — the one that has to
    // keep working. The capability-specific tests below opt into `ready`.
    mocks.capabilities.mockReturnValue({
      state: "unavailable",
      capabilities: null,
    });
  });

  /** A capabilities answer with everything on, patched per test. */
  function readyCapabilities(patch: Record<string, unknown> = {}) {
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
        },
        features: {
          computers: { enabled: true },
          environments: { enabled: true },
          skills: { enabled: true },
          "claude-code-harness": { enabled: true },
          "codex-harness": { enabled: true },
          "cursor-harness": { enabled: true },
          "grading-engine-mode": { enabled: true },
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
        revisionNumber: 1,
        ...patch,
      },
    };
  }

  it("gives every rendered row a manifest entry", () => {
    // BOTH policies, because the sheet renders one set of policy rows or the
    // other and a key that only appears on a v2 suite is still a key someone
    // has to reach from an agent.
    for (const overrides of [{}, { suite: v2Suite }]) {
      const { container, unmount } = renderSettingsSheet(overrides);
      const rendered = renderedSettingKeys(container);
      expect(rendered.length).toBeGreaterThan(0);
      const unlisted = rendered.filter(
        (key) => !EVAL_SUITE_SETTING_KEYS.includes(key as never)
      );
      expect(
        unlisted,
        `Settings rows rendered with no manifest entry — declare how an agent reaches them in shared/eval-suite-settings-manifest.ts:\n  ${unlisted.join(
          "\n  "
        )}`
      ).toEqual([]);
      unmount();
    }
  });

  it("renders no key twice", () => {
    // A duplicated key would make the coverage check below pass for a row that
    // is not really there.
    for (const overrides of [{}, { suite: v2Suite }]) {
      const { container, unmount } = renderSettingsSheet(overrides);
      const rendered = renderedSettingKeys(container);
      expect(rendered).toEqual([...new Set(rendered)]);
      unmount();
    }
  });

  it("still corresponds to a real row for every manifest entry", () => {
    // The other direction, and the one that keeps an `excluded:` reason from
    // outliving the row it excuses: a manifest entry whose row was deleted is
    // a claim about a screen that no longer exists.
    //
    // The UNION across both policies, because no single suite renders every
    // row: a legacy suite has no repetitions and a v2 suite has no minimum
    // accuracy, and demanding both from one render would force the sheet to
    // show a reader two policies at once.
    const rendered = new Set<string>();
    for (const overrides of [{}, { suite: v2Suite }]) {
      const { container, unmount } = renderSettingsSheet(overrides);
      for (const key of renderedSettingKeys(container)) rendered.add(key);
      unmount();
    }
    const orphaned = EVAL_SUITE_SETTINGS_MANIFEST.filter(
      (row) => !rendered.has(row.key)
    ).map((row) => `${row.key} (${row.label})`);
    expect(
      orphaned,
      `Manifest entries with no rendered row — the row moved or was removed, so the entry is stale:\n  ${orphaned.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("labels each row the way the manifest says it does", () => {
    // Keeps the manifest READABLE next to the screen: an entry a maintainer
    // cannot match to a row is one they will not maintain.
    const seen = new Map<string, string>();
    for (const overrides of [{}, { suite: v2Suite }]) {
      const { container, unmount } = renderSettingsSheet(overrides);
      for (const row of EVAL_SUITE_SETTINGS_MANIFEST) {
        const node = container.querySelector(`[data-setting-key="${row.key}"]`);
        if (node) seen.set(row.key, node.textContent ?? "");
      }
      unmount();
    }
    for (const row of EVAL_SUITE_SETTINGS_MANIFEST) {
      const text = seen.get(row.key);
      expect(text, `no rendered row for ${row.key}`).toBeDefined();
      expect(text ?? "").toContain(row.label);
    }
  });

  /**
   * S2 — the two policies are ALTERNATIVES, and the sheet shows one.
   *
   * A page that showed a legacy percent beside a v2 fraction would ask a
   * reader to work out which one their runs are actually decided by, and the
   * honest answer ("only one of these does anything") is not something a
   * screen full of controls can convey.
   */
  it("shows the legacy policy's fields only on a legacy suite", () => {
    const legacy = new Set(
      renderedSettingKeys(renderSettingsSheet().container)
    );
    expect(legacy.has("minimumAccuracy")).toBe(true);
    expect(legacy.has("minimumIterations")).toBe(true);
    expect(legacy.has("repetitions")).toBe(false);
    expect(legacy.has("passThreshold")).toBe(false);
    expect(legacy.has("validity")).toBe(false);
  });

  it("shows the v2 policy's fields only on a v2 suite", () => {
    const v2 = new Set(
      renderedSettingKeys(renderSettingsSheet({ suite: v2Suite }).container),
    );
    expect(v2.has("repetitions")).toBe(true);
    expect(v2.has("passThreshold")).toBe(true);
    expect(v2.has("validity")).toBe(true);
    expect(v2.has("minimumAccuracy")).toBe(false);
    expect(v2.has("minimumIterations")).toBe(false);
  });

  /**
   * S3 — a row you cannot use SAYS SO, rather than vanishing.
   *
   * The three states a hidden row used to collapse into — no permission, a
   * feature this organization does not have, and a flag service that could not
   * be reached — are three different problems with three different next steps.
   * A person looking at a page that simply does not mention the setting they
   * were told to configure cannot tell which one they have.
   */
  it("renders a refused feature disabled, with the reason", () => {
    mocks.capabilities.mockReturnValue(
      readyCapabilities({
        features: {
          computers: { enabled: false, reason: "flag_false" },
          scheduledEvals: { enabled: true },
        },
      })
    );
    const { container } = renderSettingsSheet();
    const row = container.querySelector(
      '[data-setting-key="computerEnvironment"]'
    );
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-disabled-reason")).toBe(
      "Not enabled for this organization"
    );
    // Native disabling through a `fieldset`, so Radix triggers (which are
    // buttons underneath) are reached too, not just the `select`. Asserted with
    // `toBeDisabled`, which walks the fieldset ancestry — the `.disabled` IDL
    // property reflects only an element's OWN attribute and reads false for a
    // control that a browser will not let anyone touch.
    const select = row?.querySelector("select");
    expect(select).toBeDisabled();
  });

  it("keeps a flag-service outage distinct from a flag that said no", () => {
    mocks.capabilities.mockReturnValue(
      readyCapabilities({
        features: {
          computers: { enabled: false, reason: "flag_unavailable" },
          scheduledEvals: { enabled: true },
        },
      })
    );
    const { container } = renderSettingsSheet();
    // Collapsing these two is how a temporary outage teaches somebody their
    // organization does not have a feature it has.
    expect(
      container
        .querySelector('[data-setting-key="computerEnvironment"]')
        ?.getAttribute("data-disabled-reason")
    ).toBe("Could not check availability right now");
  });

  it("disables the schedule and delete rows without permission", () => {
    mocks.capabilities.mockReturnValue(
      readyCapabilities({
        permissions: {
          "suite.view": true,
          "suite.edit": true,
          "suite.configure": true,
          "suite.delete": false,
          "suite.schedule": false,
          "suite.environments": true,
          "run.launch": true,
          "gate.waive": true,
          "judge.review": true,
        },
      })
    );
    const { container } = renderSettingsSheet();
    for (const key of ["schedule", "deleteSuite"]) {
      expect(
        container
          .querySelector(`[data-setting-key="${key}"]`)
          ?.getAttribute("data-disabled-reason"),
        key
      ).toBe("You don't have permission to change this");
    }
  });

  it("behaves exactly as before when capabilities are unavailable", () => {
    // The regression guard for every deployment that predates the query. Rows
    // keep their original gates and carry no reason, because nothing refused
    // them — we simply could not ask.
    const { container } = renderSettingsSheet();
    expect(container.querySelectorAll("[data-disabled-reason]")).toHaveLength(
      0
    );
    expect(
      container.querySelector('[data-setting-key="computerEnvironment"]')
    ).toBeTruthy();
    expect(
      container.querySelector('[data-setting-key="schedule"]')
    ).toBeTruthy();
  });

  it("puts the environment composer on the Environments row", () => {
    const { container } = renderSettingsSheet();
    const row = container.querySelector('[data-setting-key="environments"]');
    expect(row).toBeTruthy();
    expect(row?.querySelector('[data-testid="suite-environment-bar"]')).toBeTruthy();
  });
});
