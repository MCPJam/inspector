vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "member" } }),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useQuery: () => undefined,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabledState: () => false,
  useBrowserEnabledState: () => false,
  useBrowserWorkspaceEnabled: () => true,
}));
vi.mock("@/components/logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view" />,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/stores/active-chat-session-store", () => ({
  useActiveChatSessionStore: (
    select: (state: { sessionId: string }) => unknown,
  ) => select({ sessionId: "chat-1" }),
}));
vi.mock("@/hooks/useProjectComputer", () => ({
  useMintBrowserToken: () => async () => ({ token: "t", expiresAt: 0 }),
  useMintConversationBrowserToken: () => async () => ({
    token: "t",
    expiresAt: 0,
  }),
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (s: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));
vi.mock("@/hooks/useComputerEngine", () => ({
  useComputerEngine: () => ({
    engine: "cloud",
    selectedEngine: "cloud",
    setEngine: vi.fn(),
    resolved: true,
    localAvailable: false,
    localTerminalAvailable: false,
    cloudAvailable: false,
    toggleVisible: false,
    consent: { status: "absent", granted: false, token: null },
  }),
}));
vi.mock("@/hooks/useBrowserEngine", () => ({
  useBrowserEngine: () => ({
    engine: "cloud",
    selectedEngine: "cloud",
    resolved: true,
    localAvailable: false,
    cloudAvailable: false,
    toggleVisible: false,
    consent: { granted: false, token: null },
  }),
}));
vi.mock("@/hooks/useBrowserToolIds", () => ({
  useBrowserToolIds: () => [],
}));
vi.mock("@/components/computer/useComputerTerminal", () => ({
  useComputerTerminal: () => ({}),
}));
vi.mock("@/stores/harness-workdir-store", () => ({
  useHarnessWorkdir: () => undefined,
}));

const f = vi.hoisted(() => ({
  discover: vi.fn(),
  open: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  register: vi.fn(),
}));
vi.mock("@/components/host-workspace/thread-app-api", async (original) => ({
  ...(await original<
    typeof import("@/components/host-workspace/thread-app-api")
  >()),
  createThreadAppApi: () => ({
    discover: f.discover,
    discoverServer: async (...args: unknown[]) => ({
      entries: await f.discover(...args),
      mentions: { available: false },
      mentionsReported: true,
    }),
    open: f.open,
    invoke: f.invoke,
    close: f.close,
    onboarding: async () => ({ available: false }),
  }),
}));
vi.mock("@/components/host-workspace/server-settings-api", () => ({
  createServerSettingsApi: () => ({ discover: async () => false }),
}));
vi.mock("@mcpjam/widget-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/widget-react")>()),
  WidgetWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  WidgetWorkspaceSurfaceHost: ({
    activeSurfaceId,
  }: {
    activeSurfaceId: string | null;
  }) => <div data-testid="surface-host" data-active={activeSurfaceId ?? ""} />,
  useWidgetWorkspace: () => ({
    workspaceId: "w",
    surfaces: {
      getState: () => ({ surfaces: new Map(), upsertRegistration: f.register }),
    },
  }),
  closeWorkspaceSurface: vi.fn(),
  useWidgetSurfaceAdmissionError: () => null,
}));
vi.mock("@/components/chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({
    environment: { draftHostContext: {} },
    surface: {},
    resolvers: {
      resolveEffectiveHostCapabilities: () => ({}),
      resolveEffectiveMcpAppsCapabilities: () => ({
        availableDisplayModes: ["inline", "fullscreen"],
      }),
    },
    services: {},
  }),
}));
vi.mock("@/components/tools/ResultsPanel", () => ({
  ResultsPanel: () => null,
}));

import { PlaygroundRightRail } from "../PlaygroundRightRail";
import { resolveExtensionCapabilities } from "@/components/host-workspace/extension-owners";
import {
  ExtensionWorkspaceProvider,
  useExtensionOwners,
  useExtensionRegistration,
  useExtensionStore,
  type ExtensionRegistration,
} from "@/components/host-workspace/ExtensionWorkspaceProvider";

