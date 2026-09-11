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
  findingsState,
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
  // Lets one test make the landing tab throw the way its Convex query would
  // against a backend that cannot answer it.
  findingsState: { throws: false },
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

// Only the link BUILDER is stubbed. It reads the shareable app origin, which
// jsdom answers as localhost, and these specs assert against a share host.
//
// `withScenarioPreviewSurface` is deliberately the REAL export. The previous
// version of this mock reimplemented it, which made the preview assertion
// below unfalsifiable: a hand-rolled copy appends `surface=preview` whether or
// not the production helper still does — its `try/catch` returning the link
// untouched, or the param renamed, would leave the spec green. The real helper
// runs fine here; it only needs `window.location` for `new URL`'s base.
vi.mock("@/lib/scenario-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scenario-session")>()),
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
vi.mock("@/components/scenarios/ScenarioShareEmptyPanel", () => ({
  ScenarioShareEmptyPanel: () => <div data-testid="stub-share-empty" />,
}));

vi.mock("@/components/scenarios/ScenarioShareDialog", () => ({
  ScenarioShareDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-share-dialog" /> : null,
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
// Findings is the landing tab and reads sessions through Convex. These tests
// are about the detail shell, so it is stubbed the same way the workbench is.
vi.mock("@/components/scenarios/findings/scenario-findings-tab", () => ({
  ScenarioFindingsTab: () => {
    if (findingsState.throws) {
      throw new Error("Could not find public function");
    }
    return <div data-testid="stub-scenario-findings" />;
  },
}));

vi.mock("@/components/shared/usage-insights/InsightsWorkbench", () => ({
  InsightsWorkbench: (props: Record<string, unknown>) => {
    workbenchMock(props);
    return (
      <div data-testid="stub-usage-insights">{props.emptyState as never}</div>
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
  ResizablePanelGroup: ({ children }: { children?: unknown }) => (
    <div data-testid="stub-resizable-group">{children as never}</div>
  ),
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
  opts: { editMode?: boolean; sessionCount?: number } = {},
) => (
  <UserTestingScenarioDetail
    scenario={{ ...scenario, ...over } as ScenarioSettings}
    sessionCount={opts.sessionCount}
    editMode={opts.editMode}
    onBack={vi.fn()}
    onDeleted={vi.fn()}
  />
);

const renderDetail = (
  over: Partial<ScenarioSettings> = {},
  opts: { editMode?: boolean; sessionCount?: number } = {},
) => render(detail(over, opts));

const renderEdit = (
  over: Partial<ScenarioSettings> = {},
  opts: { sessionCount?: number } = {},
) => renderDetail(over, { ...opts, editMode: true });

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
  findingsState.throws = false;
});

describe("UserTestingScenarioDetail", () => {
  it("lands on Findings by default, with Insights still reachable", () => {
    renderDetail();

    expect(screen.getByTestId("stub-scenario-findings")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-usage-insights")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-usage-sessions")).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Scenario view" });
    // `stub-share-empty` is the Insights empty state and no longer renders
    // on the landing tab.
    expect(
      within(nav).getByRole("button", { name: "Findings" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("button", { name: "Insights" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("user-testing-edit-tab"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-testing-edit-button")).toBeInTheDocument();
    // Edit is a header action + route, not a view-mode tab.
    const tabNav = screen.getByRole("navigation", { name: "Scenario view" });
    expect(within(tabNav).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("keeps the page up when the landing tab's query throws", () => {
    // Findings reads sessions through Convex, and `useQuery` throws against a
    // backend that cannot answer. Because Findings is now the DEFAULT tab,
    // an unguarded throw blanks `/user-testing/:scenarioId` for everyone
    // arriving without a `?tab=` — not one tab a reader opted into. The tab
    // strip has to survive it, or there is no way back to Insights.
    findingsState.throws = true;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    renderDetail();

    expect(
      screen.queryByTestId("stub-scenario-findings"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-share-empty")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Scenario view" });
    expect(
      within(nav).getByRole("button", { name: "Insights" }),
    ).toBeInTheDocument();

    consoleError.mockRestore();
  });

  it("puts share behind one header button, with no strip in the page body", () => {
    renderDetail();

    // The landing tester-link banner is gone: Share is the only general
    // entry point, and a second affordance is what this replaced.
    expect(screen.queryByTestId("user-testing-share-dialog")).toBeNull();
    expect(screen.queryByTestId("stub-share-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("user-testing-share-button"));

    expect(screen.getByTestId("stub-share-dialog")).toBeInTheDocument();
  });

  it("offers the same Share modal on the Edit route", () => {
    renderEdit();

    fireEvent.click(screen.getByTestId("user-testing-share-button"));

    expect(screen.getByTestId("stub-share-dialog")).toBeInTheDocument();
  });

  it("shows Settings and its sharing controls on the Edit route", () => {
    renderEdit();

    expect(screen.getByTestId("user-testing-edit-tab")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Sharing permissions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Ratings" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("stub-share")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-usage-insights")).not.toBeInTheDocument();
  });

  it("scopes Insights to this scenario's scenario", () => {
    locationState.search = "?tab=insights";
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
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    workbenchMock.mockImplementation(() => {
      throw new Error(
        "Could not find public function: scenarioWindowInsights:getWindowSignals",
      );
    });

    locationState.search = "?tab=insights";
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

  it("edits the environment inline when the composer can run", () => {
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

    // Chips under an "Environment" heading, not a footer dialog.
    expect(
      screen.getByTestId("user-testing-environment-section"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Environment" }),
    ).toBeInTheDocument();
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
    expect(navigateMock).toHaveBeenCalledWith(
      "/user-testing/cb-1?tab=sessions",
      {
        replace: true,
      },
    );
  });

  it("hides the Environment section on a host-backed scenario (composer can't run)", () => {
    renderEdit();

    expect(
      screen.queryByTestId("user-testing-detail-environment-error"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("user-testing-environment-section"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("user-testing-delete")).toBeInTheDocument();
    // With no Environment section, the header is the only thing left that can
    // say which client this runs against.
    expect(screen.getByTestId("user-testing-host-client")).toHaveTextContent(
      "Client: Cursor",
    );
  });

  it("keeps the client out of the header once Environment can show it", () => {
    environmentState.row = {
      environmentId: "env-1",
      projectId: "p1",
      name: "Checkout flow",
      origin: { kind: "manual" },
      revision: 1,
      servers: [],
      hostStyle: "chatgpt",
      updatedAt: 0,
    };
    renderEdit({ environmentId: "env-1", environmentName: "Checkout flow" });

    expect(
      screen.getByTestId("user-testing-environment-section"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("user-testing-host-client")).toBeNull();
  });

  it("goes back to the scenario from Edit, not out to the list", () => {
    renderEdit();

    fireEvent.click(screen.getByTestId("user-testing-detail-back"));

    // Edit is a sub-route and its own Edit button is inert there, so the list
    // would leave no one-click way back to Insights.
    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-1");
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
      // BB-202 moved this field off the header row and into Edit.
      renderEdit({ description: "Old copy" });

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

    it("flushes a focused draft when Edit closes without a blur", () => {
      // Navigating out of Edit unmounts the field, and React fires no blur on
      // unmount — the typed text would be dropped and the focus guard would
      // latch, freezing the reseed for the rest of this instance's life.
      const { rerender } = renderEdit({ description: "Old copy" });

      const textarea = screen.getByTestId("user-testing-description");
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Typed then left" } });
      rerender(detail({ description: "Old copy" }));

      expect(updateScenarioMock).toHaveBeenCalledWith({
        scenarioId: "cb-1",
        description: "Typed then left",
      });
    });

    it("does not save a merely-focused draft over a collaborator's edit", () => {
      // Holding focus is not evidence of an edit. The reseed is suppressed
      // while focus is held, so the draft stays stale — flushing it on the way
      // out of Edit would overwrite the value that landed meanwhile.
      const { rerender } = renderEdit({ description: "Old copy" });

      fireEvent.focus(screen.getByTestId("user-testing-description"));
      rerender(detail({ description: "Collab copy" }, { editMode: true }));
      rerender(detail({ description: "Collab copy" }));

      expect(updateScenarioMock).not.toHaveBeenCalled();
    });

    it("does not re-send a save that is still in flight when Edit closes", async () => {
      // The blur save marks the seed synchronously. Advancing it only after
      // the write let the exit flush measure dirty against the pre-save seed
      // and send the same value a second time.
      let settleSave = () => {};
      updateScenarioMock.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settleSave = () => resolve();
        }),
      );
      const { rerender } = renderEdit({ description: "Old copy" });

      const textarea = screen.getByTestId("user-testing-description");
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "New copy" } });
      fireEvent.blur(textarea);
      expect(updateScenarioMock).toHaveBeenCalledTimes(1);

      // Leaving Edit while that write is still unresolved.
      rerender(detail({ description: "Old copy" }));
      expect(updateScenarioMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        settleSave();
      });
    });

    it("keeps the newer value when an older save fails late", async () => {
      // Two writes can overlap: blur starts one, retyping and leaving Edit
      // starts the next. The first one failing last must not resync the field
      // over the value that superseded it.
      let failFirst: (err: Error) => void = () => {};
      updateScenarioMock.mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          failFirst = reject;
        }),
      );
      const { rerender } = renderEdit({ description: "Old copy" });

      const textarea = screen.getByTestId("user-testing-description");
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "First" } });
      fireEvent.blur(textarea);
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Second" } });
      rerender(detail({ description: "Old copy" }));

      expect(updateScenarioMock).toHaveBeenNthCalledWith(2, {
        scenarioId: "cb-1",
        description: "Second",
      });

      await act(async () => {
        failFirst(new Error("stale save rejected"));
      });

      // Back into Edit: the draft still holds what the newer save sent, and
      // the superseded failure stayed silent.
      rerender(detail({ description: "Old copy" }, { editMode: true }));
      expect(screen.getByTestId("user-testing-description")).toHaveValue(
        "Second",
      );
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("adopts a collaborator's value when our save fails mid-flight", async () => {
      // The rollback runs after the await, so reading `scenario` from its
      // defining render restored a value the collaborator had already replaced.
      // The reseed effect had consumed the new one, so the field stayed wrong.
      let failSave: (err: Error) => void = () => {};
      updateScenarioMock.mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          failSave = reject;
        }),
      );
      const { rerender } = renderEdit({ description: "Old copy" });

      const textarea = screen.getByTestId("user-testing-description");
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Mine" } });
      fireEvent.blur(textarea);

      // A collaborator's edit lands while our write is still unresolved.
      rerender(detail({ description: "Theirs" }, { editMode: true }));

      await act(async () => {
        failSave(new Error("save rejected"));
      });

      expect(screen.getByTestId("user-testing-description")).toHaveValue(
        "Theirs",
      );
      expect(toast.error).toHaveBeenCalled();
    });

    it("keeps the description out of the header, where it crowded the tabs", () => {
      renderDetail({ description: "Old copy" });

      expect(
        screen.queryByTestId("user-testing-description"),
      ).not.toBeInTheDocument();
      // The tabs the field used to sit beside.
      expect(screen.getByRole("button", { name: "Insights" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Sessions" })).toBeVisible();
    });

    it("lets a long study name shrink instead of pushing the tabs off", () => {
      renderDetail({ name: "S".repeat(200) });

      // The design-system button ships shrink-0; the header has to override it,
      // or the name keeps full width and the tab row is what gives.
      const classes = screen.getByTitle("S".repeat(200)).className.split(/\s+/);
      expect(classes).toContain("shrink");
      expect(classes).not.toContain("shrink-0");
      expect(classes).toContain("min-w-0");
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
 * Settings is ONE COLUMN — the docked Preview is gone (BB-176).
 *
 * The pane embedded the live share link, so merely OPENING Edit bootstrapped a
 * real guest session that landed in the study's own Sessions list: the
 * creator's editing was indistinguishable from tester traffic. It also spent
 * half the screen on something whose only job was to be looked at, squeezing
 * the form it sat beside. "Open preview" in the action row does the same job
 * on demand, in a tab, and now says what it opens.
 */
describe("UserTestingScenarioDetail — settings layout", () => {
  it("never embeds the share link, on either route", () => {
    renderDetail();
    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();

    renderEdit();
    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("user-testing-edit-preview"),
    ).not.toBeInTheDocument();
    // No guest session was started just by opening the editor.
    expect(previewPaneMock).not.toHaveBeenCalled();
  });

  it("lays Settings out as a single fixed-measure column", () => {
    const { container } = renderEdit();

    expect(screen.getByTestId("user-testing-edit-tab")).toBeInTheDocument();
    // The 560px measure the frame specifies, not a percentage of a split pane
    // that keeps shrinking as the window narrows.
    expect(container.querySelector('[class*="w-[560px]"]')).not.toBeNull();
    // A resizable split is what the fixed measure replaced. Asserted against
    // the MOCK's own test id, not `[data-panel-group]`: the group is stubbed
    // in this file, so the real attribute never appears in jsdom and that
    // assertion could not fail even if the split came back.
    expect(
      screen.queryByTestId("stub-resizable-group"),
    ).not.toBeInTheDocument();
  });

  it("tags Open preview as preview traffic, not as a tester session", () => {
    // A creator opening their own study starts a real guest session. Untagged,
    // their look-around lands in the study's own Sessions list as if a tester
    // had run it — and the docked pane that used to set this marker is gone,
    // so this link is the only thing that can.
    renderEdit();

    expect(screen.getByTestId("user-testing-open-preview")).toHaveAttribute(
      "href",
      expect.stringContaining("surface=preview"),
    );
  });

  it("says what Open preview opens, without lengthening the label", () => {
    // Research read this button as a second step of setting the study up
    // rather than as the tester's own session.
    renderEdit();

    const link = screen.getByTestId("user-testing-open-preview");
    expect(link).toHaveTextContent("Open preview");
    expect(link).toHaveAttribute(
      "title",
      expect.stringMatching(/as a tester sees it/i),
    );
    expect(link).toHaveAccessibleName(/tester sees it/i);
  });

  it("still redirects legacy ?tab=preview to the Edit route", () => {
    locationState.search = "?tab=preview";
    renderDetail();

    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-1/edit", {
      replace: true,
    });
  });

  it("still warns when the environment can't resolve, and offers no preview link", () => {
    renderEdit({
      environmentId: "env-1",
      environmentName: "Checkout flow",
      environmentError: {
        code: "ENV_ARCHIVED",
        message: "Environment “Checkout flow” is archived.",
      },
    });

    expect(
      screen.getByTestId("user-testing-detail-environment-error"),
    ).toBeInTheDocument();
    // The link doesn't open for testers either, so it is not offered.
    expect(
      screen.queryByTestId("user-testing-open-preview"),
    ).not.toBeInTheDocument();
  });

  it("offers the tester task list beside the study's other settings", () => {
    renderEdit();

    expect(
      screen.getByTestId("user-testing-tasks-section"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-settings-tasks"),
    ).toBeInTheDocument();
  });
});

/**
 * Raised in review: "we're letting them mess up their test configurations —
 * one might be pointing to Excalidraw and the other to GitHub." Repointing a
 * study that has already been run leaves one set of results answering a setup
 * that no longer exists, under the same name, with nothing saying so.
 */
describe("UserTestingScenarioDetail — the setup of a study with results", () => {
  const composerProps = () =>
    composerMock.mock.calls[composerMock.mock.calls.length - 1][0] as {
      lockedSlots?: Record<string, string>;
    };

  const withEnvironment = () => {
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
  };

  it("locks the client and the servers once a tester has been through it", () => {
    withEnvironment();
    renderEdit(
      { environmentId: "env-1", environmentName: "Checkout flow" },
      { sessionCount: 3 },
    );

    const locks = composerProps().lockedSlots;
    // Each names ITS OWN control — someone who pressed the servers pill is
    // asking about servers, and being told about clients is being answered
    // about something else.
    expect(locks?.clients).toMatch(/client/i);
    expect(locks?.servers).toMatch(/servers/i);
    expect(locks?.clients).toMatch(/already has sessions/i);
  });

  it("leaves a study nobody has run fully editable", () => {
    withEnvironment();
    renderEdit(
      { environmentId: "env-1", environmentName: "Checkout flow" },
      { sessionCount: 0 },
    );

    expect(composerProps().lockedSlots).toBeUndefined();
  });

  it("stays editable when the backend does not report the count", () => {
    // `undefined` is "unknown", not "none". Refusing every edit on an
    // unanswered question would take a working screen away from everyone to
    // protect a case we cannot see.
    withEnvironment();
    renderEdit({ environmentId: "env-1", environmentName: "Checkout flow" });

    expect(composerProps().lockedSlots).toBeUndefined();
  });
});
