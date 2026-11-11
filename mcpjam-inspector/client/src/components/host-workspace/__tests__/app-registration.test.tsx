import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRegistration } from "../ThreadAppPanel";
import { ALL_EXTENSION_CAPABILITIES } from "../extension-owners";
const fixture = vi.hoisted(() => ({
  context: vi.fn(),
  log: vi.fn(),
  upsert: vi.fn(),
  workspace: {
    workspaceId: "disposable",
    surfaces: { getState: () => ({ upsertRegistration: fixture.upsert }) },
  },
}));
vi.mock("../thread-app-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../thread-app-api")>();
  return {
    ...original,
    createThreadAppApi: (
      ...args: Parameters<typeof original.createThreadAppApi>
    ) => ({
      ...original.createThreadAppApi(...args),
      context: fixture.context,
    }),
  };
});
vi.mock("../extension-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extension-log")>()),
  logExtensionEvent: fixture.log,
}));
vi.mock("@mcpjam/widget-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/widget-react")>()),
  useWidgetWorkspace: () => fixture.workspace,
  WidgetWorkspaceProvider: () => null,
  WidgetWorkspaceSurfaceHost: () => null,
  closeWorkspaceSurface: vi.fn(),
  useWidgetSurfaceAdmissionError: () => null,
}));
vi.mock("@/components/chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({}),
}));
vi.mock("@/components/tools/ResultsPanel", () => ({
  ResultsPanel: () => null,
}));
afterEach(cleanup);
describe("retained App registration", () => {
  it.each(["global", "thread", "file", "quick-action"] as const)(
    "keeps %s tools in their target conversation without re-registering the App",
    (kind) => {
      fixture.upsert.mockClear();
      let currentChat = "chat-a";
      const props = {
        currentThreadId: () => currentChat,
        scope: {
          projectId: "p",
          hostId: "h",
          threadId: "t",
          pluginWorkspace: { version: 1, workspaceId: "w" },
        },
        publishContext: vi.fn(),
        row: {
          key: "k",
          status: "live",
          server: { serverId: "s", name: "Disposable" },
          declaration: { kind, toolName: "open" },
          abort: new AbortController(),
          handle: {
            instanceId: "i",
            instanceToken: "token",
            operationId: "op",
            appToolsEnabled: false,
          },
          result: { content: [] },
        },
        navigate: vi.fn(),
        openFile: vi.fn(),
        api: {},
        approve: vi.fn(),
        signal: new AbortController().signal,
        host: { environment: {}, surface: {}, resolvers: {}, services: {} },
        displayMode: "inline",
        onDisplayModeChange: vi.fn(),
        onAppSupportedDisplayModesChange: vi.fn(),
      } as unknown as Parameters<typeof AppRegistration>[0];
      const { rerender } = render(<AppRegistration {...props} />);
      const currentMode = vi.fn();
      const currentSupported = vi.fn();
      for (let i = 0; i < 5; i++)
        rerender(
          <AppRegistration
            {...props}
            navigate={vi.fn()}
            openFile={vi.fn()}
            approve={vi.fn()}
            onDisplayModeChange={currentMode}
            onAppSupportedDisplayModesChange={currentSupported}
          />,
        );
      expect(fixture.upsert).toHaveBeenCalledTimes(1);
      const registered = fixture.upsert.mock.calls[0][2];
      expect(registered.chatSessionId).toBe("disposable");
      expect(registered.getModelChatSessionId()).toBe(
        kind === "global" ? "chat-a" : "t",
      );
      currentChat = "chat-b";
      expect(registered.getModelChatSessionId()).toBe(
        kind === "global" ? "chat-b" : "t",
      );
      expect(fixture.upsert).toHaveBeenCalledTimes(1);
      registered.onDisplayModeChange("fullscreen");
      registered.onAppSupportedDisplayModesChange(["inline", "fullscreen"]);
      expect(currentMode).toHaveBeenCalledWith("fullscreen");
      expect(currentSupported).toHaveBeenCalledWith(["inline", "fullscreen"]);
      expect(props.onDisplayModeChange).not.toHaveBeenCalled();
      rerender(<AppRegistration {...props} currentThreadId={undefined} />);
      expect(registered.getModelChatSessionId()).toBe("t");
      expect(fixture.upsert).toHaveBeenCalledTimes(1);
      const initialHost = fixture.upsert.mock.calls[0][3];
      rerender(<AppRegistration {...props} displayMode="fullscreen" />);
      expect(fixture.upsert).toHaveBeenCalledTimes(2);
      const changedHost = fixture.upsert.mock.calls[1][3];
      expect(changedHost.services).toBe(initialHost.services);
      expect(changedHost.resolvers).toBe(initialHost.resolvers);
      expect(changedHost).toBe(initialHost);
    },
  );
});

