import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { baseSuite, renderSettingsSheet } from "./settings-sheet-harness";

// The judge model picker's logo reads the preferences store.
vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => <span aria-hidden="true" />,
}));

const mocks = vi.hoisted(() => ({
  applySuiteSettings: vi.fn(async (_args: Record<string, unknown>) => ({
    revisionNumber: 4,
  })),
  updateTestSuite: vi.fn(async () => ({})),
  flags: {} as Record<string, boolean>,
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: async () => null }),
  useMutation: (name: string) =>
    name === "testSuites:applySuiteSettings"
      ? mocks.applySuiteSettings
      : mocks.updateTestSuite,
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQueries: () => ({}),
}));
vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-suite-capabilities")>()),
  // Unread capabilities: the client flags decide alone.
  useSuiteCapabilities: () => ({ state: "unavailable", capabilities: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "eval-suite-settings-tabs" ? false : (mocks.flags[flag] ?? true),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags = {};
});

async function saveAndReadArgs(
  user: ReturnType<typeof userEvent.setup>,
): Promise<Record<string, unknown>> {
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(mocks.applySuiteSettings).toHaveBeenCalledTimes(1),
  );
  return mocks.applySuiteSettings.mock.calls[0][0];
}

describe("Setup and cleanup and Grading save with the rest of the settings", () => {
  it("saves a new script in the settings save", async () => {
    const user = userEvent.setup();
    renderSettingsSheet();
    await user.click(
      screen.getByRole("button", { name: "Add script: Before each iteration" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Before each iteration script" }),
      "reset-db --seed",
    );
    const args = await saveAndReadArgs(user);
    expect(args).toMatchObject({
      suiteId: "suite-1",
      scripts: { iterationSetup: "reset-db --seed" },
    });
    expect(args).not.toHaveProperty("grading");
  });

  it("saves the grading box's files and network", async () => {
    const user = userEvent.setup();
    renderSettingsSheet();
    await user.type(
      screen.getByRole("textbox", { name: "Files to copy" }),
      "/home/user/app/report.json",
    );
    await user.click(screen.getByRole("switch", { name: "Network" }));
    const args = await saveAndReadArgs(user);
    expect(args.grading).toEqual({
      files: ["/home/user/app/report.json"],
      network: "web",
    });
  });

  it("clears a stored script with the scripts flag off", async () => {
    mocks.flags = { "eval-setup-cleanup-scripts": false };
    const user = userEvent.setup();
    renderSettingsSheet({
      suite: { ...baseSuite, scripts: { runCleanup: "drop-db" } },
    });
    expect(
      screen.getByRole("textbox", { name: "After the run script" }),
    ).toHaveAttribute("readonly");
    await user.click(
      screen.getByRole("button", { name: "Remove the After the run script" }),
    );
    const args = await saveAndReadArgs(user);
    expect(args).toMatchObject({ suiteId: "suite-1", scripts: null });
  });

  it("shows neither row when both flags are off and nothing is stored", () => {
    mocks.flags = {
      "eval-setup-cleanup-scripts": false,
      "eval-code-evaluators": false,
    };
    const { container } = renderSettingsSheet();
    expect(container.querySelector('[data-setting-key="scripts"]')).toBeNull();
    expect(container.querySelector('[data-setting-key="grading"]')).toBeNull();
  });
});
