/**
 * Scenario detail. Two behaviours are load-bearing beyond layout:
 *
 *  - Insights are per-scenario. The usage panel is chatbox-scoped, so the
 *    Insights tab must be rendering against THIS scenario's chatboxId and not
 *    some project-wide aggregate — that was the defect in the design PR this
 *    surface replaced.
 *  - The sub-tab lives in the URL and switches with `replace`, so the browser
 *    back button goes from a scenario to the list rather than walking back
 *    through every tab the user tried.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatboxSettings } from "@/hooks/useChatboxes";

const {
  navigateMock,
  locationState,
  usagePanelMock,
  deleteChatboxMock,
  previewPaneMock,
  hostState,
  updateChatboxMock,
  rebindChatboxMock,
  resolveTargetsMock,
  composerMock,
  environmentState,
  namedListState,
  flagState,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  locationState: { search: "" },
  usagePanelMock: vi.fn(),
  deleteChatboxMock: vi.fn().mockResolvedValue(undefined),
  previewPaneMock: vi.fn(),
  hostState: { host: null as unknown, isLoading: false },
  updateChatboxMock: vi.fn().mockResolvedValue(undefined),
  rebindChatboxMock: vi.fn().mockResolvedValue({}),
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

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ search: locationState.search, pathname: "/x" }),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/lib/chatbox-client-style", () => ({
  getChatboxHostLabel: (style: string) => `Label:${style}`,
  getChatboxHostLogo: () => "logo.png",
}));

vi.mock("@/lib/chatbox-session", () => ({
  buildChatboxLink: (token: string) => `https://mcpjam.link/t/${token}`,
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxMutations: () => ({
    deleteChatbox: deleteChatboxMock,
    updateChatbox: updateChatboxMock,
    rebindEnvironmentChatbox: rebindChatboxMock,
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

vi.mock("@/components/chatboxes/ChatboxShareSection", () => ({
  ChatboxShareSection: () => <div data-testid="stub-share" />,
}));

vi.mock("@/components/chatboxes/ChatboxDeleteConfirmDialog", () => ({
  ChatboxDeleteConfirmDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-delete-dialog" /> : null,
}));

vi.mock("@/components/chatboxes/ChatboxUsagePanel", () => ({
  ChatboxUsagePanel: (props: Record<string, unknown>) => {
    usagePanelMock(props);
    return <div data-testid={`stub-usage-${props.section}`} />;
  },
}));

// Stubbed so jsdom never mounts the real iframe — it would try to fetch the
// share URL, and the point of these specs is WHEN the pane exists, not what
// it renders (see ChatboxPreviewPane.test.tsx for that).
vi.mock("@/components/chatboxes/ChatboxPreviewPane", () => ({
  ChatboxPreviewPane: (props: Record<string, unknown>) => {
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

const chatbox = {
  chatboxId: "cb-1",
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
} as unknown as ChatboxSettings;

const detail = (over: Partial<ChatboxSettings> = {}) => (
  <UserTestingScenarioDetail
    chatbox={{ ...chatbox, ...over } as ChatboxSettings}
    isAuthenticated
    onBack={vi.fn()}
    onDeleted={vi.fn()}
  />
);

const renderDetail = (over: Partial<ChatboxSettings> = {}) =>
  render(detail(over));

/** Composer lives in the setup dialog — open it before asserting strip props. */
const openSetup = () => {
  fireEvent.click(screen.getByTestId("user-testing-edit-setup"));
};

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears calls but NOT implementations — reinstate the
  // resolved defaults so a per-test rejection can't leak into later cases.
  deleteChatboxMock.mockResolvedValue(undefined);
  updateChatboxMock.mockResolvedValue(undefined);
  rebindChatboxMock.mockResolvedValue({});
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
  it("lands on Sessions by default", () => {
    renderDetail();

    expect(screen.getByTestId("stub-usage-sessions")).toBeInTheDocument();
    expect(screen.queryByTestId("user-testing-edit-tab")).not.toBeInTheDocument();
  });

  it("shows setup and share controls on the Edit tab", () => {
    locationState.search = "?tab=edit";
    renderDetail();

    expect(screen.getByTestId("user-testing-edit-tab")).toBeInTheDocument();
    expect(screen.getByTestId("stub-share")).toBeInTheDocument();
    expect(screen.queryByText(/Share this with testers/i)).not.toBeInTheDocument();
  });

  it("scopes Insights to this scenario's chatbox", () => {
    locationState.search = "?tab=insights";
    renderDetail();

    expect(screen.getByTestId("stub-usage-insights")).toBeInTheDocument();
    expect(usagePanelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        section: "insights",
        chatbox: expect.objectContaining({ chatboxId: "cb-1" }),
      }),
    );
  });

  it("switches tabs by replacing the URL, not pushing onto history", () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Insights" }));

    // Addressed by chatbox id: the host it displays is not unique per
    // scenario once environments are in play.
    expect(navigateMock).toHaveBeenCalledWith(
      "/user-testing/cb-1?tab=insights",
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
    locationState.search = "?tab=edit";
    renderDetail({ environmentId: "env-1", environmentName: "Checkout flow" });

    expect(screen.getByTestId("user-testing-edit-setup")).toHaveTextContent(
      "Edit",
    );
    expect(screen.getByTestId("user-testing-delete")).toBeInTheDocument();
  });

  it("warns on Edit when the environment can't resolve, and keeps Sessions readable", () => {
    locationState.search = "?tab=edit";
    renderDetail({
      environmentId: "env-1",
      environmentName: "Checkout flow",
      environmentError: {
        code: "ENV_ARCHIVED",
        message: "Environment “Checkout flow” is archived.",
      },
    });

    expect(
      screen.getByTestId("user-testing-detail-environment-error"),
    ).toHaveTextContent(/archived/i);

    // History is exactly what someone opens an archived scenario to read.
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-1", {
      replace: true,
    });
  });

  it("hides Edit setup on a host-backed scenario (composer can't run)", () => {
    locationState.search = "?tab=edit";
    renderDetail();

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
      expect.objectContaining({
        section: "sessions",
        initialThreadId: "thread-9",
      }),
    );
  });

  it("asks for confirmation before deleting rather than deleting outright", () => {
    locationState.search = "?tab=edit";
    renderDetail();

    fireEvent.click(screen.getByTestId("user-testing-delete"));

    expect(screen.getByTestId("stub-delete-dialog")).toBeInTheDocument();
    expect(deleteChatboxMock).not.toHaveBeenCalled();
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
      locationState.search = "?tab=edit";
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

      openSetup();
      const button = screen.getByTestId("user-testing-save-as-environment");
      fireEvent.click(button);

      expect(
        screen.getByTestId("stub-name-environment-dialog"),
      ).toBeInTheDocument();
    });

    it("hides it while the environment row is still loading (fail closed)", () => {
      environmentState.row = undefined;
      locationState.search = "?tab=edit";
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a row this member cannot see (null, fail closed)", () => {
      // Distinct from loading: the backend answered, and the answer was no.
      environmentState.row = null;
      locationState.search = "?tab=edit";
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

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
      locationState.search = "?tab=edit";
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

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
      locationState.search = "?tab=edit";
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a host-backed scenario (no environment at all)", () => {
      locationState.search = "?tab=edit";
      renderDetail();

      expect(
        screen.queryByTestId("user-testing-save-as-environment"),
      ).not.toBeInTheDocument();
    });
  });

  describe("editing the scenario itself", () => {
    it("renames via updateChatbox from the header title", async () => {
      renderDetail();

      fireEvent.click(screen.getByText("Payments beta"));
      const input = screen.getByDisplayValue("Payments beta");
      fireEvent.change(input, { target: { value: "Payments GA" } });
      fireEvent.keyDown(input, { key: "Enter" });

      // Settle the save inside act: EditableTitle's setState after the await
      // would otherwise land after the test body returns.
      await waitFor(() =>
        expect(updateChatboxMock).toHaveBeenCalledWith({
          chatboxId: "cb-1",
          name: "Payments GA",
        }),
      );
      // Edit mode exits and the CONTROLLED value re-renders — still the old
      // name here, because the mocked chatbox never updates. The new name
      // arriving is the reactive envelope's job, not EditableTitle's.
      await screen.findByText("Payments beta");
    });

    it("persists the description on blur, only when it changed", () => {
      renderDetail({ description: "Old copy" });

      const textarea = screen.getByTestId("user-testing-description");
      // Blur with no edit: no write.
      fireEvent.blur(textarea);
      expect(updateChatboxMock).not.toHaveBeenCalled();

      fireEvent.change(textarea, { target: { value: "New copy" } });
      fireEvent.blur(textarea);
      expect(updateChatboxMock).toHaveBeenCalledWith({
        chatboxId: "cb-1",
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
      },
      customized: true,
    };
    const lastComposerProps = () =>
      composerMock.mock.calls.at(-1)?.[0] as {
        value: { environmentIds: string[] };
        onChange: (next: unknown) => void;
      };

    beforeEach(() => {
      locationState.search = "?tab=edit";
    });

    it("renders the composer seeded from the backing environment", () => {
      environmentState.row = namedRow;
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      expect(
        screen.getByTestId("stub-environment-composer"),
      ).toBeInTheDocument();
      expect(lastComposerProps().value.environmentIds).toEqual(["env-1"]);
    });

    it("does not render the composer while the row is loading, or flag-off", () => {
      environmentState.row = undefined;
      const { unmount } = renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });
      expect(
        screen.queryByTestId("stub-environment-composer"),
      ).not.toBeInTheDocument();
      unmount();

      flagState.environmentsEnabled = false;
      environmentState.row = namedRow;
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });
      expect(
        screen.queryByTestId("stub-environment-composer"),
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
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));

      await waitFor(() =>
        expect(rebindChatboxMock).toHaveBeenCalledWith({
          chatboxId: "cb-1",
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
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));

      await waitFor(() => expect(resolveTargetsMock).toHaveBeenCalled());
      expect(rebindChatboxMock).not.toHaveBeenCalled();
    });

    it("an edit with no target commits nothing", () => {
      environmentState.row = namedRow;
      renderDetail({
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
      expect(rebindChatboxMock).not.toHaveBeenCalled();
    });

    it("stays disabled until the named-environment list settles", () => {
      environmentState.row = namedRow;
      namedListState.value = undefined;
      renderDetail({
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
      renderDetail({
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
      await waitFor(() => expect(rebindChatboxMock).toHaveBeenCalledTimes(1));
    });

    it("compares against the last COMMITTED environment, not the lagging prop", async () => {
      environmentState.row = namedRow;
      resolveTargetsMock.mockResolvedValueOnce({
        environmentIds: ["env-2"],
        environments: [],
        createdIds: ["env-2"],
        reusedIds: [],
      });
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      openSetup();
      act(() => lastComposerProps().onChange(composeState));
      await waitFor(() =>
        expect(rebindChatboxMock).toHaveBeenCalledWith({
          chatboxId: "cb-1",
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
        expect(rebindChatboxMock).toHaveBeenCalledWith({
          chatboxId: "cb-1",
          environmentId: "env-1",
        }),
      );
      expect(rebindChatboxMock).toHaveBeenCalledTimes(2);
    });

    it("adopts a collaborator's rebind that landed mid-commit", async () => {
      environmentState.row = namedRow;
      let rejectResolve!: (err: unknown) => void;
      resolveTargetsMock.mockImplementation(
        () => new Promise((_res, rej) => (rejectResolve = rej)),
      );
      const { rerender } = renderDetail({
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
      rerender(detail({ environmentId: "env-9", environmentName: "Remote" }));

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
      rebindChatboxMock.mockRejectedValue({
        data: {
          code: "CONFLICT",
          message:
            'That setup already has a scenario — "Other". Open it instead, or change the setup.',
        },
      });
      renderDetail({
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
 * own Sessions list.
 */
describe("UserTestingScenarioDetail — preview", () => {
  it("does not embed anything until Edit is opened", () => {
    renderDetail();

    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Preview" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-1?tab=edit", {
      replace: true,
    });
  });

  it("embeds this scenario's share link when Edit is opened", () => {
    locationState.search = "?tab=edit";
    renderDetail();

    expect(screen.getByTestId("user-testing-edit-preview")).toBeInTheDocument();
    expect(screen.getByTestId("stub-preview")).toBeInTheDocument();
    expect(previewPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({ publishLink: "https://mcpjam.link/t/tok" }),
    );
  });

  it("maps legacy ?tab=preview to Edit with the docked preview", () => {
    locationState.search = "?tab=preview";
    renderDetail();

    expect(screen.getByTestId("user-testing-edit-tab")).toBeInTheDocument();
    expect(screen.getByTestId("stub-preview")).toBeInTheDocument();
  });

  it("hides the Edit split (keeping Preview mounted) when you switch away", () => {
    locationState.search = "?tab=edit";
    const { rerender } = renderDetail();

    locationState.search = "";
    rerender(detail());

    // Still mounted — remounting would abandon the running tester session and
    // start a second one on the way back.
    expect(screen.getByTestId("stub-usage-sessions")).toBeInTheDocument();
    expect(screen.getByTestId("user-testing-edit-tab")).toHaveClass("hidden");
    expect(screen.getByTestId("stub-preview")).toBeInTheDocument();
    expect(previewPaneMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("passes the host's mcp profile through for the iframe permissions", () => {
    const mcpProfile = { apps: { sandbox: { permissions: { mode: "deny-all" } } } };
    hostState.host = { config: { mcpProfile } };
    locationState.search = "?tab=edit";
    renderDetail();

    expect(previewPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({ mcpProfile }),
    );
  });

  it("waits for the host config rather than embedding with default permissions", () => {
    hostState.isLoading = true;
    hostState.host = null;
    locationState.search = "?tab=edit";
    renderDetail();

    // `allow` only applies at mount, and its no-config default is permissive.
    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();
    expect(screen.getByText(/Loading preview/i)).toBeInTheDocument();
  });

  it("refuses to embed a scenario whose environment can't resolve", () => {
    locationState.search = "?tab=edit";
    renderDetail({
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
