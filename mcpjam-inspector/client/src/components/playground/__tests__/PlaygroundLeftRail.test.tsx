import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { track } from "@/lib/analytics";
import type { ServerFormData } from "@/shared/types";
import { PlaygroundLeftRail } from "../PlaygroundLeftRail";
import { useComparePaneStore } from "@/stores/compare-pane-store";
import { createServer } from "@/test/factories";
import type { ServerWithName } from "@/state/app-types";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";

/**
 * Zero-server Tools rail: connecting a server must happen in place. The empty
 * state's "Connect a server" button used to navigate to Servers, which dropped
 * the user out of the Playground mid-flow (BB-134).
 */

const playgroundState = vi.hoisted(() => ({
  onConnect: undefined as ((formData: ServerFormData) => void) | undefined,
  activeServerNames: [] as string[],
  onSelectMultipleServers: vi.fn(),
  paneServers: vi.fn(),
  builtinHostId: vi.fn(),
  servers: {} as Record<string, ServerWithName>,
  areServersHydrated: true,
  ensureServersReady: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/components/chat-v2/history/ChatHistoryRail", () => ({
  ChatHistoryRail: () => <div data-testid="chat-history-rail" />,
}));

vi.mock("../panes/EnvironmentToolsPane", () => ({
  EnvironmentToolsPane: () => <div data-testid="environment-tools-pane" />,
}));

vi.mock("../panes/MultiServerToolsPane", () => ({
  MultiServerToolsPaneInner: ({
    activeServerNames,
    serverConnectionControl,
  }: {
    activeServerNames: string[];
    serverConnectionControl?: ReactNode;
  }) => {
    playgroundState.paneServers(activeServerNames);
    return <div data-testid="multi-server-pane">{serverConnectionControl}</div>;
  },
}));

vi.mock("../playground-chat-history-bridge", () => ({
  usePlaygroundChatHistoryBridge: () => null,
}));

vi.mock("@/hooks/useHarnessBuiltinTools", () => ({
  useHarnessBuiltinTools: (hostId: string | null) => {
    playgroundState.builtinHostId(hostId);
    return { tools: [] };
  },
}));

