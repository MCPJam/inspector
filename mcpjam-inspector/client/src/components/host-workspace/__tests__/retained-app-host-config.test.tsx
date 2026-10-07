import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "0.0.0-test";

// A real renderer, bridge-free: the AppBridge and the sandbox iframe are
// stand-ins that count constructions, teardowns and guest document loads.
const f = vi.hoisted(() => {
  const bridges: Array<Record<string, any>> = [];
  const ctor = vi.fn().mockImplementation(() => {
    const bridge: Record<string, any> = {
      sendToolInput: vi.fn(),
      sendToolInputPartial: vi.fn(),
      sendToolResult: vi.fn(),
      sendToolCancelled: vi.fn(),
      setHostContext: vi.fn(),
      teardownResource: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      getAppCapabilities: vi.fn().mockReturnValue(undefined),
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      oninitialized: null,
    };
    bridges.push(bridge);
    return bridge;
  });
  return {
    bridges,
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
}));
vi.mock("../thread-app-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-app-api")>()),
  createThreadAppApi: () => ({
    ...host,
    discoverServer: async (serverId: string) => ({
      entries: await host.discover(serverId),
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
  type ExtensionRegistration,
} from "../ExtensionWorkspaceProvider";
import { ThreadAppError } from "../thread-app-api";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";

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
  function Center({
    registration,
  }: {
    registration: ExtensionRegistration | null;
  }) {
    useExtensionRegistration(registration, {
      sendMessage: async () => true,
      runOnboarding: async () => {},
    });
    owners = useExtensionOwners();
    return null;
  }
  function Takeover() {
    return <div ref={useExtensionSlot("takeover")} />;
  }
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