describe("an entrypoint App's display modes", () => {
  const OPENAI_RULES = { hints: "openai/ui", start: "hint-first" } as const;
  const props = (
    capabilities?: Record<string, boolean>,
    displayBehavior: unknown = OPENAI_RULES,
  ) =>
    ({
      scope: {
        projectId: "p",
        hostId: "h",
        threadId: "t",
        pluginWorkspace: { version: 1, workspaceId: "w" },
      },
      publishContext: vi.fn(),
      row: {
        key: "k",
        status: "live",
        server: { serverId: "s", name: "Disposable" },
        declaration: { kind: "global", toolName: "open", title: "Library" },
        abort: new AbortController(),
        handle: {
          instanceId: "i",
          instanceToken: "token",
          operationId: "op",
          appToolsEnabled: false,
        },
        result: { content: [] },
      },
      navigate: vi.fn(),
      openFile: vi.fn(),
      api: {},
      approve: vi.fn(),
      signal: new AbortController().signal,
      host: { environment: {}, surface: {}, resolvers: {}, services: {} },
      displayMode: "fullscreen",
      onDisplayModeChange: vi.fn(),
      onAppSupportedDisplayModesChange: vi.fn(),
      ...(capabilities ? { capabilities } : {}),
      ...(displayBehavior ? { displayBehavior } : {}),
    }) as unknown as Parameters<typeof AppRegistration>[0];

  it("follows OpenAI's rules and logs an App that can't show fullscreen", () => {
    fixture.upsert.mockClear();
    fixture.log.mockClear();
    render(<AppRegistration {...props()} />);
    const [, , registered, host] = fixture.upsert.mock.calls[0];
    expect(host.surface.displayBehavior).toEqual(OPENAI_RULES);
    registered.onAppSupportedDisplayModesChange(["inline", "fullscreen"]);
    expect(fixture.log).not.toHaveBeenCalled();
    registered.onAppSupportedDisplayModesChange(["inline"]);
    expect(fixture.log).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "s",
        label: "display-mode",
        level: "error",
        message: expect.stringContaining("doesn't support full screen"),
      }),
    );
  });

  it("keeps the previous behaviour when the Display modes toggle is off", () => {
    fixture.upsert.mockClear();
    fixture.log.mockClear();
    const capabilities = Object.fromEntries(
      Object.keys(ALL_EXTENSION_CAPABILITIES).map((key) => [key, true]),
    );
    render(
      <AppRegistration
        {...props({ ...capabilities, displayModes: false }, null)}
      />,
    );
    const [, , registered, host] = fixture.upsert.mock.calls[0];
    expect(host.surface.displayBehavior).toBeUndefined();
    registered.onAppSupportedDisplayModesChange(["inline"]);
    expect(fixture.log).not.toHaveBeenCalled();
  });

  const withRow = (
    base: Parameters<typeof AppRegistration>[0],
    row: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      ...base,
      ...extra,
      row: { ...base.row, ...row },
    }) as Parameters<typeof AppRegistration>[0];

  it("hands a global App without fullscreen back only when its owner can open it another way", () => {
    const port = vi.fn();
    const registered = (row: Record<string, unknown>, extra = {}) => {
      fixture.upsert.mockClear();
      render(<AppRegistration {...withRow(props(), row, extra)} />);
      const call = fixture.upsert.mock.calls[0];
      cleanup();
      return { params: call[2], host: call[3] };
    };
    const global = registered({}, { fullscreenUnsupported: port });
    global.params.onFixedDisplayModeUnsupported(["inline"]);
    expect(port).toHaveBeenCalledExactlyOnceWith("k");
    expect(global.host.surface.fixedDisplayMode).toBe("fullscreen");
    // No port: the App is refused as before.
    expect(registered({}).params.onFixedDisplayModeUnsupported).toBeUndefined();
    // Not a global App, or already inline: nothing to hand back.
    expect(
      registered(
        { declaration: { kind: "thread", toolName: "open", title: "Library" } },
        { fullscreenUnsupported: port },
      ).params.onFixedDisplayModeUnsupported,
    ).toBeUndefined();
    const inline = registered(
      { inline: true },
      { fullscreenUnsupported: port, displayMode: "inline" },
    );
    expect(inline.params.onFixedDisplayModeUnsupported).toBeUndefined();
    expect(inline.params.displayMode).toBe("inline");
    expect(inline.host.surface.fixedDisplayMode).toBe("inline");
  });

  it("never logs the fullscreen refusal for an inline App", () => {
    fixture.upsert.mockClear();
    fixture.log.mockClear();
    render(
      <AppRegistration
        {...withRow(props(), { inline: true }, { displayMode: "inline" })}
      />,
    );
    const [, , registered] = fixture.upsert.mock.calls[0];
    registered.onAppSupportedDisplayModesChange(["inline"]);
    expect(fixture.log).not.toHaveBeenCalled();
  });

  it("doesn't refuse an App without full screen under Claude's rules", () => {
    fixture.upsert.mockClear();
    fixture.log.mockClear();
    const claude = { hints: "ui", start: "inline-then-move" };
    render(<AppRegistration {...props(undefined, claude)} />);
    const [, , registered, host] = fixture.upsert.mock.calls[0];
    expect(host.surface.displayBehavior).toEqual(claude);
    registered.onAppSupportedDisplayModesChange(["inline"]);
    expect(fixture.log).not.toHaveBeenCalled();
  });
});

