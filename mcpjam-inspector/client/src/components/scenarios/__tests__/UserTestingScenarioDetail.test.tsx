/**
 * Scenario detail. Two behaviours are load-bearing beyond layout:
 *
 *  - Insights are per-scenario. The usage panel is scenario-scoped, so the
 *    Insights tab must be rendering against THIS scenario's scenarioId and not
 *    some project-wide aggregate — that was the defect in the design PR this
 *    surface replaced.
 *  - The sub-tab lives in the URL and switches with `replace`, so the browser
 *    back button goes from a scenario to the list rather than walking back
 *    through every tab the user tried.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioSettings } from "@/hooks/useScenarios";

const {
  navigateMock,
  locationState,
  usagePanelMock,
  workbenchMock,
  deleteScenarioMock,
  previewPaneMock,
  hostState,
  updateScenarioMock,
  rebindScenarioMock,
  resolveTargetsMock,
  composerMock,
  environmentState,
  namedListState,
  flagState,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  locationState: { search: "" },
  usagePanelMock: vi.fn(),
  workbenchMock: vi.fn(),
  deleteScenarioMock: vi.fn().mockResolvedValue(undefined),
  previewPaneMock: vi.fn(),
  hostState: { host: null as unknown, isLoading: false },
  updateScenarioMock: vi.fn().mockResolvedValue(undefined),
  rebindScenarioMock: vi.fn().mockResolvedValue({}),
  resolveTargetsMock: vi.fn(),
  // Captures the props of every EnvironmentComposer render, so tests can
  // assert the seeded value and drive onChange without the real pills.
  composerMock: vi.fn(),
  // What `useProjectEnvironment` answers with: `undefined` = loading,
  // `null` = not visible, a row = loaded. Mutable per test.
  environmentState: { row: undefined as unknown },
  // The NAMED environment list (`useProjectEnvironments`): `undefined` while
  // loading, an array once settled.
  namedListState: { value: [] as unknown },
  flagState: { environmentsEnabled: true },
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useLocation: () => ({ search: locationState.search, pathname: "/x" }),
}));

// `useAppNavigate`, not react-router's `useNavigate`: app navigation goes
// through the scoped helper now, which carries the active project into
// project-owned paths (`/p/<projectId>/hosts/<id>`). The rest of
// `app-navigation` is the real module — these suites assert against its
// path builders.
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => navigateMock,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/lib/scenario-client-style", () => ({
  getScenarioHostLabel: (style: string) => `Label:${style}`,
  getScenarioHostLogo: () => "logo.png",
}));

vi.mock("@/lib/scenario-session", () => ({
  buildScenarioLink: (token: string) => `https://mcpjam.link/t/${token}`,
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useScenarios", () => ({
  useScenarioMutations: () => ({
    deleteScenario: deleteScenarioMock,
    updateScenario: updateScenarioMock,
    rebindEnvironmentScenario: rebindScenarioMock,
  }),
}));

// Mandatory: the real hook calls `useConvexAuth`, which has no provider here.
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironment: (projectId: string | null, envId: string | null) =>
    projectId && envId ? environmentState.row : null,
  useProjectEnvironments: () => namedListState.value,
}));

// Same reason: the real resolver hook binds a Convex mutation.
vi.mock("@/components/environment-composer/use-composer-resolver", () => ({
  useComposerResolver: () => resolveTargetsMock,
}));

vi.mock("@/components/environment-composer/environment-composer", () => ({
  EnvironmentComposer: (props: {
    environmentPickerFooter?: unknown;
    [key: string]: unknown;
  }) => {
    composerMock(props);
    return (
      <div data-testid="stub-environment-composer">
        {props.environmentPickerFooter as never}
      </div>
    );
  },
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flagState.environmentsEnabled,
}));

vi.mock("@/components/project-environments/NameEnvironmentDialog", () => ({
  NameEnvironmentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-name-environment-dialog" /> : null,
}));

vi.mock("@/components/scenarios/ScenarioShareSection", () => ({
  ScenarioShareSection: () => <div data-testid="stub-share" />,
}));

// Share UI calls useConvexAuth; stub so detail chrome specs don't need a provider.
vi.mock("@/components/scenarios/ScenarioShareBanner", () => ({
  ScenarioShareBanner: () => <div data-testid="stub-share-banner" />,
  ScenarioShareEmptyPanel: () => <div data-testid="stub-share-empty" />,
}));

// Provider reads Convex for pattern findings; these specs only care that the
// workbench mounts under it, not the rail lifecycle.
vi.mock("@/components/shared/usage-insights/run-insights", () => ({
  RunInsightsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  RunInsightsRecommendations: () => null,
}));

// The envelope hook subscribes to Convex; these specs render without a
// provider, so it is stubbed exactly like the rail above. `undefined` is the
// real "still loading / no envelope" value, and the panel renders nothing for
// it — the mount is what these specs care about.
vi.mock(
  "@/components/shared/actionable-insights/use-insights-envelope",
  () => ({ useInsightsEnvelope: () => undefined }),
);

vi.mock("@/components/scenarios/ScenarioDeleteConfirmDialog", () => ({
  ScenarioDeleteConfirmDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-delete-dialog" /> : null,
}));

vi.mock("@/components/scenarios/ScenarioUsagePanel", () => ({
  ScenarioUsagePanel: (props: Record<string, unknown>) => {
    usagePanelMock(props);
    return <div data-testid="stub-usage-sessions" />;
  },
}));

// Insights are their own mount now (the shared workbench), not a `section` of
// the sessions panel. Stubbed for the same reason: these specs are about which
// tab renders, not what the workbench draws.
vi.mock("@/components/shared/usage-insights/InsightsWorkbench", () => ({
  InsightsWorkbench: (props: Record<string, unknown>) => {
    workbenchMock(props);
    // Default stub leaves empty-state reporting to the page's initial
    // `insightsEmpty=true`. Specs that need the filled-cohort branch call
    // `onEmptyChange(false)` themselves.
    return (
      <div data-testid="stub-usage-insights">
        {props.emptyState as never}
      </div>
    );
  },
}));

// Resolves a viewer capability through Convex auth; these specs render outside
// a provider and never assert on the affordance it gates.
vi.mock("@/hooks/usePromoteCapability", () => ({
  usePromoteCapability: () => ({ canPromote: true, isLoading: false }),
}));

// Stubbed so jsdom never mounts the real iframe — it would try to fetch the
// share URL, and the point of these specs is WHEN the pane exists, not what
// it renders (see ScenarioPreviewPane.test.tsx for that).
vi.mock("@/components/scenarios/ScenarioPreviewPane", () => ({
  ScenarioPreviewPane: (props: Record<string, unknown>) => {
    previewPaneMock(props);
    return <div data-testid="stub-preview" />;
  },
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
  }: {
    children?: unknown;
  }) => <div data-testid="stub-resizable-group">{children as never}</div>,
  ResizablePanel: ({ children }: { children?: unknown }) => (
    <div>{children as never}</div>
  ),
  ResizableHandle: () => null,
}));

vi.mock("@/hooks/useClients", () => ({
  useHost: () => hostState,
}));

import { UserTestingScenarioDetail } from "../UserTestingScenarioDetail";
import { toast } from "@/lib/toast";

const scenario = {
  scenarioId: "cb-1",
  projectId: "p1",
  name: "Payments beta",
  hostStyle: "cursor",
  systemPrompt: "",
  modelId: "m",
  temperature: 0.5,
  requireToolApproval: false,
  allowGuestAccess: true,
  mode: "anyone_with_link",
  servers: [],
  namedHostId: "host-1",
  namedHostName: "Cursor",
  members: [],
  link: { token: "tok", path: "/t/tok", url: "u", rotatedAt: 0, updatedAt: 0 },
} as unknown as ScenarioSettings;

const detail = (
  over: Partial<ScenarioSettings> = {},
  opts: { editMode?: boolean } = {},
) => (
  <UserTestingScenarioDetail
    scenario={{ ...scenario, ...over } as ScenarioSettings}
    isAuthenticated
    editMode={opts.editMode}
    onBack={vi.fn()}
    onDeleted={vi.fn()}
  />
);

const renderDetail = (
  over: Partial<ScenarioSettings> = {},
  opts: { editMode?: boolean } = {},
) => render(detail(over, opts));

const renderEdit = (over: Partial<ScenarioSettings> = {}) =>
  renderDetail(over, { editMode: true });

/** Composer lives in the setup dialog — open it before asserting strip props. */
const openSetup = () => {
  fireEvent.click(screen.getByTestId("user-testing-edit-setup"));
};