const server = { serverId: "saved", name: "Bits & Bolts" };
const tray = { toolName: "tray", title: "Parts Tray", kind: "thread" as const };
const library = { toolName: "lib", title: "Library", kind: "global" as const };
let owners: ReturnType<typeof useExtensionOwners> = {
  global: null,
  chat: null,
};
function Center({ registration }: { registration: ExtensionRegistration }) {
  useExtensionRegistration(registration, {
    sendMessage: async () => true,
    runOnboarding: async () => {},
  });
  owners = useExtensionOwners();
  extensionStore = useExtensionStore();
  return null;
}
let extensionStore: ReturnType<typeof useExtensionStore> = null;
const registration = (
  chatId: string,
  capabilities?: ExtensionRegistration["capabilities"],
): ExtensionRegistration => ({
  identity: { actorId: "u", projectId: "p", hostId: "h" },
  chatId,
  servers: [server],
  ...(capabilities ? { capabilities } : {}),
});
function view(
  chatId: string,
  capabilities?: ExtensionRegistration["capabilities"],
) {
  return (
    <ExtensionWorkspaceProvider>
      <Center registration={registration(chatId, capabilities)} />
      <PlaygroundRightRail
        onClose={() => {}}
        hostConfig={null}
        hostId="h"
        projectId="p"
        isAuthenticated
      />
    </ExtensionWorkspaceProvider>
  );
}

let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  owners = { global: null, chat: null };
  f.discover.mockResolvedValue([tray, library]);
  f.open.mockImplementation(async (_server: string, tool: string) => ({
    instanceToken: `t${++sequence}`.padEnd(43, "x"),
    instanceId: `instance-${tool}-${sequence}`,
    generation: 1,
    operationId: `op-${sequence}`,
    resourceUri: "ui://app",
    toolTitle: tool,
    appToolsEnabled: false,
    widgetContent: { html: "<html></html>" },
  }));
  f.invoke.mockResolvedValue({ content: [] });
  f.close.mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 10));
});

