import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "0.0.0-test";

// A real renderer, bridge-free: the AppBridge and the sandbox iframe are
// stand-ins that count constructions, teardowns and guest document loads.
const f = vi.hoisted(() => {
  const bridges: Array<Record<string, any>> = [];
  const appTools = { enabled: false };
  const ctor = vi.fn().mockImplementation(function () {
    const requests = new AbortController();
    const bridge: Record<string, any> = {
      requests,
      sendToolInput: vi.fn(),
      sendToolInputPartial: vi.fn(),
      sendToolResult: vi.fn(),
      sendToolCancelled: vi.fn(),
      setHostContext: vi.fn(),
      teardownResource: vi.fn().mockResolvedValue({}),
      close: vi.fn(async () => { requests.abort(); }),
      connect: vi.fn().mockResolvedValue(undefined),
      getAppCapabilities: vi.fn(() => appTools.enabled ? { tools: {} } : undefined),
      getAppVersion: vi.fn(() => ({ name: "bits-and-bolts", version: "1" })),
      listTools: vi.fn(async () => ({ tools: [{ name: "read_view", inputSchema: { type: "object" } }] })),
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      oninitialized: null,
    };
    bridges.push(bridge);
    return bridge;
  });
  return {
    bridges,
    appTools,
    ctor,
    /** Guest documents loaded by `sandbox-resource-ready`. */
    loads: [] as unknown[],
    iframeMounts: 0,
  };
});

vi.mock("sonner", () => ({ toast: { info: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/lib/sentry", () => ({ captureSentryMessage: vi.fn() }));
vi.mock(
  "@modelcontextprotocol/ext-apps/app-bridge",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@modelcontextprotocol/ext-apps/app-bridge")
    >()),
    AppBridge: f.ctor,
    PostMessageTransport: vi.fn(),
  }),
);
vi.mock("../../../../../../widget-react/src/sandboxed-iframe", async () => {
  const { forwardRef, useEffect, useImperativeHandle, useRef } =
    await import("react");
  return {
    SandboxedIframe: forwardRef((props: any, ref: any) => {
      const element = useRef<HTMLElement | null>(null);
      if (!element.current) {
        const el = document.createElement("div");
        Object.defineProperty(el, "contentWindow", {
          value: { postMessage: vi.fn() },
        });
        element.current = el;
      }
      useImperativeHandle(ref, () => ({
        getIframeElement: () => element.current,
        postMessage: vi.fn(),
      }));
      useEffect(() => {
        f.iframeMounts += 1;
      }, []);
      useEffect(() => {
        props.onProxyReady?.();
      }, [props.onProxyReady]);
      // Mirrors the real component: the guest document is (re)loaded once
      // per distinct resource payload.
      const key = JSON.stringify([props.html, props.reloadKey ?? null]);
      useEffect(() => {
        if (props.html) f.loads.push(key);
      }, [key]);
      return (
        <div
          data-testid="sandboxed-iframe"
          style={props.style}
          className={props.className}
        />
      );
    }),
  };
});

const stores = vi.hoisted(() => ({
  preferences: { themeMode: "light", hostStyle: "chatgpt" } as Record<
    string,
    unknown
  >,
  hostContext: { draftHostContext: {} as Record<string, unknown> },
  playground: {
    isPlaygroundActive: false,
    mcpAppsCspMode: "permissive",
    globals: { locale: "en-US", timeZone: "UTC" },
    displayMode: "inline",
    capabilities: { hover: true, touch: false },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    deviceType: "desktop",
  },
  debug: {
    setWidgetDebugInfo: vi.fn(),
    setWidgetState: vi.fn(),
    setWidgetGlobals: vi.fn(),
    setWidgetCsp: vi.fn(),
    setWidgetAppliedCsp: vi.fn(),
    addCspViolation: vi.fn(),
    clearCspViolations: vi.fn(),
    setWidgetModelContext: vi.fn(),
    setWidgetHtml: vi.fn(),
    setSandboxApplied: vi.fn(),
    appendLifecycle: vi.fn(),
    recordMount: vi.fn(),
    widgets: new Map(),
  },
  addLog: vi.fn(),
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => selector(stores.preferences),
}));
vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: (selector: any) => selector(stores.playground),
}));
vi.mock("@/stores/client-context-store", () => ({
  useHostContextStore: (selector: any) => selector(stores.hostContext),
}));
vi.mock("@/stores/traffic-log-store", () => {
  const state = {
    addLog: stores.addLog,
    addMcpServerLog: vi.fn(),
    mcpServerItems: [],
  };
  return {
    useTrafficLogStore: Object.assign((selector: any) => selector(state), {
      getState: () => state,
      subscribe: () => () => {},
    }),
    extractMethod: vi.fn(),
  };
});
vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: Object.assign(
    (selector: any) => selector(stores.debug),
    { getState: () => stores.debug },
  ),
}));
vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}));
vi.mock("@/components/tools/ResultsPanel", () => ({
  ResultsPanel: () => null,
}));
// The Playground's owners talk to the host through this API.
const host = vi.hoisted(() => ({
  open: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  renew: vi.fn(),
  onboarding: vi.fn(),
  context: vi.fn(),
  discover: vi.fn(),
  resolveLocalFile: vi.fn(),
}));
vi.mock("../thread-app-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-app-api")>()),
  createThreadAppApi: () => ({
    ...host,
    discoverServer: async (serverId: string) => ({
      entries: await host.discover(serverId),
      pluginId: "bits",
      mentions: { available: false },
      mentionsReported: true,
    }),
  }),
}));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: () => ({ discover: async () => false }),
}));