describe("per-extension toggles on a retained App", () => {
  const policy = {
    environment: { draftHostContext: {} },
    surface: {},
    services: {},
    resolvers: {
      resolveEffectiveHostCapabilities: () => ({
        message: {},
        updateModelContext: {},
      }),
      resolveEffectiveMcpAppsCapabilities: () => ({
        availableDisplayModes: ["fullscreen"],
        message: true,
        updateModelContext: true,
        hostContextChanged: true,
      }),
      resolveEffectiveCompatRuntime: () => ({ injected: false }),
    },
  };
  const props = (capabilities: Record<string, boolean>) =>
    ({
      scope: {
        projectId: "p",
        hostId: "h",
        threadId: "t",
        pluginWorkspace: { version: 1, workspaceId: "w" },
      },
      publishContext: vi.fn(),
      sendMessage: vi.fn(),
      row: {
        key: "k",
        status: "live",
        server: { serverId: "s", name: "Disposable" },
        declaration: { kind: "thread", toolName: "open" },
        abort: new AbortController(),
        handle: {
          instanceId: "i",
          instanceToken: "token",
          operationId: "op",
          appToolsEnabled: false,
          contextEnabled: true,
          messageEnabled: true,
          resourceUri: "ui://app",
          widgetContent: { html: "app" },
        },
        result: { content: [] },
      },
      navigate: vi.fn(),
      openFile: vi.fn(),
      api: {},
      approve: vi.fn(),
      signal: new AbortController().signal,
      host: policy,
      displayMode: "fullscreen",
      onDisplayModeChange: vi.fn(),
      onAppSupportedDisplayModesChange: vi.fn(),
      capabilities: {
        sidebarApps: true,
        conversationPanels: true,
        fileViewers: true,
        fileResources: true,
        localFiles: true,
        settings: true,
        displayModes: true,
        deepLinks: true,
        modelContext: true,
        messages: true,
        mentions: true,
        forms: true,
        onboarding: true,
        ...capabilities,
      },
    }) as unknown as Parameters<typeof AppRegistration>[0];
  const experimental = () =>
    fixture.upsert.mock.calls
      .at(-1)![3]
      .resolvers.resolveEffectiveHostCapabilities({ hostStyle: "chatgpt" })
      .experimental ?? {};

  it("keeps the extensions it opened with and refuses switched-off ones per request", async () => {
    fixture.upsert.mockClear();
    fixture.log.mockClear();
    const view = render(<AppRegistration {...props({})} />);
    const opened = fixture.upsert.mock.calls.at(-1)![3];
    expect(Object.keys(experimental()).sort()).toEqual([
      "openai/message",
      "openai/modelContext",
    ]);
    view.rerender(
      <AppRegistration {...props({ messages: false, modelContext: false })} />,
    );
    // Advertising less would mean a new bridge under the running guest.
    expect(Object.keys(experimental()).sort()).toEqual([
      "openai/message",
      "openai/modelContext",
    ]);
    const host = fixture.upsert.mock.calls.at(-1)![3];
    expect(host.services).toBe(opened.services);
    expect(host.resolvers).toBe(opened.resolvers);
    // The App is told its context is cleared, and its requests are refused
    // with a plain reason in the Logs.
    expect(host.environment.draftHostContext["openai/modelContext"]).toBeNull();
    await expect(
      host.services.sendMessage({ role: "user", content: [] }),
    ).rejects.toThrow('the "Messages" extension is turned off');
    await expect(host.services.updateModelContext({})).rejects.toThrow(
      'the "Model context" extension is turned off',
    );
    expect(fixture.log).toHaveBeenCalledTimes(2);
    expect(fixture.log.mock.calls[0][0]).toMatchObject({
      serverId: "s",
      label: "capability",
      level: "warning",
    });
    // The same surface stays registered: nothing closes.
    expect(fixture.upsert.mock.calls.every((call) => call[0] === "i")).toBe(
      true,
    );
  });

  it("publishes an unconfirmed Remove all as detached, not as an empty chip", async () => {
    fixture.context.mockReset().mockRejectedValue(new Error("unavailable"));
    const base = props({});
    const publishContext = vi.fn();
    const state = {
      updateId: "u1",
      content: [{ type: "text", text: "Selected view" }],
    };
    render(
      <AppRegistration
        {...base}
        publishContext={publishContext}
        row={{
          ...base.row,
          handle: {
            ...base.row.handle!,
            contextSnapshot: { revision: 1, sequence: 1, state },
          },
        }}
      />,
    );
    const [, shown, options] = publishContext.mock.calls.at(-1)!;
    expect(shown).toHaveLength(1);
    expect(options).toEqual({ detached: false });
    await act(async () => {
      shown[0].group.removeAll();
    });
    await waitFor(() =>
      expect(publishContext.mock.calls.at(-1)).toEqual([
        "token",
        [],
        { detached: true },
      ]),
    );
  });

  it("never advertises an extension that was off when the App opened", () => {
    fixture.upsert.mockClear();
    const view = render(
      <AppRegistration {...props({ messages: false, modelContext: false })} />,
    );
    expect(experimental()).toEqual({});
    view.rerender(<AppRegistration {...props({})} />);
    expect(experimental()).toEqual({});
  });
});

