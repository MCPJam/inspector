import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRegistration } from "../ThreadAppPanel";
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
  it("does not register again for fresh presentation callbacks and delivers to the current callback", () => {
    fixture.upsert.mockClear();
    const props = {
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
        declaration: { kind: "file", toolName: "open" },
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
    registered.onDisplayModeChange("fullscreen");
    registered.onAppSupportedDisplayModesChange(["inline", "fullscreen"]);
    expect(currentMode).toHaveBeenCalledWith("fullscreen");
    expect(currentSupported).toHaveBeenCalledWith(["inline", "fullscreen"]);
    expect(props.onDisplayModeChange).not.toHaveBeenCalled();
    const initialHost = fixture.upsert.mock.calls[0][3];
    rerender(<AppRegistration {...props} displayMode="fullscreen" />);
    expect(fixture.upsert).toHaveBeenCalledTimes(2);
    const changedHost = fixture.upsert.mock.calls[1][3];
    expect(changedHost.services).toBe(initialHost.services);
    expect(changedHost.resolvers).toBe(initialHost.resolvers);
    expect(changedHost).toBe(initialHost);
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