import { RetainedAppsView, type AppRow } from "../ThreadAppPanel";
import { ALL_EXTENSION_CAPABILITIES } from "../extension-owners";
import {
  ExtensionWorkspaceProvider,
  useExtensionOwners,
  useExtensionRegistration,
  useExtensionSlot,
  usePublishPluginIcons,
  type ExtensionRegistration,
} from "../ExtensionWorkspaceProvider";
import { ThreadAppError } from "../thread-app-api";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";
import { WidgetWorkspaceProvider, useAppToolsRegistryApi } from "@mcpjam/widget-react";
import { OwnedModelApp } from "../OwnedModelApp";
import { WorkspaceFileActionsProvider, type WorkspaceFileActions } from "../file-actions";
import { authFetch } from "@/lib/session-token";

const scope = {
  projectId: "project",
  hostId: "client",
  threadId: "global",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};

function rowFor(kind: "global" | "thread" | "file"): AppRow {
  return {
    key: `row-${kind}`,
    status: "live",
    server: { serverId: "saved", name: "Saved server" },
    declaration: { kind, toolName: "library", title: "Library" } as never,
    abort: new AbortController(),
    result: { content: [] } as never,
    handle: {
      instanceToken: "token".padEnd(43, "x"),
      instanceId: `instance-${kind}`,
      generation: 1,
      operationId: `operation-${kind}`,
      resourceUri: "ui://library",
      toolTitle: "Library",
      appToolsEnabled: false,
      contextEnabled: true,
      messageEnabled: true,
      localFilesAvailable: true,
      deepLinkNamespace: { pluginId: "bits", runtime: "chatgpt" },
      widgetContent: {
        html: "<html><body>library</body></html>",
        csp: undefined,
        permissions: undefined,
        permissive: true,
        mimeTypeValid: true,
      } as never,
      ...(kind === "file"
        ? {
            file: { name: "part.step", resourceUri: "file://part.step" },
            fileCapabilities: { write: false, subscribe: false },
          }
        : {}),
    },
  };
}

const ports = {
  api: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  signal: new AbortController().signal,
};
function resetPorts() {
  ports.api = {
    invoke: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => {}),
    renew: vi.fn(async () => ({ expiresAt: Date.now() + 60_000 })),
    resolveLocalFile: vi.fn(async () => []),
    context: vi.fn(),
  };
  ports.signal = new AbortController().signal;
}