describe("file viewer and quick-action Apps (T1)", () => {
  it("get context, messages and links when their own handle grants them", () => {
    fixture.upsert.mockClear();
    const policy = {
      environment: { draftHostContext: {} },
      surface: {},
      services: {},
      resolvers: {
        resolveEffectiveHostCapabilities: () => ({
          message: {},
          updateModelContext: {},
          openLinks: {},
        }),
        resolveEffectiveMcpAppsCapabilities: () => ({
          availableDisplayModes: ["fullscreen"],
          message: true,
          updateModelContext: true,
          hostContextChanged: true,
          openLinks: true,
        }),
        resolveEffectiveCompatRuntime: () => ({ injected: false }),
      },
    };
    for (const kind of ["file", "quick-action"]) {
      render(
        <AppRegistration
          {...({
            scope: {
              projectId: "p",
              hostId: "h",
              threadId: "t",
              pluginWorkspace: { version: 1, workspaceId: "w" },
            },
            publishContext: vi.fn(),
            sendMessage: vi.fn(),
            row: {
              key: kind,
              status: "live",
              server: { serverId: "s", name: "Disposable" },
              declaration: { kind, toolName: "open", resourceUri: "cad://p" },
              abort: new AbortController(),
              handle: {
                instanceId: kind,
                instanceToken: `${kind}-token`,
                operationId: "op",
                appToolsEnabled: false,
                contextEnabled: true,
                messageEnabled: true,
                deepLinkNamespace: { pluginId: "p", runtime: "chatgpt" },
                resourceUri: "ui://app",
                widgetContent: { html: "app" },
              },
              result: { content: [] },
            },
            navigate: vi.fn(),
            openFile: vi.fn(),
            api: {},
            approve: vi.fn(),
            signal: new AbortController().signal,
            host: policy,
            displayMode: "fullscreen",
            onDisplayModeChange: vi.fn(),
            onAppSupportedDisplayModesChange: vi.fn(),
          } as unknown as Parameters<typeof AppRegistration>[0])}
        />,
      );
      const host = fixture.upsert.mock.calls.at(-1)![3];
      const matrix = host.resolvers.resolveEffectiveMcpAppsCapabilities({
        hostStyle: "chatgpt",
      });
      expect([matrix.updateModelContext, matrix.message, matrix.openLinks]).toEqual(
        [true, true, true],
      );
      expect(typeof host.services.updateModelContext).toBe("function");
      expect(typeof host.services.sendMessage).toBe("function");
      expect(typeof host.services.openAppLink).toBe("function");
      cleanup();
    }
  });
});