// The agent browser's tools. Stubbed to "no browser attached" here — the
// section's own behaviour is covered in BrowserToolsSection.test.tsx, and what
// this suite is about is the rail's zero-server connect path.
vi.mock("@/hooks/useBrowserTools", () => ({
  useBrowserTools: () => ({
    attached: false,
    engine: "hosted" as const,
    tools: [],
    page: null,
    refreshPage: vi.fn(),
    invokePage: vi.fn(),
  }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

vi.mock("@/hooks/use-previewed-environment-id", () => ({
  usePreviewedEnvironmentId: () => [null, vi.fn()],
}));

vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({
    tools: {},
    selectedTool: null,
    fetchingTools: false,
    fetchTools: vi.fn(),
    setSelectedTool: vi.fn(),
    formFields: {},
    updateFormField: vi.fn(),
    updateFormFieldIsSet: vi.fn(),
    isExecuting: false,
    executeTool: vi.fn(),
    activeServerNames: playgroundState.activeServerNames,
    selectedServerNames: playgroundState.activeServerNames,
    onSelectMultipleServers: playgroundState.onSelectMultipleServers,
    savedRequestsHook: {
      openSaveDialog: vi.fn(),
      savedRequests: [],
      highlightedRequestId: null,
      handleLoadRequest: vi.fn(),
      handleRenameRequest: vi.fn(),
      handleDuplicateRequest: vi.fn(),
      handleDeleteRequest: vi.fn(),
    },
    onConnect: playgroundState.onConnect,
    servers: playgroundState.servers,
    areServersHydrated: playgroundState.areServersHydrated,
    ensureServersReady: playgroundState.ensureServersReady,
  }),
}));

// Stands in for the empty state's "Connect a server" button, which lives three
// components down (PlaygroundLeft → ToolList) and is covered by ToolList's own
// suite. What matters here is the handler the rail hands it.
vi.mock("@/components/ui-playground/PlaygroundLeft", () => ({
  PlaygroundLeft: ({
    onAddServerRequested,
    connectServerControl,
  }: {
    onAddServerRequested?: () => void;
    connectServerControl?: ReactNode;
  }) =>
    connectServerControl ?? (
      <button
        type="button"
        disabled={!onAddServerRequested}
        onClick={onAddServerRequested}
      >
        Connect a server
      </button>
    ),
}));

vi.mock("@/components/connection/AddServerModal", () => ({
  AddServerModal: ({
    isOpen,
    onSubmit,
  }: {
    isOpen: boolean;
    onSubmit: (formData: ServerFormData) => void;
  }) =>
    isOpen ? (
      <div role="dialog">
        <button
          type="button"
          onClick={() => onSubmit({ name: "local" } as ServerFormData)}
        >
          Save server
        </button>
      </div>
    ) : null,
}));

describe("PlaygroundLeftRail — zero-server Tools body", () => {
  beforeEach(() => {
    playgroundState.onConnect = undefined;
    playgroundState.activeServerNames = [];
    playgroundState.servers = {};
    playgroundState.areServersHydrated = true;
    playgroundState.ensureServersReady.mockReset();
    useComparePaneStore.setState({ panes: [], selectedPaneId: null });
    vi.mocked(track).mockClear();
  });

  it("connects from the empty state without leaving the Playground", () => {
    const onConnect = vi.fn();
    playgroundState.onConnect = onConnect;

    render(<PlaygroundLeftRail />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /connect a server/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save server/i }));

    expect(onConnect).toHaveBeenCalledWith({ name: "local" });
    expect(track).toHaveBeenCalledWith("connecting_server", {
      location: "playground_tools_rail",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Names the handler, not the fallback: the mock button is disabled purely
  // because it received no `onAddServerRequested`. That the real button then
  // routes to /servers is ToolList's test, not this one.
  it("hands PlaygroundLeft no connect handler when the state has none", () => {
    render(<PlaygroundLeftRail />);

    expect(
      screen.getByRole("button", { name: /connect a server/i }),
    ).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const ready = (name: string): EnsureServersReadyResult => ({
    readyServerNames: [name],
    failedServerNames: [],
    missingServerNames: [],
    reauthServerNames: [],
  });
  const withSavedServer = () => {
    playgroundState.onConnect = vi.fn();
    playgroundState.servers = {
      "stateless-mcp": createServer({ name: "stateless-mcp" }),
    };
    playgroundState.ensureServersReady.mockResolvedValue(
      ready("stateless-mcp"),
    );
  };

  it("offers saved servers and Add server without asking for configuration again", async () => {
    withSavedServer();
    render(<PlaygroundLeftRail />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    expect(screen.getByRole("img", { name: "Disconnected" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add server" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save server" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect stateless-mcp" }),
    );
    await waitFor(() =>
      expect(playgroundState.ensureServersReady).toHaveBeenCalledWith(
        ["stateless-mcp"],
        { allowInteractiveOAuthFlow: true },
      ),
    );
    expect(playgroundState.onConnect).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByText("Connect a saved server"),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps Add server available when search matches no saved servers", () => {
    withSavedServer();
    render(<PlaygroundLeftRail />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "absent" },
    });
    expect(
      screen.queryByRole("button", { name: "Connect stateless-mcp" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(
      screen.getByRole("button", { name: "Save server" }),
    ).toBeInTheDocument();
  });

  it("waits for server hydration before deciding there are no saved servers", () => {
    playgroundState.onConnect = vi.fn();
    playgroundState.areServersHydrated = false;
    const { rerender } = render(<PlaygroundLeftRail />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    expect(screen.getByText(/loading servers/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save server" }),
    ).not.toBeInTheDocument();
    withSavedServer();
    playgroundState.areServersHydrated = true;
    rerender(<PlaygroundLeftRail />);
    expect(
      screen.getByRole("button", { name: "Connect stateless-mcp" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save server" }),
    ).not.toBeInTheDocument();
  });

  it("opens Add server when hydration finishes with an empty catalog", () => {
    playgroundState.onConnect = vi.fn();
    playgroundState.areServersHydrated = false;
    const { rerender } = render(<PlaygroundLeftRail />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    playgroundState.areServersHydrated = true;
    rerender(<PlaygroundLeftRail />);
    expect(
      screen.getByRole("button", { name: "Save server" }),
    ).toBeInTheDocument();
  });

  it("keeps connecting visible, prevents repeated attempts, and loads tools on success", async () => {
    withSavedServer();
    let finish: ((result: EnsureServersReadyResult) => void) | undefined;
    playgroundState.ensureServersReady.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<PlaygroundLeftRail />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    const connect = screen.getByRole("button", {
      name: "Connect stateless-mcp",
    });
    fireEvent.click(connect);
    fireEvent.click(connect);
    expect(connect).toBeDisabled();
    expect(playgroundState.ensureServersReady).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connecting to stateless-mcp",
    );
    playgroundState.activeServerNames = ["stateless-mcp"];
    rerender(<PlaygroundLeftRail />);
    expect(screen.queryByTestId("multi-server-pane")).not.toBeInTheDocument();
    await act(async () => {
      finish?.(ready("stateless-mcp"));
    });
    expect(screen.getByTestId("multi-server-pane")).toBeInTheDocument();
  });

  it.each([
    ["failedServerNames", /check that the server is running and try again/i],
    ["reauthServerNames", /click connect to sign in/i],
    ["missingServerNames", /choose another server or add one/i],
  ] as const)(
    "shows an actionable %s outcome and permits retry",
    async (key, message) => {
      withSavedServer();
      playgroundState.ensureServersReady.mockResolvedValueOnce({
        ...ready(""),
        readyServerNames: [],
        [key]: ["stateless-mcp"],
      });
      render(<PlaygroundLeftRail />);
      fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Connect stateless-mcp" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      fireEvent.click(
        screen.getByRole("button", { name: "Connect stateless-mcp" }),
      );
      await waitFor(() =>
        expect(playgroundState.ensureServersReady).toHaveBeenCalledTimes(2),
      );
      expect(playgroundState.onConnect).not.toHaveBeenCalled();
    },
  );

  it("handles a rejected reconnect without losing the picker", async () => {
    withSavedServer();
    playgroundState.ensureServersReady.mockRejectedValueOnce(
      new Error("offline"),
    );
    render(<PlaygroundLeftRail />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect stateless-mcp" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /check that the server is running and try again/i,
    );
    expect(
      screen.getByRole("button", { name: "Connect stateless-mcp" }),
    ).toBeEnabled();
  });

  it("shows details for each comparison pane without expanding the trigger", async () => {
    const user = userEvent.setup();
    useComparePaneStore.getState().publishPanes([
      {
        paneId: "a",
        label: "Claude",
        logoSrc: "/claude_logo.png",
        modelName: "Sonnet",
        serverSummary: "No servers",
        hostId: "claude",
        environmentId: null,
        serverNames: [],
      },
      {
        paneId: "b",
        label: "Claude",
        logoSrc: "/claude_logo.png",
        modelName: "Haiku",
        serverSummary: "1 server",
        hostId: "claude",
        environmentId: null,
        serverNames: ["stateless-mcp"],
      },
    ]);
    render(<PlaygroundLeftRail />);

    const trigger = screen.getByRole("combobox", { name: "Pane" });
    expect(trigger).toHaveTextContent("Claude (1)");
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      "/claude_logo.png",
    );
    expect(trigger).not.toHaveTextContent("Sonnet");

    await user.click(trigger);
    const first = screen.getByRole("option", { name: /Claude \(1\)/ });
    const second = screen.getByRole("option", { name: /Claude \(2\)/ });
    expect(within(first).getByText("Sonnet")).toBeVisible();
    expect(within(first).getByText("No servers")).toBeVisible();
    expect(within(second).getByText("Haiku")).toBeVisible();
    expect(within(second).getByText("1 server")).toBeVisible();
    expect(second.querySelector("img")).toHaveAttribute(
      "src",
      "/claude_logo.png",
    );

    await user.keyboard("{ArrowDown}{Enter}");
    expect(trigger).toHaveTextContent("Claude (2)");
    expect(trigger).not.toHaveTextContent("Haiku");
    expect(useComparePaneStore.getState().selectedPaneId).toBe("b");
  });

  it("adds the reconnected server only to the selected comparison pane", async () => {
    withSavedServer();
    const first = vi.fn();
    const second = vi.fn();
    let finish!: (result: EnsureServersReadyResult) => void;
    playgroundState.ensureServersReady.mockReturnValueOnce(
      new Promise<EnsureServersReadyResult>((resolve) => {
        finish = resolve;
      }),
    );
    useComparePaneStore.getState().publishPanes([
      {
        paneId: "a",
        label: "Claude",
        hostId: "claude",
        environmentId: null,
        serverNames: [],
        onServerChosen: first,
      },
      {
        paneId: "b",
        label: "Codex",
        hostId: "codex",
        environmentId: null,
        serverNames: [],
        onServerChosen: second,
      },
    ]);
    useComparePaneStore.getState().selectPane("b");
    render(<PlaygroundLeftRail />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect stateless-mcp" }),
    );
    expect(second).toHaveBeenCalledWith("stateless-mcp");
    const edited = vi.fn();
    playgroundState.activeServerNames = ["another-server"];
    act(() => {
      const store = useComparePaneStore.getState();
      store.publishPanes(
        store.panes.map((pane) =>
          pane.paneId === "b" ? { ...pane, onServerChosen: edited } : pane,
        ),
      );
    });
    await act(async () => finish(ready("stateless-mcp")));
    expect(playgroundState.onSelectMultipleServers).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(edited).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });

  it.each([
    ["failedServerNames", true],
    ["missingServerNames", true],
    ["reauthServerNames", false],
    ["readyServerNames", false],
  ] as const)(
    "undoes the pane pick after a %s outcome: %s",
    async (key, undone) => {
      withSavedServer();
      const undo = vi.fn();
      playgroundState.ensureServersReady.mockResolvedValueOnce({
        ...ready(""),
        readyServerNames: [],
        [key]: ["stateless-mcp"],
      });
      useComparePaneStore.getState().publishPanes([
        {
          paneId: "a",
          label: "Claude",
          hostId: "claude",
          environmentId: null,
          serverNames: [],
          onServerChosen: () => undo,
        },
      ]);
      render(<PlaygroundLeftRail />);
      fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Connect stateless-mcp" }),
      );
      await waitFor(() =>
        expect(playgroundState.ensureServersReady).toHaveBeenCalledTimes(1),
      );
      await act(async () => {});
      expect(undo).toHaveBeenCalledTimes(undone ? 1 : 0);
    },
  );

  it("undoes the pane pick when the reconnect throws", async () => {
    withSavedServer();
    const undo = vi.fn();
    playgroundState.ensureServersReady.mockRejectedValueOnce(
      new Error("offline"),
    );
    useComparePaneStore.getState().publishPanes([
      {
        paneId: "a",
        label: "Claude",
        hostId: "claude",
        environmentId: null,
        serverNames: [],
        onServerChosen: () => undo,
      },
    ]);
    render(<PlaygroundLeftRail />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect stateless-mcp" }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("keeps a retry pending when an earlier attempt finishes after returning to the project", async () => {
    withSavedServer();
    const attempts: Array<(result: EnsureServersReadyResult) => void> = [];
    playgroundState.ensureServersReady.mockImplementation(
      () =>
        new Promise<EnsureServersReadyResult>((resolve) => {
          attempts.push(resolve);
        }),
    );
    const startReconnect = () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Connect stateless-mcp" }),
      );
    };
    const { rerender } = render(<PlaygroundLeftRail projectId="first" />);
    startReconnect();
    rerender(<PlaygroundLeftRail projectId="second" />);
    rerender(<PlaygroundLeftRail projectId="first" />);
    startReconnect();
    playgroundState.activeServerNames = ["stateless-mcp"];
    rerender(<PlaygroundLeftRail projectId="first" />);

    await act(async () => attempts[0](ready("stateless-mcp")));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connecting to stateless-mcp",
    );
    await act(async () => attempts[1](ready("stateless-mcp")));
    expect(screen.getByTestId("multi-server-pane")).toBeInTheDocument();
  });

  it("discards the previous project's open picker and pending feedback after switching projects", async () => {
    withSavedServer();
    let finish: ((result: EnsureServersReadyResult) => void) | undefined;
    playgroundState.ensureServersReady.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<PlaygroundLeftRail projectId="first" />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect stateless-mcp" }),
    );
    playgroundState.servers = {};
    rerender(<PlaygroundLeftRail projectId="second" />);
    await act(async () => {
      finish?.(ready("stateless-mcp"));
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("stateless-mcp")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    expect(
      screen.getByRole("button", { name: "Save server" }),
    ).toBeInTheDocument();
  });
});

describe("PlaygroundLeftRail — Compare panes", () => {
  beforeEach(() => {
    playgroundState.activeServerNames = ["GitHub", "Docs"];
    playgroundState.servers = {
      Docs: createServer({ name: "Docs", connectionStatus: "connected" }),
    };
    playgroundState.paneServers.mockClear();
    playgroundState.builtinHostId.mockClear();
    useComparePaneStore.setState({ panes: [], selectedPaneId: null });
  });

  it("shows single chat's tools when no Compare panes are published", () => {
    render(<PlaygroundLeftRail previewedHostId="lead" />);
    expect(screen.queryByLabelText("Pane")).toBeNull();
    expect(playgroundState.builtinHostId).toHaveBeenLastCalledWith("lead");
    expect(playgroundState.paneServers).toHaveBeenLastCalledWith([
      "GitHub",
      "Docs",
    ]);
  });

  it("shows the selected pane's client and only the servers it uses", () => {
    useComparePaneStore.getState().publishPanes([
      { paneId: "a", label: "Claude", hostId: "claude", serverNames: null },
      { paneId: "b", label: "Codex", hostId: "codex", serverNames: ["Docs"] },
    ]);
    useComparePaneStore.getState().selectPane("b");

    render(<PlaygroundLeftRail previewedHostId="claude" />);

    expect(screen.getByLabelText("Pane")).toHaveTextContent("Codex");
    expect(playgroundState.builtinHostId).toHaveBeenLastCalledWith("codex");
    expect(playgroundState.paneServers).toHaveBeenLastCalledWith(["Docs"]);
  });

  it("offers reconnect after an assigned server disconnects, preserving the pane selection", async () => {
    const onServerChosen = vi.fn();
    playgroundState.ensureServersReady.mockReset();
    playgroundState.ensureServersReady.mockResolvedValue({
      readyServerNames: ["GitHub"],
      missingServerNames: [],
      reauthServerNames: [],
      failedServerNames: [],
    });
    playgroundState.servers = {
      ...playgroundState.servers,
      GitHub: createServer({ name: "GitHub", connectionStatus: "connecting" }),
    };
    useComparePaneStore.getState().publishPanes([
      {
        paneId: "a",
        label: "Claude",
        hostId: "claude",
        environmentId: null,
        serverNames: ["GitHub", "Docs"],
        onServerChosen,
      },
    ]);

    const { rerender } = render(<PlaygroundLeftRail />);
    expect(screen.getByText(/GitHub.*Finishing setup/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reconnect a server" }),
    ).toBeNull();

    playgroundState.servers.GitHub = createServer({
      name: "GitHub",
      connectionStatus: "disconnected",
    });
    rerender(<PlaygroundLeftRail />);
    expect(playgroundState.paneServers).toHaveBeenLastCalledWith(["Docs"]);
    expect(screen.getByText(/GitHub.*Disconnected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect a server" }));
    expect(screen.queryByRole("button", { name: /Connect Docs/ })).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" })),
    );
    expect(playgroundState.ensureServersReady).toHaveBeenCalledWith(["GitHub"], {
      allowInteractiveOAuthFlow: true,
    });
    expect(onServerChosen).not.toHaveBeenCalled();

    playgroundState.servers.GitHub = createServer({
      name: "GitHub",
      connectionStatus: "connected",
    });
    rerender(<PlaygroundLeftRail />);
    expect(playgroundState.paneServers).toHaveBeenLastCalledWith([
      "GitHub",
      "Docs",
    ]);
    expect(
      screen.queryByRole("button", { name: "Reconnect a server" }),
    ).toBeNull();
  });

  it("offers no reconnect while an assigned server is authorizing in the browser", () => {
    playgroundState.servers = {
      ...playgroundState.servers,
      GitHub: createServer({ name: "GitHub", connectionStatus: "oauth-flow" }),
    };
    useComparePaneStore.getState().publishPanes([
      {
        paneId: "a",
        label: "Claude",
        hostId: "claude",
        environmentId: null,
        serverNames: ["GitHub", "Docs"],
        onServerChosen: vi.fn(),
      },
    ]);

    render(<PlaygroundLeftRail />);
    expect(
      screen.getByText(/GitHub.*Authorizing in browser/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reconnect a server" }),
    ).toBeNull();
  });
});
