import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createHostAppBridge,
  registerHostBridgeHandlers,
} from "@mcpjam/sdk/widget-runtime";
const state = vi.hoisted(() => ({
  rows: [] as unknown[] | undefined,
  fetch: vi.fn(),
  mutate: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: state.mutate }),
  useQuery: (name: string, args: unknown) =>
    name === "users:getCurrentUser"
      ? { _id: "actor" }
      : args === "skip"
        ? undefined
        : state.rows,
}));
vi.mock("@/lib/session-token", () => ({ authFetch: state.fetch }));
vi.mock("@/lib/apis/web/base", () => ({ webPost: state.upload }));
import { OwnedPluginFormHost } from "../OwnedPluginFormHost";
import { createThreadAppApi } from "../../host-workspace/thread-app-api";
import {
  __resetComposerFormStore,
  useComposerFormStore,
} from "../composer-form-store";
const scope = {
  projectId: "p",
  hostId: "h",
  threadId: "global",
  pluginWorkspace: { version: 1 as const, workspaceId: "w" },
};
const handle = {
  instanceToken: "a".repeat(43),
  instanceId: "instance",
  generation: 1,
  operationId: "activation",
  resourceUri: "ui://app",
  toolTitle: "App",
  appToolsEnabled: true,
  widgetContent: { html: "" },
  serverId: "s",
};
afterEach(() => {
  __resetComposerFormStore();
  vi.useRealTimers();
  vi.resetAllMocks();
  state.rows = [];
});
const ui = (active = true) => (
  <OwnedPluginFormHost
    projectId="p"
    workspaceId="w"
    retainWhileLoading
    active={active}
    presentServices={(_request, show) =>
      show({
        profile: {
          origin: "mcp-app",
          userResources: false,
          fileResources: false,
          previews: false,
        },
      })
    }
  />
);
const cases = [
  { label: "matching virtual", foreign: false, wall: false },
  { label: "foreign virtual", foreign: true, wall: false },
  ...(process.env.RUN_SLOW_PLUGIN_PROGRESS === "1"
    ? [{ label: "matching wall", foreign: false, wall: true }]
    : []),
];
it.each(cases)(
  "keeps only the matching App alive through hidden legacy input: $label",
  async ({ foreign, wall }) => {
    let finish!: (response: Response) => void;
    let operation: Record<string, unknown>;
    let answer: unknown;
    state.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/renew")) return Response.json({});
      if (url.endsWith("/services"))
        return Response.json({
          userResources: false,
          userResourceKinds: [],
          operation,
        });
      if (url.endsWith("/call")) {
        operation = {
          projectId: "p",
          workspaceId: "w",
          instanceId: foreign ? "another-instance" : handle.instanceId,
          generation: 1,
          serverId: "s",
          invocationId: body.invocationId,
          expiresAt: Date.now() + 300000,
        };
        state.rows = [
          {
            rendezvousId: "r",
            serverId: "s",
            serverName: "App",
            mode: "form",
            formDialect: "openai",
            pluginWorkspaceId: "w",
            pluginFormSourceToken: "b".repeat(43),
            expiresAt: Date.now() + 300000,
            message: "Legacy review",
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
      throw new Error("Unexpected host request");
    });
    state.upload.mockImplementation(async (_url, body) => {
      answer = body;
      return { ok: true, storageId: "receipt" };
    });
    state.mutate.mockImplementation(async (_name, body) => {
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
    const api = createThreadAppApi(scope);
    const bridge = createHostAppBridge({
      hostInfo: { name: "host", version: "1" },
      hostCapabilities: { serverTools: {} },
    });
    registerHostBridgeHandlers(bridge, {
      effectiveHostCapabilities: { serverTools: {} },
      callbacks: {
        onCallTool: (name, args, context) =>
          api.invoke(
            handle,
            context!.signal,
            vi.fn(),
            { name, arguments: args },
            context!.onInputPending,
          ),
      },
    });
    const app = new App(
      { name: "app", version: "1" },
      {},
      { autoResize: false },
    );
    const [host, guest] = InMemoryTransport.createLinkedPair();
    const sent = vi.spyOn(host, "send");
    await bridge.connect(host);
    await app.connect(guest);
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
    const view = render(ui(false));
    let settled = false;
    const result = app.callServerTool({ name: "review" }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    try {
      await act(async () => {
        await advance(0);
        view.rerender(ui(false));
        await advance(0);
      });
      await vi.waitFor(() =>
        expect(
          useComposerFormStore.getState().forms[0]?.operation,
        ).toBeDefined(),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      const pendingRows = state.rows;
      state.rows = undefined;
      view.rerender(ui(false));
      await act(async () => advance(61000));
      state.rows = pendingRows;
      if (foreign) {
        expect(settled).toBe(true);
        expect(await result).toMatchObject({ error: { code: -32001 } });
        expect(state.mutate).not.toHaveBeenCalled();
        return;
      }
      expect(settled).toBe(false);
      expect(
        sent.mock.calls.filter(
          ([message]) =>
            "method" in message && message.method === "notifications/progress",
        ).length,
      ).toBeGreaterThanOrEqual(4);
      view.rerender(ui(true));
      const approved = screen.getByRole("checkbox", { name: /Approved/ });
      fireEvent.click(approved);
      fireEvent.click(approved);
      fireEvent.change(screen.getByRole("spinbutton", { name: /Tolerance/ }), {
        target: { value: "0" },
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Accept", exact: true }),
        );
        await advance(0);
      });
      expect(await result).toMatchObject({
        content: [{ text: '{"approved":false,"tolerance":0}' }],
      });
      expect(
        state.fetch.mock.calls.filter(([url]) => url.endsWith("/call")),
      ).toHaveLength(1);
      expect(state.mutate).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      await app.close();
      await bridge.close();
    }
  },
  70000,
);