/** The owner's view of one retained App, as `useThreadAppWorkspace` hands it out. */
function workspaceFor(row: AppRow, capabilities = ALL_EXTENSION_CAPABILITIES) {
  return {
    scope,
    apps: [row],
    active: row.key,
    close: vi.fn(),
    launch: vi.fn(),
    approvalDialog: null,
    appPorts: {
      scope,
      api: ports.api,
      publishContext: vi.fn(),
      sendMessage: vi.fn(async () => true),
      capabilities,
      navigate: vi.fn(),
      openFile: vi.fn(),
      approve: vi.fn(),
      signal: ports.signal,
    },
  } as never;
}

const profile = (
  extra: Partial<NonNullable<HostConfigMcpProfileV1["apps"]>> = {},
): HostConfigMcpProfileV1 => ({
  profileVersion: 1,
  apps: {
    uiInitialize: { hostInfo: { name: "chatgpt", version: "1" } },
    ...extra,
  },
});

function Harness({
  mcpProfile,
  workspace,
}: {
  mcpProfile: HostConfigMcpProfileV1;
  workspace: never;
}) {
  return (
    <ActiveMcpProfileProvider value={mcpProfile}>
      <RetainedAppsView workspace={workspace} />
    </ActiveMcpProfileProvider>
  );
}

async function openAndInitialize(
  kind: "global" | "thread" | "file",
  mcpProfile = profile(),
) {
  const row = rowFor(kind);
  const workspace = workspaceFor(row);
  const view = render(
    <Harness mcpProfile={mcpProfile} workspace={workspace} />,
  );
  await waitFor(() => expect(f.bridges).toHaveLength(1));
  await waitFor(() =>
    expect(f.bridges[0].oninitialized).toBeTypeOf("function"),
  );
  act(() => f.bridges[0].oninitialized());
  await waitFor(() =>
    expect(screen.getByTestId("sandboxed-iframe").style.opacity).toBe("1"),
  );
  return { row, view };
}

const OFF = {
  ...ALL_EXTENSION_CAPABILITIES,
  sidebarApps: false,
  conversationPanels: false,
  fileViewers: false,
  modelContext: false,
  messages: false,
  localFiles: false,
  deepLinks: false,
};