beforeEach(() => {
  vi.clearAllMocks();
  workbenchMock.mockReset();
  // `clearAllMocks` clears calls but NOT implementations — reinstate the
  // resolved defaults so a per-test rejection can't leak into later cases.
  deleteScenarioMock.mockResolvedValue(undefined);
  updateScenarioMock.mockResolvedValue(undefined);
  rebindScenarioMock.mockResolvedValue({});
  resolveTargetsMock.mockResolvedValue({
    environmentIds: ["env-1"],
    environments: [],
    createdIds: [],
    reusedIds: ["env-1"],
  });
  locationState.search = "";
  hostState.host = { config: { mcpProfile: undefined } };
  hostState.isLoading = false;
  environmentState.row = undefined;
  namedListState.value = [];
  flagState.environmentsEnabled = true;
});

describe("UserTestingScenarioDetail", () => {
  it("lands on Insights by default", () => {
    renderDetail();

    expect(screen.getByTestId("stub-usage-insights")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-usage-sessions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-testing-edit-tab")).not.toBeInTheDocument();
    // Empty Insights owns share; the header strip stays off until there is data.
    expect(screen.queryByTestId("stub-share-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-share-empty")).toBeInTheDocument();
    expect(screen.getByTestId("user-testing-edit-button")).toBeInTheDocument();
    // Edit is a header action + route, not a view-mode tab.
    const tabNav = screen.getByRole("navigation", { name: "Scenario view" });
    expect(within(tabNav).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("shows the header share strip once Insights reports a filled cohort", async () => {
    renderDetail();
    expect(screen.queryByTestId("stub-share-banner")).not.toBeInTheDocument();

    const onEmptyChange = workbenchMock.mock.calls.at(-1)?.[0]?.onEmptyChange as
      | ((empty: boolean) => void)
      | undefined;
    expect(onEmptyChange).toBeTypeOf("function");
    await act(async () => {
      onEmptyChange?.(false);
    });

    expect(screen.getByTestId("stub-share-banner")).toBeInTheDocument();
  });

  it("keeps onEmptyChange stable across the render it triggers", async () => {
    // Regression for INSPECTOR-CLIENT-236 (infinite render loop).
    renderDetail();

    const before = workbenchMock.mock.calls.at(-1)?.[0]?.onEmptyChange as
      | ((empty: boolean) => void)
      | undefined;
    expect(before).toBeTypeOf("function");

    const callsAfterMount = workbenchMock.mock.calls.length;
    await act(async () => {
      before?.(false);
    });
    // A no-op regression (setter or callback stops updating) would leave
    // `calls` at the same length, making the identity check below vacuous.
    expect(workbenchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
    const after = workbenchMock.mock.calls.at(-1)?.[0]?.onEmptyChange;
    expect(after).toBe(before);

    // Redundant update, same value: the no-op guard must skip the re-render.
    const callsAfterFirstUpdate = workbenchMock.mock.calls.length;
    await act(async () => {
      before?.(false);
    });
    expect(workbenchMock.mock.calls.length).toBe(callsAfterFirstUpdate);
  });

  it("shows setup and share controls on the Edit route", () => {
    renderEdit();

    expect(screen.getByTestId("user-testing-edit-tab")).toBeInTheDocument();
    expect(screen.getByTestId("stub-share")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-share-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-usage-insights")).not.toBeInTheDocument();
  });

  it("scopes Insights to this scenario's scenario", () => {
    renderDetail();

    expect(screen.getByTestId("stub-usage-insights")).toBeInTheDocument();
    expect(workbenchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "scenario", scenarioId: "cb-1" },
        cohortKey: "cb-1",
      }),
    );
  });

  it("shows the share empty panel when Insights throw, not a blank pane", () => {
    // The window-insights rail used to wrap the whole tab in
    // `fallback={null}`. An undeployed `getWindowSignals` then left the
    // Insights `absolute inset-0` with no children — no empty state, no
    // retry. The workbench must stay reachable; if it itself blows up, the
    // share empty panel is the recovery UI.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    workbenchMock.mockImplementation(() => {
      throw new Error(
        "Could not find public function: scenarioWindowInsights:getWindowSignals",
      );
    });

    renderDetail();

    expect(screen.getByTestId("stub-share-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-usage-insights")).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("switches tabs by replacing the URL, not pushing onto history", () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));

    // Addressed by scenario id: the host it displays is not unique per
    // scenario once environments are in play.
    expect(navigateMock).toHaveBeenCalledWith(
      "/user-testing/cb-1?tab=sessions",
      { replace: true },
    );
  });

  it("offers Edit setup next to Delete when the composer can run", () => {
    environmentState.row = {
      environmentId: "env-1",
      projectId: "p1",
      origin: "named",
      name: "Checkout flow",
      hostId: "host-1",
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    renderEdit({ environmentId: "env-1", environmentName: "Checkout flow" });

    expect(screen.getByTestId("user-testing-edit-setup")).toHaveTextContent(
      "Edit",
    );
    expect(screen.getByTestId("user-testing-delete")).toBeInTheDocument();
  });

  it("warns on Edit when the environment can't resolve, and keeps Sessions readable", () => {
    const archived = {
      environmentId: "env-1",
      environmentName: "Checkout flow",
      environmentError: {
        code: "ENV_ARCHIVED" as const,
        message: "Environment “Checkout flow” is archived.",
      },
    };
    const { unmount } = renderEdit(archived);

    expect(
      screen.getByTestId("user-testing-detail-environment-error"),
    ).toHaveTextContent(/archived/i);
    unmount();

    // History is exactly what someone opens an archived scenario to read.
    renderDetail(archived);
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-1?tab=sessions", {
      replace: true,
    });
  });

  it("hides Edit setup on a host-backed scenario (composer can't run)", () => {
    renderEdit();

    expect(
      screen.queryByTestId("user-testing-detail-environment-error"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("user-testing-edit-setup"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-testing-delete")).toBeInTheDocument();
  });

  it("seeds the session pane from a deep-linked session", () => {
    locationState.search = "?session=thread-9";
    renderDetail();

    expect(usagePanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialThreadId: "thread-9" }),
    );
  });

  it("asks for confirmation before deleting rather than deleting outright", () => {
    renderEdit();

    fireEvent.click(screen.getByTestId("user-testing-delete"));

    expect(screen.getByTestId("stub-delete-dialog")).toBeInTheDocument();
    expect(deleteScenarioMock).not.toHaveBeenCalled();
  });

  describe("saving the backing ad-hoc environment", () => {
    const adhocRow = {
      environmentId: "env-1",
      projectId: "p1",
      origin: "adhoc",
      hostId: "host-1",
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
    };

    it("offers it for an ad-hoc row, and opens the dialog", () => {
      environmentState.row = adhocRow;
      // The label is synthesized from the client for ad-hoc rows — its
      // presence must NOT read as "named".
      renderEdit({ environmentId: "env-1", environmentName: "ChatGPT" });

      openSetup();
      const button = screen.getByTestId("user-testing-save-as-environment");
      fireEvent.click(button);

      expect(
        screen.getByTestId("stub-name-environment-dialog"),
      ).toBeInTheDocument();
    });

    it("hides it while the environment row is still loading (fail closed)", () => {
      environmentState.row = undefined;
      renderEdit({ environmentId: "env-1", environmentName: "ChatGPT" });

      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a row this member cannot see (null, fail closed)", () => {
      // Distinct from loading: the backend answered, and the answer was no.
      environmentState.row = null;
      renderEdit({ environmentId: "env-1", environmentName: "ChatGPT" });

      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it when project-environments is flag-off", () => {
      // Promotion's payoff is "manage it from Environments" — a surface the
      // flag gates. Offering it flag-off would mutate a row the user then
      // has no page to see.
      flagState.environmentsEnabled = false;
      environmentState.row = adhocRow;
      renderEdit({ environmentId: "env-1", environmentName: "ChatGPT" });

      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a named environment", () => {
      environmentState.row = {
        ...adhocRow,
        origin: "named",
        name: "Checkout flow",
      };
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a host-backed scenario (no environment at all)", () => {
      renderEdit();

      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });
  });

  describe("editing the scenario itself", () => {
    it("renames via updateScenario from the header title", async () => {
      renderDetail();

      fireEvent.click(screen.getByText("Payments beta"));
      const input = screen.getByDisplayValue("Payments beta");
      fireEvent.change(input, { target: { value: "Payments GA" } });
      fireEvent.keyDown(input, { key: "Enter" });

      // Settle the save inside act: EditableTitle's setState after the await
      // would otherwise land after the test body returns.
      await waitFor(() =>
        expect(updateScenarioMock).toHaveBeenCalledWith({
          scenarioId: "cb-1",
          name: "Payments GA",
        }),
      );
      // Edit mode exits and the CONTROLLED value re-renders — still the old
      // name here, because the mocked scenario never updates. The new name
      // arriving is the reactive envelope's job, not EditableTitle's.
      await screen.findByText("Payments beta");
    });

    it("persists the description on blur, only when it changed", () => {
      renderDetail({ description: "Old copy" });

      const textarea = screen.getByTestId("user-testing-description");
      // Blur with no edit: no write.
      fireEvent.blur(textarea);
      expect(updateScenarioMock).not.toHaveBeenCalled();

      fireEvent.change(textarea, { target: { value: "New copy" } });
      fireEvent.blur(textarea);
      expect(updateScenarioMock).toHaveBeenCalledWith({
        scenarioId: "cb-1",
        description: "New copy",
      });
    });
  });

  describe("editing the setup (composer → rebind)", () => {
    const namedRow = {
      environmentId: "env-1",
      projectId: "p1",
      origin: "named",
      name: "Checkout flow",
      hostId: "host-1",
      revision: 3,
      createdAt: 0,
      updatedAt: 0,
    };
    const composeState = {
      environmentIds: [],
      stack: {
        hostIds: ["host-2"],
        serverAttachmentId: null,
        skillSelection: null,
        computerEnvironmentId: null,
        modelSelection: { includeClientDefaults: true, explicitModelIds: [] },
      },
      customized: true,
    };
    const lastComposerProps = () =>
      composerMock.mock.calls.at(-1)?.[0] as {
        value: { environmentIds: string[] };
        onChange: (next: unknown) => void;
      };

    it("renders the composer seeded from the backing environment", () => {
      environmentState.row = namedRow;
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      expect(
        screen.getByTestId("stub-environment-composer"),
      ).toBeInTheDocument();
      expect(lastComposerProps().value.environmentIds).toEqual(["env-1"]);
    });

    it("does not render the composer while the row is loading", () => {
      environmentState.row = undefined;
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });
      expect(
        screen.queryByTestId("stub-environment-composer"),
      ).not.toBeInTheDocument();
    });

    /**
     * The scenario that needs this MOST is the flag-off one: it was created
     * with a single server and has no other way to change it — its backing
     * client is hidden from every client surface. The composer keeps its own
     * saved-environment picker behind the flag, so what renders here is the
     * client and server-group pair, which is what Swarms shows a flag-off
     * project too.
     */
    it("still renders the composer flag-off — that is where a stuck scenario is", () => {
      flagState.environmentsEnabled = false;
      // AD-HOC, which is what a flag-off scenario actually runs on: the create
      // flow composes one. It also makes the promote assertion below mean
      // something — against a named row that affordance is hidden either way,
      // so the flag gate would go untested.
      environmentState.row = { ...namedRow, origin: "adhoc", name: undefined };
      renderEdit({ environmentId: "env-1", environmentName: "ChatGPT" });

      openSetup();
      expect(
        screen.getByTestId("stub-environment-composer"),
      ).toBeInTheDocument();
      // Promotion stays gated: it would name a row into a list with no page.
      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });

    it("a composer edit resolves the stack and rebinds the scenario", async () => {
      environmentState.row = namedRow;
      resolveTargetsMock.mockResolvedValue({
        environmentIds: ["env-2"],
        environments: [],
        createdIds: ["env-2"],
        reusedIds: [],
      });
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));

      await waitFor(() =>
        expect(rebindScenarioMock).toHaveBeenCalledWith({
          scenarioId: "cb-1",
          environmentId: "env-2",
        }),
      );
      expect(resolveTargetsMock).toHaveBeenCalledWith(
        expect.objectContaining({ state: composeState, max: 1 }),
      );
    });

    it("skips the rebind when the edit resolves back to the current environment", async () => {
      environmentState.row = namedRow;
      resolveTargetsMock.mockResolvedValue({
        environmentIds: ["env-1"],
        environments: [],
        createdIds: [],
        reusedIds: ["env-1"],
      });
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));

      await waitFor(() => expect(resolveTargetsMock).toHaveBeenCalled());
      expect(rebindScenarioMock).not.toHaveBeenCalled();
    });

    it("an edit with no target commits nothing", () => {
      environmentState.row = namedRow;
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() =>
        lastComposerProps().onChange({
          ...composeState,
          stack: { ...composeState.stack, hostIds: [] },
        }),
      );

      expect(resolveTargetsMock).not.toHaveBeenCalled();
      expect(rebindScenarioMock).not.toHaveBeenCalled();
    });

    it("stays disabled until the named-environment list settles", () => {
      environmentState.row = namedRow;
      namedListState.value = undefined;
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      // The resolver reuses matching NAMED rows; resolving against a list
      // that hasn't loaded would mint an unnamed twin of one that exists.
      expect(lastComposerProps()).toEqual(
        expect.objectContaining({ disabled: true }),
      );
    });

    it("ignores a second edit while a commit is in flight", async () => {
      environmentState.row = namedRow;
      let release!: (v: unknown) => void;
      resolveTargetsMock.mockImplementation(
        () => new Promise((res) => (release = res)),
      );
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));
      // A second edit before the first settles: its rollback would clear the
      // in-flight guard out from under the first commit.
      act(() => lastComposerProps().onChange(composeState));
      expect(resolveTargetsMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        release({
          environmentIds: ["env-2"],
          environments: [],
          createdIds: ["env-2"],
          reusedIds: [],
        });
      });
      await waitFor(() => expect(rebindScenarioMock).toHaveBeenCalledTimes(1));
    });

    it("compares against the last COMMITTED environment, not the lagging prop", async () => {
      environmentState.row = namedRow;
      resolveTargetsMock.mockResolvedValueOnce({
        environmentIds: ["env-2"],
        environments: [],
        createdIds: ["env-2"],
        reusedIds: [],
      });
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));
      await waitFor(() =>
        expect(rebindScenarioMock).toHaveBeenCalledWith({
          scenarioId: "cb-1",
          environmentId: "env-2",
        }),
      );

      // The reactive envelope still says env-1 (the echo lags). The user
      // flips back to env-1 — against the PROP that reads as a no-op and the
      // backend would silently stay on env-2.
      resolveTargetsMock.mockResolvedValueOnce({
        environmentIds: ["env-1"],
        environments: [],
        createdIds: [],
        reusedIds: ["env-1"],
      });
      act(() => lastComposerProps().onChange(composeState));

      await waitFor(() =>
        expect(rebindScenarioMock).toHaveBeenCalledWith({
          scenarioId: "cb-1",
          environmentId: "env-1",
        }),
      );
      expect(rebindScenarioMock).toHaveBeenCalledTimes(2);
    });

    it("adopts a collaborator's rebind that landed mid-commit", async () => {
      environmentState.row = namedRow;
      let rejectResolve!: (err: unknown) => void;
      resolveTargetsMock.mockImplementation(
        () => new Promise((_res, rej) => (rejectResolve = rej)),
      );
      const { rerender } = renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));

      // A collaborator rebinds the scenario to env-9 while our resolve is in
      // flight — both sync effects deliberately skip the update.
      environmentState.row = {
        ...namedRow,
        environmentId: "env-9",
        name: "Remote setup",
      };
      rerender(
        detail(
          { environmentId: "env-9", environmentName: "Remote" },
          { editMode: true },
        ),
      );

      // Our commit then FAILS. Without reconciliation the rollback restores
      // the pre-commit setup (env-1) and the stale committed ref swallows
      // follow-up edits — while the backend points at env-9.
      await act(async () => {
        rejectResolve(new Error("boom"));
      });

      await waitFor(() =>
        expect(lastComposerProps().value.environmentIds).toEqual(["env-9"]),
      );
    });

    it("a refused rebind rolls the strip back and shows the backend's sentence", async () => {
      environmentState.row = namedRow;
      resolveTargetsMock.mockResolvedValue({
        environmentIds: ["env-2"],
        environments: [],
        createdIds: [],
        reusedIds: ["env-2"],
      });
      rebindScenarioMock.mockRejectedValue({
        data: {
          code: "CONFLICT",
          message:
            'That setup already has a scenario — "Other". Open it instead, or change the setup.',
        },
      });
      renderEdit({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'That setup already has a scenario — "Other". Open it instead, or change the setup.',
        ),
      );
      // Rolled back to what the scenario actually runs.
      expect(lastComposerProps().value.environmentIds).toEqual(["env-1"]);
    });
  });
});

