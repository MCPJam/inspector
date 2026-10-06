import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_AUTH_HOLD_MS,
  ExtensionWorkspaceProvider,
  useExtensionChatRelease,
  useExtensionOwners,
  useExtensionRegistration,
  useExtensionStore,
  usePublishPluginIcons,
  type ExtensionRegistration,
} from "../ExtensionWorkspaceProvider";
import { useServerIconSources } from "../plugin-icon-directory";
import {
  chatOwnerWorkspace,
  globalOwnerWorkspace,
  resolveExtensionCapabilities,
} from "../extension-owners";
import { ThreadAppError, type ThreadAppScope } from "../thread-app-api";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { parsePluginDeepLink } from "@/shared/plugin-deep-link";

const f = vi.hoisted(() => ({
  discover: vi.fn(),
  open: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  renew: vi.fn(),
  onboarding: vi.fn(),
  scopes: [] as unknown[],
  /** What discovery reports about each server beside its entries. */
  facts: {} as Record<string, object>,
}));
vi.mock("../thread-app-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-app-api")>()),
  createThreadAppApi: (scope: ThreadAppScope) => {
    f.scopes.push(scope);
    return {
      discover: (...args: unknown[]) => f.discover(scope, ...args),
      discoverServer: async (...args: unknown[]) => ({
        entries: await f.discover(scope, ...args),
        mentions: { available: false },
        mentionsReported: true,
        ...(f.facts[args[0] as string] ?? {}),
      }),
      open: (...args: unknown[]) => f.open(scope, ...args),
      invoke: (...args: unknown[]) => f.invoke(scope, ...args),
      close: (...args: unknown[]) => f.close(scope, ...args),
      renew: (...args: unknown[]) => f.renew(scope, ...args),
      onboarding: (...args: unknown[]) => f.onboarding(scope, ...args),
    };
  },
}));
vi.mock("@mcpjam/widget-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/widget-react")>()),
  WidgetWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  WidgetWorkspaceSurfaceHost: () => null,
  useWidgetWorkspace: () => ({}),
  closeWorkspaceSurface: vi.fn(),
  useWidgetSurfaceAdmissionError: () => null,
}));
vi.mock("@/components/chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({}),
}));
vi.mock("@/components/tools/ResultsPanel", () => ({
  ResultsPanel: () => null,
}));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: () => ({ discover: async () => false }),
}));

const identity = { actorId: "user", projectId: "project", hostId: "client" };
const server = { serverId: "saved", name: "Saved server" };
const other = { serverId: "other", name: "Other server" };
const thread = { toolName: "tray", title: "Parts Tray", kind: "thread" as const };
const global = {
  toolName: "library",
  title: "Library",
  kind: "global" as const,
};
let sequence = 0;
function handleFor(scope: ThreadAppScope, toolName: string) {
  sequence += 1;
  return {
    instanceToken: `token-${sequence}`.padEnd(43, "x"),
    instanceId: `instance-${scope.pluginWorkspace.workspaceId}-${toolName}`,
    generation: 1,
    operationId: `operation-${sequence}`,
    resourceUri: "ui://app",
    toolTitle: toolName,
    appToolsEnabled: false,
    contextEnabled: true,
    widgetContent: { html: "<html></html>" },
    toolsMetadata: { [toolName]: { revision: 1 } },
  };
}

type Owners = ReturnType<typeof useExtensionOwners>;
let owners: Owners = { global: null, chat: null };
let releaseChat: (chatId: string) => void = () => {};
function Center({ registration }: { registration: ExtensionRegistration | null }) {
  useExtensionRegistration(registration, {
    sendMessage: async () => true,
    runOnboarding: async () => {},
  });
  owners = useExtensionOwners();
  releaseChat = useExtensionChatRelease();
  return null;
}
function renderCenter(registration: ExtensionRegistration | null) {
  const view = render(
    <ExtensionWorkspaceProvider>
      <Center registration={registration} />
    </ExtensionWorkspaceProvider>,
  );
  return {
    ...view,
    update: (next: ExtensionRegistration | null) =>
      view.rerender(
        <ExtensionWorkspaceProvider>
          <Center registration={next} />
        </ExtensionWorkspaceProvider>,
      ),
  };
}
const registration = (
  chatId: string,
  overrides: Partial<ExtensionRegistration> = {},
): ExtensionRegistration => ({
  identity,
  chatId,
  servers: [server],
  ...overrides,
});
const PLUGIN_ICONS = new Map([
  [
    "bits",
    {
      composerIcon: {
        url: "https://cdn.example.invalid/composer.png",
        contentType: "image/png",
      },
    },
  ],
]);
const workspaceOf = (call: unknown[]) =>
  (call[0] as ThreadAppScope).pluginWorkspace.workspaceId;