describe("a retained App across client saves", () => {
  beforeEach(() => {
    f.bridges.length = 0;
    f.loads.length = 0;
    f.iframeMounts = 0;
    f.ctor.mockClear();
    stores.preferences.themeMode = "light";
    resetPorts();
  });
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  function expectSameGuest(loads: number) {
    expect(f.ctor).toHaveBeenCalledTimes(1);
    expect(f.bridges[0].close).not.toHaveBeenCalled();
    expect(f.bridges[0].teardownResource).not.toHaveBeenCalled();
    expect(f.loads).toHaveLength(loads);
    expect(f.iframeMounts).toBe(1);
    expect(screen.getByTestId("sandboxed-iframe").style.opacity).toBe("1");
  }

  for (const kind of ["global", "thread", "file"] as const)
    it(`keeps a ${kind} App's bridge and guest when only toggles or the config id change`, async () => {
      const { row, view } = await openAndInitialize(kind);
      const loads = f.loads.length;
      // A save that switches extensions off: a new client snapshot, and new
      // per-client toggles for the owner.
      const saved = profile({
        pluginExtensions: { enabled: true, capabilities: OFF },
      } as never);
      view.rerender(
        <Harness mcpProfile={saved} workspace={workspaceFor(row, OFF)} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expectSameGuest(loads);
      // A save that changes nothing the App sees: only a new snapshot.
      view.rerender(
        <Harness
          mcpProfile={structuredClone(saved)}
          workspace={workspaceFor(row, OFF)}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expectSameGuest(loads);
      // Switching them back on doesn't rebuild it either.
      view.rerender(
        <Harness mcpProfile={profile()} workspace={workspaceFor(row)} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expectSameGuest(loads);
    });

  it("delivers a theme change as host context, never a new bridge", async () => {
    const { row, view } = await openAndInitialize("global");
    const loads = f.loads.length;
    f.bridges[0].setHostContext.mockClear();
    stores.preferences = { ...stores.preferences, themeMode: "dark" };
    view.rerender(
      <Harness mcpProfile={profile()} workspace={workspaceFor(row)} />,
    );
    await waitFor(() =>
      expect(f.bridges[0].setHostContext).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "dark" }),
      ),
    );
    expectSameGuest(loads);
  });

  it("refuses a local file request once Opening local files is off, without reloading the App", async () => {
    const { row, view } = await openAndInitialize("global");
    const loads = f.loads.length;
    const [, handler] = f.bridges[0].setRequestHandler.mock.calls.find(
      ([schema]: [{ shape: { method: { value: string } } }]) =>
        schema.shape.method.value === "openai/files/open",
    );
    view.rerender(
      <Harness mcpProfile={profile()} workspace={workspaceFor(row, OFF)} />,
    );
    await expect(
      handler(
        { method: "openai/files/open", params: { path: "/parts/a.step" } },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('the "Opening local files" extension is turned off');
    expect(ports.api.resolveLocalFile).not.toHaveBeenCalled();
    expectSameGuest(loads);
  });
});

describe("an open App when the client's binding or switch changes", () => {
  const identity = { actorId: "user", projectId: "project", hostId: "client" };
  const server = { serverId: "saved", name: "Saved server" };
  const library = {
    toolName: "library",
    title: "Library",
    kind: "global" as const,
  };
  let owners: ReturnType<typeof useExtensionOwners> = {
    global: null,
    chat: null,
  };
  let opened = 0;
  const noIcons = new Map();
  const pluginNames = new Map([["bits", "Bits & Bolts"]]);
  function Center({
    registration,
  }: {
    registration: ExtensionRegistration | null;
  }) {
    useExtensionRegistration(registration, {
      sendMessage: async () => true,
      runOnboarding: async () => {},
    });
    usePublishPluginIcons(noIcons, pluginNames);
    owners = useExtensionOwners();
    return null;
  }
  function Takeover() {
    return <div ref={useExtensionSlot("takeover")} />;
  }
  function Rail() { return <div ref={useExtensionSlot("rail")} />; }
  const playground = (registration: ExtensionRegistration | null) => (
    <ActiveMcpProfileProvider value={profile()}>
      <ExtensionWorkspaceProvider>
        <Center registration={registration} />
        <Takeover />
      </ExtensionWorkspaceProvider>
    </ActiveMcpProfileProvider>
  );
  const registration = (
    overrides: Partial<ExtensionRegistration> = {},
  ): ExtensionRegistration => ({
    identity,
    chatId: "chat",
    servers: [server],
    hostRevision: "config-1",
    ...overrides,
  });
  beforeEach(() => {
    vi.clearAllMocks();
    f.bridges.length = 0;
    f.loads.length = 0;
    f.iframeMounts = 0;
    owners = { global: null, chat: null };
    opened = 0;
    f.appTools.enabled = false;
    host.discover.mockResolvedValue([library]);
    host.onboarding.mockResolvedValue({ available: false });
    host.open.mockImplementation(async () => {
      opened += 1;
      return {
        ...rowFor("global").handle,
        instanceToken: `token-${opened}`.padEnd(43, "x"),
        instanceId: `library-${opened}`,
        operationId: `operation-${opened}`,
      };
    });
    host.invoke.mockResolvedValue({ content: [] });
    host.close.mockResolvedValue(undefined);
    host.renew.mockResolvedValue({ expiresAt: Date.now() + 60_000 });
  });
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  async function openLibrary() {
    const view = render(playground(registration()));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => {
      await owners.global!.launch(server, library);
    });
    await waitFor(() =>
      expect(f.bridges[0]?.oninitialized).toBeTypeOf("function"),
    );
    act(() => f.bridges[0].oninitialized());
    await waitFor(() =>
      expect(screen.getByTestId("sandboxed-iframe").style.opacity).toBe("1"),
    );
    return view;
  }

  it("routes a global App's mapped file into the opening chat's live tool catalog", async () => {
    f.appTools.enabled = true;
    let registry: ReturnType<typeof useAppToolsRegistryApi>;
    function Capture() { registry = useAppToolsRegistryApi(); return null; }
    host.open.mockImplementation(async (_server: string, tool: string) => ({
      ...rowFor("global").handle,
      instanceToken: tool.padEnd(43, "x"), instanceId: tool, operationId: tool,
      appToolsEnabled: true, localFilesAvailable: true,
      ...(tool === "viewer" ? { file: { name: "keycap.stl", resourceUri: "host-resource://keycap" } } : {}),
    }));
    host.resolveLocalFile.mockResolvedValue([{ kind: "file", toolName: "viewer", title: "Viewer", resourceUri: "host-resource://keycap" }]);
    const scene = (chatId: string) => <WidgetWorkspaceProvider workspaceId="shared-model-tools">
      <Capture />
      <ActiveMcpProfileProvider value={profile({ mcpAppsOverrides: { serverTools: true, availableDisplayModes: ["inline", "fullscreen"] } })}>
        <ExtensionWorkspaceProvider>
          <Center registration={registration({ chatId })} /><Takeover /><Rail />
        </ExtensionWorkspaceProvider>
      </ActiveMcpProfileProvider>
    </WidgetWorkspaceProvider>;
    const view = render(scene("chat-a"));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => { await owners.global!.launch(server, library); });
    await waitFor(() => expect(f.bridges).toHaveLength(1));
    act(() => f.bridges[0].oninitialized());
    const handler = f.bridges[0].setRequestHandler.mock.calls.find(
      ([schema]: [{ shape: { method: { value: string } } }]) => schema.shape.method.value === "openai/files/open",
    )?.[1];
    expect(handler).toBeTypeOf("function");
    await act(async () => { await handler({ method: "openai/files/open", params: { path: "/mapped/keycap.stl" } }, { signal: new AbortController().signal }); });
    await waitFor(() => expect(f.bridges).toHaveLength(2));
    act(() => f.bridges[1].oninitialized());
    await waitFor(() => expect(registry!.getState().snapshotForChatBody("chat-a")).toHaveLength(2));
    const snapshots = registry!.getState().snapshotForChatBody("chat-a");
    expect(snapshots.find((entry) => entry.parentToolCallId === "viewer")?.description).toContain("File viewer: keycap.stl");
    expect(owners.global?.apps.map((row) => row.declaration.kind)).toEqual(["global"]);
    expect(owners.global?.active).toBeNull();
    expect(owners.chat?.apps.map((row) => row.declaration.kind)).toEqual(["file"]);
    await act(async () => { await handler({ method: "openai/files/open", params: { path: "/mapped/keycap.stl" } }, { signal: new AbortController().signal }); });
    expect(registry!.getState().snapshotForChatBody("chat-a").map((entry) => entry.alias)).toEqual(snapshots.map((entry) => entry.alias));
    view.rerender(scene("chat-b"));
    await waitFor(() => expect(owners.chat?.scope?.threadId).toBe("chat-b"));
    const current = registry!.getState().snapshotForChatBody("chat-b");
    expect(current.map((entry) => entry.parentToolCallId)).toEqual(["library"]);
    expect(registry!.getState().snapshotForChatBody("chat-a").map((entry) => entry.parentToolCallId)).toEqual(["viewer"]);
    expect(host.open).toHaveBeenCalledTimes(2);
    expect(f.bridges).toHaveLength(2);
    expect(f.bridges.every((bridge) => bridge.close.mock.calls.length === 0)).toBe(true);
    view.unmount();
    await waitFor(() => expect(registry!.getState().snapshotForChatBody("chat-a")).toEqual([]));
  });

  it("shows the plugin manifest name in the global header without changing the server key", async () => {
    const imported = { ...server, name: "bits-and-bolts:server:bits-and-bolts@2cc7fa5b" };
    render(playground(registration({ servers: [imported] })));
    await waitFor(() => expect(owners.global?.entries.saved).toBeDefined());
    await act(async () => { await owners.global!.launch(imported, library); });
    expect(screen.getByText("Bits & Bolts")).toBeDefined();
    expect(owners.global!.apps[0].server).toEqual(imported);
    expect(host.open.mock.calls[0][0]).toBe("saved");
  });

  it("unmounts the App when the extensions switch goes off, leaving no hidden iframe", async () => {
    const view = await openLibrary();
    view.rerender(playground(registration({ identity: null })));
    await waitFor(() =>
      expect(screen.queryByTestId("sandboxed-iframe")).toBeNull(),
    );
    expect(f.bridges[0].close).toHaveBeenCalled();
    await waitFor(() => expect(host.close).toHaveBeenCalledTimes(1));
  });

  it("reopens the App cleanly when the client's identity changed under it", async () => {
    const view = await openLibrary();
    host.renew.mockRejectedValueOnce(
      new ThreadAppError("INSTANCE_HOST_CHANGED"),
    );
    view.rerender(playground(registration({ hostRevision: "config-2" })));
    // A fresh activation, in a fresh guest: never the old one hidden.
    await waitFor(() => expect(f.bridges).toHaveLength(2));
    expect(f.bridges[0].close).toHaveBeenCalled();
    expect(host.close).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(f.bridges[1].oninitialized).toBeTypeOf("function"),
    );
    act(() => f.bridges[1].oninitialized());
    await waitFor(() => {
      const iframes = screen.getAllByTestId("sandboxed-iframe");
      expect(iframes).toHaveLength(1);
      expect(iframes[0].style.opacity).toBe("1");
    });
    expect(owners.global?.apps[0].handle?.instanceId).toBe("library-2");
  });
});

