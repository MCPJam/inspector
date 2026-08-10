/**
 * Scenario detail. Two behaviours are load-bearing beyond layout:
 *
 *  - Clusters are per-scenario. The usage panel is chatbox-scoped, so the
 *    Clusters tab must be rendering against THIS scenario's chatboxId and not
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
  EnvironmentComposer: (props: Record<string, unknown>) => {
    composerMock(props);
    return <div data-testid="stub-environment-composer" />;
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

const renderDetail = (over: Partial<ChatboxSettings> = {}) =>
  render(
    <UserTestingScenarioDetail
      chatbox={{ ...chatbox, ...over } as ChatboxSettings}
      onBack={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );

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
  environmentState.row = undefined;
  namedListState.value = [];
  flagState.environmentsEnabled = true;
});

describe("UserTestingScenarioDetail", () => {
  it("lands on Sessions and shows the scenario's share link", () => {
    renderDetail();

    expect(screen.getByTestId("stub-usage-sessions")).toBeInTheDocument();
    expect(screen.getByText("mcpjam.link/t/tok")).toBeInTheDocument();
  });

  it("scopes Clusters to this scenario's chatbox", () => {
    locationState.search = "?tab=clusters";
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

    fireEvent.click(screen.getByRole("button", { name: "Clusters" }));

    // Addressed by chatbox id: the host it displays is not unique per
    // scenario once environments are in play.
    expect(navigateMock).toHaveBeenCalledWith(
      "/user-testing/cb-1?tab=clusters",
      { replace: true },
    );
  });

  it("names the ENVIRONMENT on an environment-backed scenario", () => {
    renderDetail({ environmentId: "env-1", environmentName: "Checkout flow" });

    expect(screen.getByText("Checkout flow")).toBeInTheDocument();
  });

  it("warns when the environment can't resolve, and keeps the sessions", () => {
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
    expect(screen.getByTestId("stub-usage-sessions")).toBeInTheDocument();
  });

  it("shows the client, not an environment, on a host-backed scenario", () => {
    renderDetail();

    expect(
      screen.queryByTestId("user-testing-detail-environment-error"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
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
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: /Delete/i }));

    expect(screen.getByTestId("stub-delete-dialog")).toBeInTheDocument();
    expect(deleteChatboxMock).not.toHaveBeenCalled();
  });

  describe("naming the backing ad-hoc environment", () => {
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
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

      const button = screen.getByTestId("user-testing-name-environment");
      fireEvent.click(button);

      expect(
        screen.getByTestId("stub-name-environment-dialog"),
      ).toBeInTheDocument();
    });

    it("hides it while the environment row is still loading (fail closed)", () => {
      environmentState.row = undefined;
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

      expect(
        screen.queryByTestId("user-testing-name-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a row this member cannot see (null, fail closed)", () => {
      // Distinct from loading: the backend answered, and the answer was no.
      environmentState.row = null;
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

      expect(
        screen.queryByTestId("user-testing-name-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it when project-environments is flag-off", () => {
      // Promotion's payoff is "manage it from Environments" — a surface the
      // flag gates. Offering it flag-off would mutate a row the user then
      // has no page to see.
      flagState.environmentsEnabled = false;
      environmentState.row = adhocRow;
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

      expect(
        screen.queryByTestId("user-testing-name-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a named environment", () => {
      environmentState.row = {
        ...adhocRow,
        origin: "named",
        name: "Checkout flow",
      };
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      expect(
        screen.queryByTestId("user-testing-name-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a host-backed scenario (no environment at all)", () => {
      renderDetail();

      expect(
        screen.queryByTestId("user-testing-name-environment"),
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

    it("renders the composer seeded from the backing environment", () => {
      environmentState.row = namedRow;
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

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