/**
 * Preview docks beside Edit and embeds the live share link, which bootstraps
 * a real guest session. When it mounts is therefore a behaviour, not an
 * implementation detail: too eager and every visit to a scenario pollutes its
 * own Sessions list. Edit is a dedicated route, so leaving it unmounts Preview.
 */
describe("UserTestingScenarioDetail — preview", () => {
  it("does not embed anything until Edit is opened", () => {
    renderDetail();

    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Preview" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("user-testing-edit-button"));

    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-1/edit");
  });

  it("embeds this scenario's share link on the Edit route", () => {
    renderEdit();

    expect(screen.getByTestId("user-testing-edit-preview")).toBeInTheDocument();
    expect(screen.getByTestId("stub-preview")).toBeInTheDocument();
    expect(previewPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({ publishLink: "https://mcpjam.link/t/tok" }),
    );
  });

  it("redirects legacy ?tab=preview to the Edit route", () => {
    locationState.search = "?tab=preview";
    renderDetail();

    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-1/edit", {
      replace: true,
    });
    // Still on the detail tree until the parent remounts with editMode —
    // redirect must not mount Preview here.
    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();
  });

  it("unmounts Preview when leaving the Edit route", () => {
    const { rerender } = renderEdit();
    expect(screen.getByTestId("stub-preview")).toBeInTheDocument();

    rerender(detail());

    expect(screen.getByTestId("stub-usage-insights")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-testing-edit-tab")).not.toBeInTheDocument();
  });

  it("passes the host's mcp profile through for the iframe permissions", () => {
    const mcpProfile = { apps: { sandbox: { permissions: { mode: "deny-all" } } } };
    hostState.host = { config: { mcpProfile } };
    renderEdit();

    expect(previewPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({ mcpProfile }),
    );
  });

  it("waits for the host config rather than embedding with default permissions", () => {
    hostState.isLoading = true;
    hostState.host = null;
    renderEdit();

    // `allow` only applies at mount, and its no-config default is permissive.
    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();
    expect(screen.getByText(/Loading preview/i)).toBeInTheDocument();
  });

  it("refuses to embed a scenario whose environment can't resolve", () => {
    renderEdit({
      environmentId: "env-1",
      environmentName: "Checkout flow",
      environmentError: {
        code: "ENV_ARCHIVED",
        message: "Environment “Checkout flow” is archived.",
      },
    });

    // The link doesn't open for testers either — framing it would show them
    // the same failure with less explanation.
    expect(previewPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        publishLink: null,
        emptyTitle: "This scenario can't be previewed",
      }),
    );
  });
});
