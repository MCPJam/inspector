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

const f = vi.hoisted(() => ({
  discover: vi.fn(),
  open: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  /** What discovery reports about each server beside its entries. */
  facts: {} as Record<string, object>,
}));
vi.mock("@/components/host-workspace/thread-app-api", async (original) => ({
  ...(await original<
    typeof import("@/components/host-workspace/thread-app-api")
  >()),
  createThreadAppApi: (scope: { pluginWorkspace: { workspaceId: string } }) => ({
    discover: f.discover,
    discoverServer: async (...args: unknown[]) => ({
      entries: await f.discover(...args),
      mentions: { available: false },
      mentionsReported: true,
      ...(f.facts[args[0] as string] ?? {}),
    }),
    open: (...args: unknown[]) => f.open(scope, ...args),
    invoke: f.invoke,
    close: f.close,
    onboarding: async () => ({ available: false }),
  }),
}));
vi.mock("@/components/host-workspace/server-settings-api", () => ({
  createServerSettingsApi: (_scope: unknown, serverId: string) => ({
    discover: async () => serverId === "saved",
  }),
}));
vi.mock("@/components/host-workspace/ServerSettingsPanel", () => ({
  ServerSettingsPanel: ({ serverName }: { serverName: string }) => (
    <div data-testid="settings-panel">{serverName} settings form</div>
  ),
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
      getState: () => ({ surfaces: new Map(), upsertRegistration: vi.fn() }),
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
        availableDisplayModes: ["fullscreen"],
      }),
    },
    services: {},
  }),
}));
vi.mock("@/components/tools/ResultsPanel", () => ({
  ResultsPanel: () => <div data-testid="quick-action-result" />,
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (s: { themeMode: string }) => unknown) =>
    selector({ themeMode: "dark" }),
}));

import { PlaygroundAppsSection } from "../PlaygroundAppsSection";
import {
  ExtensionWorkspaceProvider,
  useExtensionOwners,
  useExtensionRegistration,
  useExtensionSlot,
  useExtensionWorkspaceState,
  usePublishPluginIcons,
  type ExtensionRegistration,
} from "@/components/host-workspace/ExtensionWorkspaceProvider";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { APP_OPEN_TIMEOUT_MS } from "@/components/host-workspace/ThreadAppPanel";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { resolveExtensionCapabilities } from "@/components/host-workspace/extension-owners";

const server = {
  serverId: "saved",
  name: "Bits & Bolts Local",
  icons: [{ src: "https://plugin.example/server.png" }],
};
const library = {
  toolName: "library",
  title: "Parts Library",
  kind: "global" as const,
  icons: [{ src: "https://plugin.example/library.svg", mimeType: "image/svg+xml" }],
};
const quick = {
  toolName: "library",
  title: "Import part",
  kind: "quick-action" as const,
};
const PLUGIN_ICONS = new Map([
  [
    "bits",
    {
      logo: { url: "https://plugin.example/logo.png", contentType: "image/png" },
      logoDark: {
        url: "https://plugin.example/logo-dark.png",
        contentType: "image/png",
      },
    },
  ],
]);
let owners: ReturnType<typeof useExtensionOwners> = { global: null, chat: null };
let revealSeq = 0;
function Layout({
  chatId,
  capabilities,
}: {
  chatId: string;
  capabilities?: ExtensionRegistration["capabilities"];
}) {
  const registration: ExtensionRegistration = {
    identity: { actorId: "u", projectId: "p", hostId: "h" },
    chatId,
    servers: [server],
    ...(capabilities ? { capabilities } : {}),
  };
  useExtensionRegistration(registration, {
    sendMessage: async () => true,
    runOnboarding: async () => {},
  });
  usePublishPluginIcons(PLUGIN_ICONS);
  owners = useExtensionOwners();
  revealSeq = useExtensionWorkspaceState((state) => state.railRevealSeq) ?? 0;
  const takeover = useExtensionSlot("takeover");
  const rail = useExtensionSlot("rail");
  return (
    <>
      <PlaygroundAppsSection />
      <div ref={takeover} data-testid="takeover" />
      <div ref={rail} data-testid="rail" />
    </>
  );
}
const view = (
  chatId: string,
  capabilities?: ExtensionRegistration["capabilities"],
) => (
  <TooltipProvider>
    <ExtensionWorkspaceProvider>
      <Layout chatId={chatId} capabilities={capabilities} />
    </ExtensionWorkspaceProvider>
  </TooltipProvider>
);

let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  owners = { global: null, chat: null };
  f.discover.mockResolvedValue([library, quick]);
  f.open.mockImplementation(async (_scope, _server, tool: string, _signal, kind: string) => ({
    instanceToken: `t${++sequence}`.padEnd(43, "x"),
    instanceId: `instance-${kind}-${tool}`,
    generation: 1,
    operationId: `op-${sequence}`,
    resourceUri: "ui://app",
    toolTitle: tool,
    appToolsEnabled: false,
    widgetContent: { html: "<html></html>" },
    ...(kind === "quick-action" ? { presentation: "result" } : {}),
  }));
  f.invoke.mockResolvedValue({ content: [] });
  f.close.mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  f.facts = {};
  await new Promise((resolve) => setTimeout(resolve, 10));
});