describe("PlaygroundRightRail — App tabs", () => {
  it("opens a thread App as a rail tab from the + menu and keeps it mounted across tab and chat switches", async () => {
    const { rerender } = render(view("chat-1"));
    // The rail is the tabbed side panel even with no computer or browser.
    expect(screen.getByTestId("right-rail-app-area")).toBeInTheDocument();
    await waitFor(() => expect(owners.chat?.entries.saved).toBeDefined());

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open a panel" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(await screen.findByText("Plugins and MCPs")).toBeInTheDocument();
    // Global entrypoints live in the left rail, not here.
    expect(screen.queryByRole("menuitem", { name: /Library/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /Parts Tray/ }));

    const tab = await screen.findByRole("tab", { name: "Parts Tray" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    const area = screen.getByTestId("right-rail-app-area");
    await waitFor(() =>
      expect(within(area).getByTestId("surface-host")).toBeInTheDocument(),
    );
    const surface = within(area).getByTestId("surface-host");
    expect(surface.getAttribute("data-active")).toMatch(/^instance-tray/);
    expect(area).not.toHaveClass("hidden");

    // Logs hides the App; it stays mounted in the same node.
    fireEvent.click(screen.getByRole("button", { name: /Logs/ }));
    expect(area).toHaveClass("hidden");
    expect(screen.getByRole("tab", { name: "Parts Tray" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Parts Tray" }));
    expect(area).not.toHaveClass("hidden");
    expect(within(area).getByTestId("surface-host")).toBe(surface);

    // Another chat has its own tabs; coming back finds the same App.
    rerender(view("chat-2"));
    await waitFor(() => expect(owners.chat?.scope?.threadId).toBe("chat-2"));
    expect(screen.queryByRole("tab", { name: "Parts Tray" })).toBeNull();
    rerender(view("chat-1"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Parts Tray" })).toBeInTheDocument(),
    );
    expect(screen.getByTestId("right-rail-app-area")).toBe(area);
    expect(within(area).getByTestId("surface-host")).toBe(surface);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.invoke).toHaveBeenCalledTimes(1);

    // × closes the App.
    fireEvent.click(screen.getByRole("button", { name: "Close Parts Tray" }));
    await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Parts Tray" })).toBeNull(),
    );
  });

  it("drops the + menu launcher when conversation panels are off, keeping the open App", async () => {
    const { rerender } = render(view("chat-1"));
    await waitFor(() => expect(owners.chat?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.chat!.launch(server, tray);
    });
    expect(
      await screen.findByRole("tab", { name: "Parts Tray" }),
    ).toBeInTheDocument();
    rerender(
      view(
        "chat-1",
        resolveExtensionCapabilities({ conversationPanels: false }),
      ),
    );
    // The open App keeps its tab and its activation.
    expect(screen.getByRole("tab", { name: "Parts Tray" })).toBeInTheDocument();
    expect(owners.chat?.apps.map((row) => row.status)).toEqual(["live"]);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Open a panel" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    // The launcher is gone: no new panel opens from here.
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Parts Tray/ })).toBeNull();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("names the server when two open Apps share a title", async () => {
    const other = { serverId: "other", name: "Bits & Bolts (2)" };
    render(view("chat-1"));
    await waitFor(() => expect(owners.chat?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.chat!.launch(server, tray);
      await owners.chat!.launch(other, tray);
    });
    expect(
      screen.getByRole("tab", { name: "Parts Tray · Bits & Bolts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Parts Tray · Bits & Bolts (2)" }),
    ).toBeInTheDocument();
  });
});

describe("PlaygroundRightRail — a chat App shown fullscreen", () => {
  it("is a selected rail tab; choosing another tab or closing it exits fullscreen", async () => {
    render(view("chat-1"));
    await waitFor(() => expect(owners.chat?.entries.saved).toBeDefined());
    const exit = vi.fn();
    act(() =>
      extensionStore!.setState({
        modelFullscreen: { label: "Bits & Bolts", exit },
      }),
    );
    const tab = screen.getByRole("tab", { name: "Bits & Bolts" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-rail-app-area")).not.toHaveClass("hidden");
    const dismissals = () => extensionStore!.getState().railDismissSeq;
    const before = dismissals();
    // Choosing Logs is choosing the rail: it stays open.
    fireEvent.click(screen.getByRole("button", { name: /Logs/ }));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(dismissals()).toBe(before);
    // Closing the tab is leaving fullscreen: a narrow rail gets out of the way.
    fireEvent.click(screen.getByRole("button", { name: "Close Bits & Bolts" }));
    expect(exit).toHaveBeenCalledTimes(2);
    expect(dismissals()).toBe(before + 1);
    act(() => extensionStore!.setState({ modelFullscreen: null }));
    expect(screen.queryByRole("tab", { name: "Bits & Bolts" })).toBeNull();
    // No App selected: the App area is hidden, never an empty open panel.
    expect(screen.getByTestId("right-rail-app-area")).toHaveClass("hidden");
    expect(screen.getByTestId("logger-view")).toBeVisible();
  });

  it("names its tab after the saved server, never the server's raw id", async () => {
    render(view("chat-1"));
    await waitFor(() => expect(owners.chat?.entries.saved).toBeDefined());
    // An App that names itself by its server id.
    act(() =>
      extensionStore!.setState({
        modelFullscreen: { label: server.serverId, exit: vi.fn() },
      }),
    );
    expect(
      screen.getByRole("tab", { name: "Bits & Bolts" }),
    ).toHaveAttribute("aria-selected", "true");
    // An id nothing names is still never shown.
    act(() =>
      extensionStore!.setState({
        modelFullscreen: {
          label: "mn7bw96zekw8ge3qgngdcx90hn8fpzw8",
          exit: vi.fn(),
        },
      }),
    );
    expect(screen.getByRole("tab", { name: "App" })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /mn7bw96zekw8ge3qgngdcx90hn8fpzw8/ }),
    ).toBeNull();
  });
});
