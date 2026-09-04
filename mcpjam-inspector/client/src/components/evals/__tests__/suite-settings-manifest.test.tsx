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
  });

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

  it("puts the environment composer on the Environments row", () => {
    const { container } = renderSettingsSheet();
    const row = container.querySelector('[data-setting-key="environments"]');
    expect(row).toBeTruthy();
    expect(row?.querySelector('[data-testid="suite-environment-bar"]')).toBeTruthy();
  });
});
