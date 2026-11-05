import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, type ComponentProps, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createHostAppBridge,
  registerHostBridgeHandlers,
} from "@mcpjam/sdk/widget-runtime";
import type { MCPAppsRendererSurface } from "@mcpjam/widget-react";
const f = vi.hoisted(() => ({
  fetch: vi.fn(),
  mutate: vi.fn(),
  upload: vi.fn(),
  rows: [] as unknown[],
  app: undefined as App | undefined,
  close: undefined as (() => Promise<void>) | undefined,
  progress: 0,
}));
vi.mock("@/lib/session-token", () => ({ authFetch: f.fetch }));
vi.mock("@/lib/apis/web/base", () => ({ webPost: f.upload }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: f.mutate }),
  useQuery: (name: string, args: unknown) =>
    name === "users:getCurrentUser"
      ? { _id: "actor" }
      : args === "skip"
        ? undefined
        : f.rows,
}));
vi.mock("../../chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({
    environment: { draftHostContext: {} },
    surface: {},
    services: {},
    resolvers: {
      resolveEffectiveHostCapabilities: () => ({ serverTools: {} }),
      resolveEffectiveMcpAppsCapabilities: () => ({
        serverTools: true,
        availableDisplayModes: ["inline", "fullscreen"],
      }),
    },
  }),
}));
vi.mock("@mcpjam/widget-react", async (original) => ({
  ...(await original<object>()),
  WidgetHostProvider: ({ children }: { children: ReactNode }) => children,
  MCPAppsRendererSurface: function Bridge({
    onCallTool,
  }: ComponentProps<typeof MCPAppsRendererSurface>) {
    useEffect(() => {
      const bridge = createHostAppBridge({
        hostInfo: { name: "host", version: "1" },
        hostCapabilities: { serverTools: {} },
      });
      registerHostBridgeHandlers(bridge, {
        effectiveHostCapabilities: { serverTools: {} },
        callbacks: { onCallTool },
      });
      const app = new App(
        { name: "settings", version: "1" },
        {},
        { autoResize: false },
      );
      const [host, guest] = InMemoryTransport.createLinkedPair();
      const send = host.send.bind(host);
      host.send = (message, options) => {
        if ("method" in message && message.method === "notifications/progress")
          f.progress++;
        return send(message, options);
      };
      void bridge
        .connect(host)
        .then(() => app.connect(guest))
        .then(() => {
          f.app = app;
        });
      f.close = async () => {
        await app.close();
        await bridge.close();
      };
      return () => {
        void f.close?.();
      };
    }, []);
    return <span>Actual Settings bridge</span>;
  },
}));
import { useSignOutStore } from "@/stores/sign-out-store";
import { ServerSettingsPanel } from "../ServerSettingsPanel";
import { settingsFixture } from "@/shared/__tests__/plugin-settings-fixture";
import {
  __resetComposerFormStore,
  useComposerFormStore,
} from "../../elicitation/composer-form-store";
import { __resetHostedMrtrHostElection } from "../../elicitation/HostedMrtrHost";
const scope = {
  projectId: "p",
  hostId: "h",
  threadId: "t",
  pluginWorkspace: { version: 1 as const, workspaceId: "parent" },
};
afterEach(async () => {
  useSignOutStore.setState({ isSigningOut: false });
  cleanup();
  await f.close?.();
  f.close = undefined;
  f.app = undefined;
  __resetComposerFormStore();
  __resetHostedMrtrHostElection();
  vi.useRealTimers();
  vi.resetAllMocks();
  f.rows = [];
  f.progress = 0;
});
const cases = [
  { name: "virtual", wall: false, close: false, signOut: false },
  { name: "close pending", wall: false, close: true, signOut: false },
  { name: "sign out", wall: false, close: true, signOut: true },
  ...(process.env.RUN_SLOW_PLUGIN_PROGRESS === "1"
    ? [{ name: "wall", wall: true, close: false, signOut: false }]
    : []),
];
it.each(cases)(
  "retains the real Settings App input callback past 60s: $name",
  async ({ wall, close, signOut }) => {
    let finish!: (response: Response) => void;
    let operation: Record<string, unknown>;
    let answer: unknown;
    let calls = 0;
    let privateWorkspace = "";
    f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/renew")) return Response.json({ status: "prepared" });
      if (url.endsWith("/services"))
        return Response.json({
          userResources: false,
          userResourceKinds: [],
          operation,
        });
      if (url.endsWith("/open") && !url.includes("/app/")) {
        privateWorkspace = body.pluginWorkspace.workspaceId;
        return Response.json({
          instanceToken: "a".repeat(43),
          instanceId: "instance",
          generation: 1,
        });
      }
      if (url.endsWith("/read"))
        return Response.json({
          status: "completed",
          result: { content: [], structuredContent: settingsFixture() },
        });
      if (url.endsWith("/actions"))
        return Response.json({
          actions: [
            { name: "reset", kind: "app", title: "Review preferences" },
          ],
        });
      if (url.endsWith("/app/open"))
        return Response.json({
          childToken: "b".repeat(43),
          resourceUri: "ui://settings",
          widgetContent: { html: "" },
          appToolsEnabled: true,
        });
      if (url.endsWith("/action"))
        return Response.json({ status: "completed", result: { content: [] } });
      if (url.endsWith("/app/call")) {
        calls++;
        operation = {
          projectId: "p",
          workspaceId: privateWorkspace,
          instanceId: "instance",
          generation: 1,
          serverId: "s",
          invocationId: body.operationId,
          expiresAt: Date.now() + 300000,
        };
        f.rows = [
          {
            rendezvousId: "r",
            serverId: "s",
            serverName: "Settings",
            mode: "form",
            formDialect: "openai",
            pluginWorkspaceId: privateWorkspace,
            pluginFormSourceToken: "c".repeat(43),
            expiresAt: Date.now() + 300000,
            message: "Review preferences",
            requestedSchema: {
              type: "object",
              required: ["approved", "tolerance"],
              properties: {
                approved: { type: "boolean", title: "Approved" },
                tolerance: { type: "integer", title: "Tolerance", minimum: 0 },
              },
            },
          },
        ];
        return new Promise<Response>((resolve, reject) => {
          finish = resolve;
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }
      if (url.endsWith("/close")) return Response.json({ ok: true });
      throw new Error(`Unexpected route ${url}`);
    });
    f.upload.mockImplementation(async (_url, body) => {
      answer = body;
      return { ok: true, storageId: "receipt" };
    });
    f.mutate.mockImplementation(async (_name, body) => {
      expect(body).toMatchObject({
        rendezvousId: "r",
        action: "accept",
        contentBlobId: "receipt",
      });
      finish(
        Response.json({
          status: "completed",
          result: { content: [{ type: "text", text: JSON.stringify(answer) }] },
        }),
      );
      return { ok: true };
    });
    const ui = () => (
      <ServerSettingsPanel
        scope={{ ...scope, pluginWorkspace: { ...scope.pluginWorkspace } }}
        serverId="s"
        serverName="Settings"
      />
    );
    const view = render(ui());
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Review preferences" }),
      ).toBeDefined(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review preferences" }));
    await vi.waitFor(() => expect(f.app).toBeDefined());
    expect(privateWorkspace).not.toBe("parent");
    if (!wall)
      vi.useFakeTimers({
        toFake: [
          "Date",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
        ],
      });
    const advance = (ms: number) =>
      wall
        ? new Promise<void>((resolve) => setTimeout(resolve, ms))
        : vi.advanceTimersByTimeAsync(ms);
    let settled = false;
    const result = f.app!.callServerTool({ name: "review" }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    await act(async () => {
      await advance(0);
      view.rerender(ui());
      await advance(0);
    });
    await vi.waitFor(() =>
      expect(useComposerFormStore.getState().forms[0]?.operation).toBeDefined(),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    if (close) {
      if (signOut) act(() => useSignOutStore.setState({ isSigningOut: true }));
      else view.unmount();
      await act(async () => advance(0));
      expect(await result).toHaveProperty("error");
      expect(f.mutate).not.toHaveBeenCalled();
      expect(useComposerFormStore.getState().forms).toHaveLength(0);
    } else {
      await act(async () => advance(61000));
      expect(settled).toBe(false);
      expect(f.progress).toBeGreaterThanOrEqual(4);
      fireEvent.click(screen.getByRole("checkbox", { name: /Approved/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Approved/ }));
      fireEvent.click(screen.getByRole("button", { name: "Next question" }));
      fireEvent.change(screen.getByRole("spinbutton", { name: /Tolerance/ }), {
        target: { value: "0" },
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Continue", exact: true }),
        );
        await advance(0);
      });
      expect(await result).toMatchObject({
        content: [{ text: '{"approved":false,"tolerance":0}' }],
      });
      expect(f.mutate).toHaveBeenCalledOnce();
    }
    expect(calls).toBe(1);
  },
  70000,
);