describe("a model App with pending user input", () => {
  const marker = {
    instanceToken: "m".repeat(43), projectId: "project", hostId: "client",
    workspaceId: "workspace", serverId: "saved",
  };
  const handle = { ...rowFor("thread").handle, instanceToken: marker.instanceToken, appToolsEnabled: true };
  const open = vi.fn(async () => {});
  const actions = (): WorkspaceFileActions => ({
    workspaceId: "workspace", api: host as never, serverIds: ["saved"], open,
  });
  const model = (files = actions()) => <ActiveMcpProfileProvider value={profile({ mcpAppsOverrides: { serverTools: true } })}>
    <WorkspaceFileActionsProvider value={files}>
      <OwnedModelApp marker={marker} renderProps={{
        toolCallId: "model-call", toolName: "library", serverId: "saved",
        resourceUri: "ui://library", toolState: "output-available", chatSessionId: "chat",
      }} />
    </WorkspaceFileActionsProvider>
  </ActiveMcpProfileProvider>;

  beforeEach(() => {
    f.bridges.length = 0;
    f.loads.length = 0;
    f.ctor.mockClear();
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(handle)));
    host.close.mockResolvedValue(undefined);
    host.renew.mockResolvedValue({ expiresAt: Date.now() + 30 * 60_000 });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("keeps the same bridge request through file-action churn, context updates and renewal, then cancels on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    host.invoke.mockImplementation(async (_handle, active, _approve, _call, inputPending) => {
      signal = active;
      inputPending(true);
      try {
        await new Promise<void>((resolve, reject) => {
          finish = resolve;
          active.addEventListener("abort", () => reject(new Error("owner closed")), { once: true });
        });
        return { content: [] };
      } finally { inputPending(false); }
    });
    const view = render(model());
    await waitFor(() => expect(f.bridges).toHaveLength(1));
    const bridge = f.bridges[0];
    act(() => bridge.oninitialized());
    const invoke = () => bridge.oncalltool(
      { name: "pickReferences", arguments: {} },
      { signal: bridge.requests.signal, requestId: 1 },
    );
    const pending = invoke();
    await waitFor(() => expect(signal).toBeDefined());
    const loads = f.loads.length;
    stores.hostContext.draftHostContext = { locale: "en-GB" };
    view.rerender(model());
    await act(async () => { await Promise.resolve(); });
    expect(f.bridges).toHaveLength(1);
    expect(bridge.close).not.toHaveBeenCalled();
    expect(signal!.aborted).toBe(false);
    expect(f.loads).toHaveLength(loads);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(host.renew).toHaveBeenCalledWith(handle, expect.any(AbortSignal));
    expect(f.bridges).toHaveLength(1);
    expect(signal!.aborted).toBe(false);
    await act(async () => { finish!(); await pending; });
    const closing = invoke();
    const cancelled = expect(closing).rejects.toThrow("owner closed");
    view.unmount();
    await cancelled;
    expect(signal!.aborted).toBe(true);
    expect(host.close).toHaveBeenCalled();
  });
});
