import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_SUITE_SETTINGS_MANIFEST,
  EVAL_SUITE_SETTING_KEYS,
} from "@/shared/eval-suite-settings-manifest";
import { renderSettingsSheet } from "./settings-sheet-harness";

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
    const { container } = renderSettingsSheet();
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
  });

  it("renders no key twice", () => {
    // A duplicated key would make the coverage check below pass for a row that
    // is not really there.
    const rendered = renderedSettingKeys(renderSettingsSheet().container);
    expect(rendered).toEqual([...new Set(rendered)]);
  });

  it("still corresponds to a real row for every manifest entry", () => {
    // The other direction, and the one that keeps an `excluded:` reason from
    // outliving the row it excuses: a manifest entry whose row was deleted is
    // a claim about a screen that no longer exists.
    const rendered = new Set(renderedSettingKeys(renderSettingsSheet().container));
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
    const { container } = renderSettingsSheet();
    for (const row of EVAL_SUITE_SETTINGS_MANIFEST) {
      const node = container.querySelector(`[data-setting-key="${row.key}"]`);
      expect(node, `no rendered row for ${row.key}`).toBeTruthy();
      expect(node?.textContent ?? "").toContain(row.label);
    }
  });

  it("puts the environment composer on the Environments row", () => {
    const { container } = renderSettingsSheet();
    const row = container.querySelector('[data-setting-key="environments"]');
    expect(row).toBeTruthy();
    expect(row?.querySelector('[data-testid="suite-environment-bar"]')).toBeTruthy();
  });
});