describe("Playground extension owners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.scopes = [];
    owners = { global: null, chat: null };
    f.discover.mockResolvedValue([thread, global]);
    f.onboarding.mockResolvedValue({ available: false });
    f.open.mockImplementation(async (scope: ThreadAppScope, _server, tool) =>
      handleFor(scope, tool),
    );
    f.invoke.mockResolvedValue({ content: [] });
    f.close.mockResolvedValue(undefined);
    useTrafficLogStore.getState().clear();
  });
  afterEach(async () => {
    cleanup();
    f.facts = {};
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("joins a plugin-owned server to its plugin's icons for every surface", async () => {
    const serverIcons = [{ src: "https://cdn.example.invalid/server.png" }];
    f.facts = { saved: { pluginId: "bits", serverIcons } };
    let sources: ReturnType<typeof useServerIconSources> = {};
    function Surface() {
      usePublishPluginIcons(PLUGIN_ICONS);
      sources = useServerIconSources("saved");
      return null;
    }
    render(
      <ExtensionWorkspaceProvider>
        <Center registration={registration("chat-a")} />
        <Surface />
      </ExtensionWorkspaceProvider>,
    );
    await waitFor(() =>
      expect(sources).toEqual({
        pluginIcons: PLUGIN_ICONS.get("bits"),
        serverIcons,
      }),
    );
  });

  it("keeps thread Apps per chat and the global App across chat switches", async () => {
    const view = renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.global!.launch(server, global);
      await owners.chat!.launch(server, thread);
    });
    expect(owners.chat?.apps).toHaveLength(1);
    expect(f.open.mock.calls.map(workspaceOf)).toEqual([
      globalOwnerWorkspace(identity).workspaceId,
      chatOwnerWorkspace(identity, "chat-a").workspaceId,
    ]);

    view.update(registration("chat-b"));
    await waitFor(() => expect(owners.chat?.scope?.threadId).toBe("chat-b"));
    expect(owners.chat?.apps).toHaveLength(0);
    expect(owners.global?.apps).toHaveLength(1);
    // Global Apps follow the chat that is current when a request arrives.
    expect(owners.global?.appPorts?.currentThreadId?.()).toBe("chat-b");

    view.update(registration("chat-a"));
    await waitFor(() => expect(owners.chat?.scope?.threadId).toBe("chat-a"));
    expect(owners.chat?.apps).toHaveLength(1);
    expect(owners.chat?.apps[0].status).toBe("live");
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.close).not.toHaveBeenCalled();
    // One discovery per server, shared by both owners.
    expect(f.discover).toHaveBeenCalledTimes(1);
  });

  it("gives file viewer and quick-action Apps their own ports, opening deep links in the global App", async () => {
    f.open.mockImplementation(
      async (scope: ThreadAppScope, _server, tool, _signal, _kind, deepLink) => ({
        ...handleFor(scope, tool),
        ...(deepLink
          ? { deepLink: { url: parsePluginDeepLink(deepLink).url } }
          : {}),
      }),
    );
    renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    const file = {
      toolName: "viewer",
      title: "CAD viewer",
      kind: "file" as const,
      resourceUri: "cad://part",
    };
    await act(async () => {
      await owners.chat!.launch(server, file);
    });
    // Its own context handle reaches the chat's turns.
    expect(owners.chat?.contextReferences).toEqual([
      owners.chat!.apps[0].handle!.instanceToken,
    ]);
    await act(async () => {
      await owners.chat!.appPorts!.navigate(
        server,
        "chatgpt://plugins/p/app/library?path=%2Fparts",
      );
    });
    expect(owners.global?.apps.map((row) => row.declaration.kind)).toEqual([
      "global",
    ]);
    expect(owners.chat?.apps.map((row) => row.declaration.kind)).toEqual([
      "file",
    ]);
    expect(workspaceOf(f.open.mock.calls.at(-1)!)).toBe(
      globalOwnerWorkspace(identity).workspaceId,
    );
  });

  it("an App opened in the chat takes the rail from a fullscreen model App", async () => {
    let store: ReturnType<typeof useExtensionStore> = null;
    function Store() {
      store = useExtensionStore();
      return null;
    }
    render(
      <ExtensionWorkspaceProvider>
        <Center registration={registration("chat-a")} />
        <Store />
      </ExtensionWorkspaceProvider>,
    );
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    const exit = vi.fn();
    act(() =>
      store!.setState({ modelFullscreen: { label: "Saved server", exit } }),
    );
    await act(async () => {
      await owners.chat!.launch(server, {
        toolName: "viewer",
        title: "CAD viewer",
        kind: "file" as const,
        resourceUri: "cad://part",
      });
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("closes a deleted chat's Apps once another chat is shown", async () => {
    const view = renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.chat!.launch(server, thread);
    });
    act(() => releaseChat("chat-a"));
    // Still shown: nothing closes under the user.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.close).not.toHaveBeenCalled();
    view.update(registration("chat-b"));
    await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
  });

  it("closes everything from the old scope when the project or client changes", async () => {
    for (const change of [
      { projectId: "another-project" },
      { hostId: "another-client" },
    ]) {
      vi.clearAllMocks();
      const view = renderCenter(registration("chat-a"));
      await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
      await act(async () => {
        await owners.global!.launch(server, global);
        await owners.chat!.launch(server, thread);
      });
      view.update(
        registration("chat-a", { identity: { ...identity, ...change } }),
      );
      await waitFor(() => expect(f.close).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(owners.global?.scope?.pluginWorkspace.workspaceId).toBe(
          globalOwnerWorkspace({ ...identity, ...change }).workspaceId,
        ),
      );
      expect(owners.global?.apps).toHaveLength(0);
      expect(owners.chat?.apps).toHaveLength(0);
      expect(owners.chat?.contextAttachments).toEqual([]);
      expect(owners.global?.contextReferences).toEqual([]);
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  it("closes a disabled server's Apps and drops its launchers", async () => {
    f.discover.mockImplementation(async (_scope, serverId: string) =>
      serverId === "saved" ? [thread, global] : [],
    );
    const view = renderCenter(registration("chat-a", { servers: [server, other] }));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.chat!.launch(server, thread);
    });
    view.update(registration("chat-a", { servers: [other] }));
    await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(owners.chat?.apps).toHaveLength(0));
    expect(owners.global?.entries.saved).toBeUndefined();
  });

  it("closes every App when extensions are switched off", async () => {
    const view = renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.global!.launch(server, global);
      await owners.chat!.launch(server, thread);
    });
    view.update(registration("chat-a", { identity: null }));
    await waitFor(() => expect(f.close).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(owners.global).toBeNull());
    expect(owners.chat).toBeNull();
  });

  it("keeps the same Apps through a brief auth gap and their next call succeeds", async () => {
    const view = renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.global!.launch(server, global);
      await owners.chat!.launch(server, thread);
    });
    const before = [...owners.global!.apps, ...owners.chat!.apps].map(
      (row) => row.handle?.instanceId,
    );
    const chatSignal = owners.chat!.appPorts!.signal;
    // Identity is unknown for a few seconds while the session refreshes.
    view.update(registration("chat-a", { identity: null, hold: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.close).not.toHaveBeenCalled();
    expect(owners.chat?.apps).toHaveLength(1);
    // It comes back as the same user, project and client.
    view.update(registration("chat-a"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.close).not.toHaveBeenCalled();
    expect(
      [...owners.global!.apps, ...owners.chat!.apps].map(
        (row) => row.handle?.instanceId,
      ),
    ).toEqual(before);
    expect(owners.chat!.appPorts!.signal).toBe(chatSignal);
    expect(chatSignal.aborted).toBe(false);
    const row = owners.chat!.apps[0];
    await expect(
      owners.chat!.appPorts!.api.invoke(
        row.handle!,
        "tray.list",
        {},
        chatSignal,
      ),
    ).resolves.toEqual({ content: [] });
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it("an auth gap that never ends closes the Apps after the hold", async () => {
    const view = renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.chat!.launch(server, thread);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      view.update(registration("chat-a", { identity: null, hold: true }));
      await act(async () => {
        vi.advanceTimersByTime(EXTENSION_AUTH_HOLD_MS - 1_000);
      });
      expect(f.close).not.toHaveBeenCalled();
      expect(owners.chat?.apps).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(owners.chat).toBeNull();
      // Closing is deferred a tick past unmount (StrictMode replays effects).
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("turning off one capability removes only that capability", async () => {
    const view = renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    const file = {
      toolName: "viewer",
      title: "CAD viewer",
      kind: "file" as const,
      resourceUri: "cad://part",
    };
    await act(async () => {
      await owners.chat!.launch(server, thread);
      await owners.chat!.launch(server, file);
    });
    expect(owners.chat?.contextReferences).toHaveLength(2);
    view.update(
      registration("chat-a", {
        capabilities: resolveExtensionCapabilities({
          modelContext: false,
          fileViewers: false,
        }),
      }),
    );
    await waitFor(() => expect(owners.chat?.contextReferences).toEqual([]));
    // Open Apps keep running, including the open file viewer.
    expect(owners.chat?.apps.map((row) => row.status)).toEqual([
      "live",
      "live",
    ]);
    // No new file opens.
    await act(async () => {
      await owners.chat!.launch(server, { ...file, resourceUri: "cad://other" });
    });
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.close).not.toHaveBeenCalled();
  });

  it("cancels a pending approval once and drops its late result on close", async () => {
    let executionSignal!: AbortSignal;
    let approval!: Promise<boolean>;
    f.invoke.mockImplementation(
      (_scope, _handle, signal: AbortSignal, approve) => {
        executionSignal = signal;
        approval = approve({ id: "a", name: "write_part", params: {} }, signal);
        return approval.then((approved: boolean) => {
          if (!approved) throw new ThreadAppError("APPROVAL_DENIED");
          return { content: [] };
        });
      },
    );
    const view = renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    act(() => {
      void owners.chat!.launch(server, thread);
    });
    await waitFor(() => expect(owners.chat?.approvalPending).toBe(true));
    view.update(registration("chat-a", { identity: { ...identity, hostId: "next" } }));
    await waitFor(() => expect(executionSignal.aborted).toBe(true));
    await expect(approval).resolves.toBe(false);
    // The approval dialog closed with its owner.
    await waitFor(() => expect(owners.chat?.approvalPending).toBe(false));
    await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(owners.chat?.scope?.hostId).toBe("next"));
    expect(owners.chat?.apps).toEqual([]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("a client save under open Apps", () => {
  const quickAction = {
    toolName: "measure",
    title: "Measure",
    kind: "quick-action" as const,
  };
  const viewer = {
    toolName: "editor",
    title: "CAD editor",
    kind: "file" as const,
    resourceUri: "cad://part",
  };
  beforeEach(() => {
    vi.clearAllMocks();
    owners = { global: null, chat: null };
    f.discover.mockResolvedValue([thread, global]);
    f.onboarding.mockResolvedValue({ available: false });
    // Every activation is a new instance, as on the server.
    f.open.mockImplementation(async (scope: ThreadAppScope, _server, tool) => {
      const handle = handleFor(scope, tool);
      return {
        ...handle,
        instanceId: `${handle.instanceId}-${sequence}`,
        ...(tool === "editor"
          ? {
              file: { name: "part.step", resourceUri: "cad://part" },
              fileCapabilities: { write: true, subscribe: false },
            }
          : {}),
      };
    });
    f.invoke.mockResolvedValue({ content: [] });
    f.close.mockResolvedValue(undefined);
    f.renew.mockResolvedValue({ expiresAt: Date.now() + 60_000 });
    useTrafficLogStore.getState().clear();
  });
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  async function openEverything(view: ReturnType<typeof renderCenter>) {
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.global!.launch(server, global);
      await owners.chat!.launch(server, thread);
      await owners.chat!.launch(server, quickAction);
      await owners.chat!.launch(server, viewer);
    });
    return view;
  }
  const instances = () =>
    [...owners.global!.apps, ...owners.chat!.apps].map(
      (row) => row.handle?.instanceId,
    );

  it("re-checks each open App and keeps all of them when only toggles changed", async () => {
    const view = await openEverything(
      renderCenter(registration("chat-a", { hostRevision: "config-1" })),
    );
    const before = instances();
    view.update(
      registration("chat-a", {
        hostRevision: "config-2",
        capabilities: resolveExtensionCapabilities({
          sidebarApps: false,
          conversationPanels: false,
          fileViewers: false,
        }),
      }),
    );
    await waitFor(() => expect(f.renew).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instances()).toEqual(before);
    expect(
      [...owners.global!.apps, ...owners.chat!.apps].map((row) => row.status),
    ).toEqual(["live", "live", "live", "live"]);
    expect(f.open).toHaveBeenCalledTimes(4);
    expect(f.close).not.toHaveBeenCalled();
    // Saving again with the same settings asks nothing.
    view.update(
      registration("chat-a", {
        hostRevision: "config-2",
        capabilities: resolveExtensionCapabilities({
          sidebarApps: false,
          conversationPanels: false,
          fileViewers: false,
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.renew).toHaveBeenCalledTimes(4);
  });

  it("reopens an App whose client identity changed, or says why with Retry", async () => {
    const view = await openEverything(
      renderCenter(registration("chat-a", { hostRevision: "config-1" })),
    );
    const [globalBefore, threadBefore, , viewerBefore] = instances();
    f.renew.mockRejectedValue(new ThreadAppError("INSTANCE_HOST_CHANGED"));
    view.update(registration("chat-a", { hostRevision: "config-2" }));

    // The shown global App reopens under the new settings at once.
    await waitFor(() =>
      expect(owners.global?.apps[0].handle?.instanceId).not.toBe(globalBefore),
    );
    expect(owners.global?.apps[0].status).toBe("live");
    const [threadRow, quickRow, viewerRow] = owners.chat!.apps;
    // A hidden thread App drops its old activation and reopens when shown.
    expect(threadRow.handle).toBeUndefined();
    expect(threadRow.reopen).toBe(true);
    // A quick action would run again, so it asks first.
    expect(quickRow.status).toBe("error");
    expect(quickRow.retryable).toBe(true);
    expect(quickRow.error).toContain("The client's settings changed");
    // A writable viewer keeps its unsaved edits on screen.
    expect(viewerRow.handle?.instanceId).toBe(viewerBefore);
    expect(viewerRow.leaseEnded).toBe(true);
    await act(async () => {
      owners.chat!.select(threadRow.key);
    });
    await waitFor(() =>
      expect(owners.chat?.apps[0].handle?.instanceId).toBeDefined(),
    );
    expect(owners.chat?.apps[0].handle?.instanceId).not.toBe(threadBefore);
    // Each outcome is explained in the Logs.
    const logged = useTrafficLogStore
      .getState()
      .mcpServerItems.filter(
        (item) => item.method === "plugin-extensions/workspace/settings",
      );
    expect(logged).toHaveLength(4);
  });
});

describe("extension discovery freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    owners = { global: null, chat: null };
    f.onboarding.mockResolvedValue({ available: false });
    f.open.mockImplementation(async (scope: ThreadAppScope, _server, tool) =>
      handleFor(scope, tool),
    );
    f.invoke.mockResolvedValue({ content: [] });
    f.close.mockResolvedValue(undefined);
    useTrafficLogStore.getState().clear();
  });
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  const listChanged = (serverId: string) =>
    act(() => {
      useTrafficLogStore.getState().addMcpServerLog({
        serverId,
        direction: "RECEIVE",
        method: "notifications/tools/list_changed",
        timestamp: new Date().toISOString(),
        payload: {},
      });
    });

  it("adds and removes entrypoints when the server's tool list changes", async () => {
    f.discover.mockResolvedValueOnce([thread]).mockResolvedValueOnce([
      thread,
      global,
    ]);
    renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toEqual([thread]));
    // Notifications from other servers do not re-read this one.
    listChanged("unrelated");
    listChanged(server.name);
    await waitFor(() =>
      expect(owners.global?.entries.saved).toEqual([thread, global]),
    );
    f.discover.mockResolvedValueOnce([global]);
    listChanged(server.serverId);
    await waitFor(() => expect(owners.global?.entries.saved).toEqual([global]));
    expect(f.discover).toHaveBeenCalledTimes(3);
  });

  it("re-reads entrypoints when the server reconnects", async () => {
    f.discover.mockResolvedValue([thread]);
    const view = renderCenter(
      registration("chat-a", { servers: [{ ...server, connection: "1" }] }),
    );
    await waitFor(() => expect(f.discover).toHaveBeenCalledTimes(1));
    view.update(registration("chat-a", { servers: [{ ...server }] }));
    view.update(
      registration("chat-a", { servers: [{ ...server, connection: "2" }] }),
    );
    await waitFor(() => expect(f.discover).toHaveBeenCalledTimes(2));
    expect(f.close).not.toHaveBeenCalled();
  });

  it("updates an open App's tool metadata when its schema changes", async () => {
    f.discover.mockResolvedValue([thread]);
    renderCenter(registration("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.chat!.launch(server, thread);
    });
    const opened = owners.chat!.apps[0].handle!;
    f.open.mockImplementationOnce(async () => ({
      ...opened,
      operationId: "fresh",
      toolsMetadata: { tray: { revision: 2 } },
    }));
    listChanged(server.serverId);
    await waitFor(() =>
      expect(owners.chat?.apps[0].handle?.toolsMetadata).toEqual({
        tray: { revision: 2 },
      }),
    );
    // Same instance and activation: no new execution, nothing closed.
    expect(owners.chat?.apps[0].handle?.instanceId).toBe(opened.instanceId);
    expect(owners.chat?.apps[0].handle?.operationId).toBe(
      opened.operationId,
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
  });
});