describe("Apps in the left rail and the global takeover", () => {
  it("lists global entrypoints with their sidebar icon and opens one over the client area", async () => {
    const { rerender } = render(view("chat-1"));
    const row = await screen.findByRole("button", {
      name: "Parts Library",
    });
    // The entrypoint tool's SVG icon is a currentColor mask.
    expect(row.querySelector("[data-extension-icon=mask]")).not.toBeNull();
    fireEvent.click(row);
    const takeover = screen.getByTestId("takeover");
    await waitFor(() =>
      expect(
        within(takeover).getByText("Bits & Bolts Local"),
      ).toBeInTheDocument(),
    );
    expect(f.open.mock.calls[0][4]).toBe("global");
    expect(
      (f.open.mock.calls[0][0] as { pluginWorkspace: { workspaceId: string } })
        .pluginWorkspace.workspaceId,
    ).toContain('"global"');
    expect(row).toHaveAttribute("aria-current", "page");

    // Back returns to the chat and keeps the App.
    fireEvent.click(within(takeover).getByRole("button", { name: "Exit fullscreen" }));
    await waitFor(() => expect(owners.global?.active).toBeNull());
    expect(owners.global?.apps).toHaveLength(1);
    fireEvent.click(row);
    await waitFor(() => expect(owners.global?.active).not.toBeNull());
    expect(f.open).toHaveBeenCalledTimes(1);

    // Choosing another chat returns to it, too.
    rerender(view("chat-2"));
    await waitFor(() => expect(owners.global?.active).toBeNull());
    expect(owners.global?.apps).toHaveLength(1);
    expect(f.close).not.toHaveBeenCalled();
  });

  it("drops the sidebar launcher when sidebar Apps are off, keeping the open App", async () => {
    const { rerender } = render(view("chat-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Parts Library" }));
    await waitFor(() => expect(owners.global?.apps).toHaveLength(1));
    rerender(view("chat-1", resolveExtensionCapabilities({ sidebarApps: false })));
    // No launcher (and no quick action) for a new open.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Parts Library" })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Import part" })).toBeNull();
    // The open App stays retained with its activation.
    expect(owners.global?.apps.map((row) => row.status)).toEqual(["live"]);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("falls back to the owning plugin's logo after the server icon", async () => {
    f.facts = { saved: { pluginId: "bits" } };
    f.discover.mockResolvedValue([{ ...library, icons: undefined }]);
    render(view("chat-1"));
    const row = await screen.findByRole("button", { name: "Parts Library" });
    const image = () =>
      row.querySelector(
        "img[data-extension-icon=image], img[data-testid=plugin-icon]",
      );
    // No tool icon: the server's icon first.
    expect(image()).toHaveAttribute("src", "https://plugin.example/server.png");
    fireEvent.error(image()!);
    // Then the plugin's directory logo for the (dark) theme.
    await waitFor(() =>
      expect(image()).toHaveAttribute(
        "src",
        "https://plugin.example/logo-dark.png",
      ),
    );
  });

  it("runs a declared quick action from its hover + into the current chat's rail", async () => {
    render(view("chat-1"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Import part" }),
    );
    await waitFor(() => expect(owners.chat?.apps).toHaveLength(1));
    expect(owners.chat?.apps[0].declaration.kind).toBe("quick-action");
    expect(f.open.mock.calls[0][4]).toBe("quick-action");
    expect(revealSeq).toBeGreaterThan(0);
    expect(owners.global?.apps).toHaveLength(0);
  });

  it("says why when a quick action has no chat to run in, instead of doing nothing", async () => {
    useTrafficLogStore.getState().clear();
    render(view(""));
    fireEvent.click(await screen.findByRole("button", { name: "Import part" }));
    expect(f.open).not.toHaveBeenCalled();
    const logged = useTrafficLogStore
      .getState()
      .mcpServerItems.filter(
        (item) => item.method === "plugin-extensions/workspace/launch",
      );
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain("no chat is ready yet");
  });

  it("an App whose activation never answers says why after 30 s, and Retry opens it", async () => {
    useTrafficLogStore.getState().clear();
    const opened = f.open.getMockImplementation()!;
    f.open.mockImplementationOnce(
      (_scope, _server, _tool, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(view("chat-1"));
      fireEvent.click(
        await screen.findByRole("button", { name: "Parts Library" }),
      );
      const takeover = screen.getByTestId("takeover");
      expect(
        await within(takeover).findByText("Opening App…"),
      ).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(APP_OPEN_TIMEOUT_MS + 100);
      });
      const alert = await within(takeover).findByRole("alert");
      expect(alert).toHaveTextContent("waited 30 seconds");
      const logged = useTrafficLogStore
        .getState()
        .mcpServerItems.filter(
          (item) => item.method === "plugin-extensions/workspace/launch",
        );
      expect(logged).toHaveLength(1);
      f.open.mockImplementation(opened);
      await act(async () => {
        fireEvent.click(within(alert).getByRole("button", { name: /Retry/ }));
      });
      await waitFor(() => expect(owners.global?.apps[0].status).toBe("live"));
      expect(f.open).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens Settings from the row menu in the right rail", async () => {
    render(view("chat-1"));
    const options = await screen.findByRole("button", {
      name: "Parts Library options",
    });
    fireEvent.pointerDown(options, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("rail")).getByTestId("settings-panel"),
      ).toBeInTheDocument(),
    );
    expect(revealSeq).toBeGreaterThan(0);
  });

  it("offers a retry when a server's Apps can't be read", async () => {
    f.discover.mockRejectedValueOnce(new Error("unavailable"));
    render(view("chat-1"));
    const retry = await screen.findByRole("button", { name: /Retry/ });
    expect(
      screen.getByText("Couldn't load Bits & Bolts Local Apps"),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(
      await screen.findByRole("button", { name: "Parts Library" }),
    ).toBeInTheDocument();
  });
});
