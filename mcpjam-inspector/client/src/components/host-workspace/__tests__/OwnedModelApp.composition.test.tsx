import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { createThreadAppApi } from "../thread-app-api";
import { WorkspaceFileActionsProvider } from "../file-actions";
import {
  OwnedModelApp,
  OwnedModelAppPortsProvider,
  useOwnedModelAppWorkspace,
} from "../OwnedModelApp";
import { useCompareLaneModelApps } from "../use-compare-lane-model-apps";
import { ALL_EXTENSION_CAPABILITIES, compareLaneWorkspace } from "../extension-owners";
import { HostedMrtrHost } from "../../elicitation/HostedMrtrHost";
import { registerComposerForm, registerComposerSlot } from "../../elicitation/composer-form-store";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";
import {
  ContextAttachmentChip,
  ContextGroupChip,
  groupContextAttachments,
} from "../../chat-v2/chat-input/attachments/context-attachment-chip";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  host: null as WidgetHost | null,
  renderCount: 0,
  mounted: 0,
  sourceEffects: 0,
  notifications: [] as unknown[],
  hosts: new Map<string, WidgetHost>(),
  pendingInputs: new Map<string, boolean>(),
  upload: vi.fn(),
}));
vi.mock("@/lib/apis/web/base", () => ({ webPost: mocks.upload, WebApiError: class extends Error {} }));
vi.mock("@/lib/apis/web/mrtr-api", async original => ({
  ...await original<typeof import("@/lib/apis/web/mrtr-api")>(),
  acknowledgeHostedMrtrContinuation: async () => {},
  cancelHostedMrtrContinuation: async () => {},
}));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.fetch }));
const policy = {
  environment: { draftHostContext: {} },
  surface: {},
  resolvers: {
    resolveEffectiveCompatRuntime: () => ({ injected: false }),
    resolveEffectiveHostCapabilities: () => ({
      serverTools: {},
      updateModelContext: {},
      message: {},
    }),
    resolveEffectiveMcpAppsCapabilities: () => ({
      serverTools: true,
      updateModelContext: true,
      message: true,
      hostContextChanged: true,
      availableDisplayModes: ["inline", "fullscreen"],
    }),
  },
} as unknown as WidgetHost;
vi.mock("../../chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => policy,
}));
// Replace only the iframe renderer. The owner, API, context controller, host
// composition, workspace publication and shared chip are real production code.
// Real bridge notification delivery is separately covered by Chromium tests.
vi.mock("@mcpjam/widget-react", async () => {
  const { createContext, useContext } = await import("react");
  const Host = createContext<WidgetHost | null>(null);
  return {
  ...await vi.importActual<typeof import("@mcpjam/widget-react")>("@mcpjam/widget-react"),
  WidgetHostProvider: ({
    value,
    children,
  }: {
    value: WidgetHost;
    children: import("react").ReactNode;
  }) => {
    mocks.host = value;
    return <Host.Provider value={value}>{children}</Host.Provider>;
  },
  MCPAppsRenderer: ({
    onCallTool,
    toolCallId,
    hostInputPending,
  }: {
    hostInputPending?: boolean;
    onCallTool: (name: string, args: object) => Promise<unknown>;
    toolCallId: string;
  }) => {
    const host = useContext(Host);
    mocks.pendingInputs.set(toolCallId, hostInputPending === true);
    const [answer, setAnswer] = useState("");
    if (host) mocks.hosts.set(toolCallId, host);
    mocks.renderCount++;
    if (mocks.renderCount > 40) throw new Error("Renderer publication loop");
    useEffect(() => {
      mocks.mounted++;
      void onCallTool("fixture.load", {}).catch(() => {});
    }, []);
    const context =
      host?.environment.draftHostContext?.["openai/modelContext"];
    useEffect(() => {
      mocks.notifications.push(context);
    }, [context]);
    return <>
      <div data-testid="guest-context">{JSON.stringify(context)}</div>
      <button onClick={async () => {
        try { setAnswer(JSON.stringify(await onCallTool("fixture.pick", {}))); }
        catch (error) { setAnswer(String(error)); }
      }}>Ask App form</button>
      <output data-testid="app-form-result">{answer}</output>
    </>;
  },
  };
});

const token = "b".repeat(43);
const updateId = "10000000-0000-4000-8000-000000000001";
const handle = {
  instanceToken: token,
  instanceId: "original-app",
  generation: 1,
  resourceUri: "ui://part",
  widgetContent: { html: "fixture" },
  toolMetadata: {},
  toolTitle: "Parts",
  appToolsEnabled: true,
  contextEnabled: true,
  messageEnabled: true,
  contextSnapshot: { revision: 0, sequence: 0, state: null },
};
const marker = {
  instanceToken: token,
  projectId: "project",
  workspaceId: "workspace",
  hostId: "host",
  serverId: "saved-server",
};
const params = {
  content: [
    {
      type: "text",
      text: "Selected triangle",
      _meta: { "openai/title": "Triangle" },
    },
  ],
};
const sendMessage = vi.fn(async () => true);
function Workspace({
  show = true,
  workspaceId = "workspace",
}: {
  show?: boolean;
  workspaceId?: string;
}) {
  const workspace = useOwnedModelAppWorkspace(sendMessage, {
    ...marker,
    workspaceId,
    key: `actor:${workspaceId}`,
  });
  const [hidden, setHidden] = useState(false);
  return (
    <OwnedModelAppPortsProvider value={workspace.value}>
      <button onClick={() => setHidden((value) => !value)}>
        Hide or reopen
      </button>
      <output data-testid="references">
        {JSON.stringify(workspace.references)}
      </output>
      {groupContextAttachments(workspace.attachments).map((entry) =>
        entry.kind === "group" ? (
          <ContextGroupChip
            key={entry.group.id}
            group={entry.group}
            items={entry.items}
          />
        ) : null,
      )}
      <div hidden={hidden}>
        {show && (
          <OwnedModelApp
            marker={marker}
            renderProps={{
              toolCallId: "original-call",
              toolName: "fixture.part",
              serverId: "saved-server",
              resourceUri: "ui://part",
              toolState: "output-available",
              chatSessionId: "thread",
            }}
          />
        )}
      </div>
    </OwnedModelAppPortsProvider>
  );
}
const reply = (value: unknown) => new Response(JSON.stringify(value));
function CompareModelLane({ lane, enabled = true }: { lane: string; enabled?: boolean }) {
  const pluginWorkspace = compareLaneWorkspace(
    { actorId: "actor", projectId: "project", hostId: "host" },
    "model", lane, `chat-${lane}`,
  );
  const scope = { projectId: "project", hostId: "host", threadId: `chat-${lane}`, pluginWorkspace };
  const workspace = useCompareLaneModelApps(scope, {
    ...ALL_EXTENSION_CAPABILITIES,
    modelContext: enabled,
  }, "codex");
  return <OwnedModelAppPortsProvider value={workspace.value}>
    <output data-testid={`references-${lane}`}>{JSON.stringify(workspace.references)}</output>
    <OwnedModelApp
      marker={{ ...marker, instanceToken: lane.repeat(43), workspaceId: pluginWorkspace.workspaceId }}
      renderProps={{ toolCallId: lane, toolName: "fixture.part", serverId: "saved-server", resourceUri: "ui://part", toolState: "output-available", chatSessionId: scope.threadId }}
    />
  </OwnedModelAppPortsProvider>;
}

it("owns two Compare model App contexts independently and closes only the removed lane", async () => {
  mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/renew")) return reply({});
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/model/open")) return reply({ ...handle, instanceToken: body.instanceToken });
    if (url.endsWith("/model/call")) return reply({ status: "completed", result: { content: [] } });
    if (url.endsWith("/model/context")) return reply({
      _meta: { "openai/modelContext": { updateId } },
      snapshot: { revision: body.sequence, sequence: body.sequence, state: { updateId, ...body.params } },
    });
    if (url.endsWith("/model/close")) return reply({ closed: true });
    throw new Error("Unexpected API path");
  });
  const lanes = (first = true, enabled = true) => <>
    {first && <CompareModelLane key="c" lane="c" />}
    <CompareModelLane key="d" lane="d" enabled={enabled} />
  </>;
  const view = render(lanes());
  await waitFor(() => expect(mocks.hosts.size).toBe(2));
  const first = mocks.hosts.get("c")!;
  const second = mocks.hosts.get("d")!;
  expect(first.surface.openAIDisplayModes).toBe(true);
  expect(first.services.sendMessage).toBeUndefined();
  await act(async () => {
    await first.services.updateModelContext!(params);
    await second.services.updateModelContext!({ content: [{ type: "text", text: "Other lane" }] });
  });
  expect(screen.getByTestId("references-c")).toHaveTextContent("c".repeat(43));
  expect(screen.getByTestId("references-c")).not.toHaveTextContent("d".repeat(43));
  expect(screen.getByTestId("references-d")).toHaveTextContent("d".repeat(43));
  expect(screen.getByTestId("references-d")).not.toHaveTextContent("c".repeat(43));
  view.rerender(lanes(false, false));
  expect(screen.getByTestId("references-d")).toHaveTextContent("[]");
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url, init]) =>
    url.endsWith("/model/close") && JSON.parse(init.body).instanceToken === "c".repeat(43),
  )).toBe(true));
  expect(mocks.fetch.mock.calls.some(([url, init]) =>
    url.endsWith("/model/close") && JSON.parse(init.body).instanceToken === "d".repeat(43),
  )).toBe(false);
  view.rerender(lanes(false));
  expect(screen.getByTestId("references-d")).toHaveTextContent("d".repeat(43));
  expect(mocks.mounted).toBe(2);
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.host = null;
  mocks.renderCount = 0;
  mocks.mounted = 0;
  mocks.sourceEffects = 0;
  mocks.notifications = [];
  mocks.hosts.clear();
  mocks.pendingInputs.clear();
  useHostedMrtrStore.getState().__reset();
});

function ModelFormWorkspace() {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (slot.current) return registerComposerSlot("workspace", slot.current);
  }, []);
  return <><Workspace /><div ref={slot} data-testid="owned-form-slot" /><HostedMrtrHost /></>;
}

it("opens a model App's admitted local file in its own workspace and withdraws the bridge on cleanup", async () => {
  const open = vi.fn(async () => {});
  const chooseViewer = vi.fn(async (entries: import("../thread-app-api").ThreadAppDeclaration[]) => entries[1]);
  const scope = { projectId: "project", hostId: "host", threadId: "thread", pluginWorkspace: { version: 1 as const, workspaceId: "workspace" } };
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/model/open")) return reply({ ...handle, localFilesAvailable: true });
    if (url.endsWith("/model/files/open")) return reply({ file: { uri: "cad://part", name: "part.stl" }, entries: [{ toolName: "viewer", title: "Viewer" }, { toolName: "other", title: "Other viewer" }] });
    if (url.endsWith("/model/call")) return reply({ status: "completed", result: { content: [] } });
    if (url.endsWith("/model/close")) return reply({ closed: true });
    throw new Error("Unexpected API path");
  });
  const view = (workspaceId: string) => <WorkspaceFileActionsProvider value={{
    workspaceId, api: createThreadAppApi(scope), serverIds: ["saved-server"], open, chooseViewer,
  }}><Workspace /></WorkspaceFileActionsProvider>;
  const rendered = render(view("workspace"));
  await waitFor(() => expect(mocks.host?.services.configureAppBridge).toBeTypeOf("function"));
  const caps = { experimental: { "openai/files": {} } };
  const bridge = new AppBridge(null, { name: "test", version: "1" }, caps);
  const cleanup = mocks.host!.services.configureAppBridge!(bridge, caps);
  const [hostTransport, guestTransport] = InMemoryTransport.createLinkedPair();
  await bridge.connect(hostTransport);
  await guestTransport.start();
  let id = 0;
  const send = () => new Promise<unknown>(resolve => {
    guestTransport.onmessage = resolve;
    void guestTransport.send({ jsonrpc: "2.0", id: ++id, method: "openai/files/open", params: { path: "/allowed/part.stl" } });
  });
  try {
    expect(await send()).toMatchObject({ result: {} });
    expect(chooseViewer).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledExactlyOnceWith("saved-server", { kind: "file", toolName: "other", title: "Other viewer", resourceUri: "cad://part" });
    const request = mocks.fetch.mock.calls.find(([url]) => url.endsWith("/model/files/open"));
    expect(JSON.parse(request![1].body)).toEqual({ projectId: "project", pluginWorkspace: scope.pluginWorkspace, instanceToken: token, path: "/allowed/part.stl" });
    rendered.rerender(view("another-workspace"));
    // Its handshake stays negotiated; current workspace authority is checked
    // by the existing handler before any new request reaches the server.
    const reads = mocks.fetch.mock.calls.length;
    expect(await send()).toHaveProperty("error");
    expect(mocks.fetch.mock.calls).toHaveLength(reads);
    expect(open).toHaveBeenCalledOnce();
    cleanup?.();
    expect(await send()).toHaveProperty("error");
    expect(open).toHaveBeenCalledOnce();
  } finally {
    await bridge.close();
    await guestTransport.close();
    rendered.unmount();
  }
});

it.each(["accept", "cancel"] as const)("delivers a model App's %s through its actual pending form UI", async action => {
  const calls: Record<string, unknown>[] = [];
  mocks.upload.mockResolvedValue({ ok: true, storageId: "private-receipt" });
  mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/renew")) return reply({});
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/model/open")) return reply(handle);
    if (url.endsWith("/model/close")) return reply({ closed: true });
    if (url.endsWith("/model/call")) {
      if (body.params.name === "fixture.load") return reply({ status: "completed", result: { content: [] } });
      calls.push(body);
      if (body.resume) return reply({ status: "completed", result: { content: [{ type: "text", text: action }] } });
      return reply({
        status: "input_required", continuationId: "model-form", version: 1,
        serverId: "saved-server", method: "tools/call", round: 1,
        expiresAt: Date.now() + 60_000, negotiatedEra: "2026-07-28",
        pluginFormProfile: { fileResources: false, origin: "mcp-app", userResources: false, previews: false },
        inputRequests: [{ key: "form", mode: "form", message: "Choose model input", requestedSchema: {
          type: "object", properties: {
            enabled: { type: "boolean", title: "Enabled", default: false },
            count: { type: "number", title: "Count", default: 0 },
          }, required: ["enabled", "count"],
        } }],
      });
    }
    throw new Error("Unexpected API path");
  });
  const view = render(<ModelFormWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "Ask App form" }));
  await waitFor(() => expect(screen.getByTestId("owned-form-slot")).toHaveTextContent("Choose model input"));
  expect(screen.queryByRole("dialog")).toBeNull();
  if (action === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel form" }));
  else {
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  }
  await waitFor(() => expect(screen.getByTestId("app-form-result")).toHaveTextContent(action));
  expect(mocks.upload.mock.calls[0][1]).toEqual({ form: action === "accept" ? { action, content: { enabled: false, count: 0 } } : { action } });
  expect(calls).toHaveLength(2);
  expect(calls[1].invocationId).toBe(calls[0].invocationId);
  expect(calls[1].resume).toEqual({ continuationId: "model-form", round: 1, responsesBlobId: "private-receipt" });
  expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  view.unmount();
});

function GroupedWorkspace() {
  const workspace = useOwnedModelAppWorkspace(sendMessage, {
    ...marker,
    key: "actor:workspace",
  });
  return (
    <OwnedModelAppPortsProvider value={workspace.value}>
      <output data-testid="references">
        {JSON.stringify(workspace.references)}
      </output>
      {groupContextAttachments(workspace.attachments).map((entry) =>
        entry.kind === "group" ? (
          <ContextGroupChip
            key={entry.group.id}
            group={entry.group}
            items={entry.items}
          />
        ) : null,
      )}
      <OwnedModelApp
        marker={marker}
        renderProps={{
          toolCallId: "original-call",
          toolName: "fixture.part",
          serverId: "saved-server",
          resourceUri: "ui://part",
          toolState: "output-available",
          chatSessionId: "thread",
        }}
      />
    </OwnedModelAppPortsProvider>
  );
}

describe("a later send and Remove all", () => {
  it("references the App only while it has context, and Remove all clears the chip and tells the App null", async () => {
    let server: { updateId: string; content: unknown[] } | null = null;
    let revision = 0;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/renew")) return reply({});
      const body = JSON.parse(init.body as string);
      if (url.endsWith("/model/open")) return reply(handle);
      if (url.endsWith("/model/call"))
        return reply({ status: "completed", result: { content: [] } });
      if (url.endsWith("/model/context")) {
        server = { updateId, content: body.params.content };
        revision++;
        return reply({
          _meta: { "openai/modelContext": { updateId } },
          snapshot: { revision, sequence: body.sequence, state: server },
        });
      }
      if (url.endsWith("/model/context/remove-all")) {
        expect(body.basis).toBe(0);
        server = null;
        revision++;
        return reply({
          outcome: "applied",
          snapshot: {
            revision,
            sequence: 1,
            state: null,
            held: true,
            cursor: 1,
            removedAt: 1,
          },
        });
      }
      if (url.endsWith("/model/close")) return reply({ closed: true });
      throw new Error("Unexpected API path");
    });
    render(<GroupedWorkspace />);
    await waitFor(() => expect(mocks.host).not.toBeNull());
    // Nothing attached: a send carries no reference to this App.
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
    await act(async () => {
      await mocks.host!.services.updateModelContext!({
        content: [
          params.content[0],
          { type: "text", text: "Inspection note" },
        ],
      });
    });
    expect(screen.getByTestId("references")).toHaveTextContent(token);
    expect(
      screen.getByRole("button", { name: "Parts: Context, 2 items" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove all Parts context" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove all Parts context" }),
      ).not.toBeInTheDocument(),
    );
    expect(server).toBeNull();
    expect(screen.getByTestId("guest-context")).toHaveTextContent("null");
    expect(mocks.notifications.at(-1)).toBeNull();
    // The next send no longer depends on this App.
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
  });
});

describe("a stale Remove all on a model App", () => {
  it("shows the person's newer context but keeps it out of the next turn", async () => {
    let revision = 0;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/renew")) return reply({});
      const body = JSON.parse(init.body as string);
      if (url.endsWith("/model/open")) return reply(handle);
      if (url.endsWith("/model/call"))
        return reply({ status: "completed", result: { content: [] } });
      if (url.endsWith("/model/context")) {
        revision++;
        return reply({
          _meta: { "openai/modelContext": { updateId } },
          snapshot: {
            revision,
            sequence: body.sequence,
            state: { updateId, content: body.params.content },
          },
        });
      }
      if (url.endsWith("/model/context/remove-all"))
        // The removal never landed; the person attached again first.
        return reply({
          outcome: "stale",
          snapshot: {
            revision: revision + 1,
            sequence: 2,
            state: {
              updateId,
              content: [{ type: "text", text: "Newer pick" }],
            },
            cursor: 1,
            attachedAt: 1,
          },
        });
      if (url.endsWith("/model/close")) return reply({ closed: true });
      throw new Error("Unexpected API path");
    });
    render(<GroupedWorkspace />);
    await waitFor(() => expect(mocks.host).not.toBeNull());
    await act(async () => {
      await mocks.host!.services.updateModelContext!(params);
    });
    expect(screen.getByTestId("references")).toHaveTextContent(token);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove all Parts context" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Parts: Context, 1 item" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
  });
});

describe("inline App and composer composition", () => {
  it("publishes/removes real context with stable ownership and no repeated load effect", async () => {
    let finishRemoval!: (response: Response) => void;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/renew")) return reply({});
      const body = JSON.parse(init.body as string);
      expect(body.instanceToken).toBe(token);
      if (url.endsWith("/model/open")) return reply(handle);
      if (url.endsWith("/model/call")) {
        mocks.sourceEffects++;
        return reply({ status: "completed", result: { content: [] } });
      }
      if (url.endsWith("/model/context")) {
        expect(body.sequence).toBeGreaterThanOrEqual(1);
        expect(body.params).toEqual(
          body.sequence === 2
            ? { content: [], structuredContent: { fixture: true, value: 42 } }
            : params,
        );
        return reply({
          _meta: { "openai/modelContext": { updateId } },
          snapshot: {
            revision: body.sequence * 2 - 1,
            sequence: body.sequence,
            state: { updateId, ...body.params },
          },
        });
      }
      if (url.endsWith("/model/context/remove-all")) {
        expect(body).toMatchObject({ operationId: expect.any(String) });
        return new Promise<Response>((resolve) => {
          finishRemoval = resolve;
        });
      }
      if (url.endsWith("/model/close")) return reply({ closed: true });
      throw new Error("Unexpected API path");
    });
    const view = render(<Workspace />);
    await waitFor(() => expect(mocks.sourceEffects).toBe(1));
    const update = mocks.host!.services.updateModelContext!;
    await act(async () => {
      await update(params);
    });
    expect(
      screen.getByRole("button", { name: "Remove all Parts context" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("references")).toHaveTextContent(token);
    expect(screen.getByTestId("guest-context")).toHaveTextContent(updateId);
    const ownedUpdate = mocks.host!.services.updateModelContext;
    for (let index = 0; index < 4; index++)
      fireEvent.click(screen.getByText("Hide or reopen"));
    view.rerender(<Workspace />);
    expect(mocks.host!.services.updateModelContext).toBe(ownedUpdate);
    expect(mocks.sourceEffects).toBe(1);
    expect(mocks.mounted).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove all Parts context" }),
    );
    await waitFor(() => expect(finishRemoval).toBeTypeOf("function"));
    // Unconfirmed: the chip, the App's view and the next turn all drop it.
    expect(
      screen.queryByRole("button", { name: "Remove all Parts context" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
    expect(screen.getByTestId("guest-context")).toHaveTextContent("null");
    await act(async () => {
      finishRemoval(
        reply({
          outcome: "applied",
          snapshot: {
            revision: 2,
            sequence: 1,
            state: null,
            held: true,
            cursor: 1,
            removedAt: 1,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove all Parts context" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("guest-context")).toHaveTextContent("null");
    expect(mocks.notifications.at(-1)).toBeNull();
    expect(mocks.sourceEffects).toBe(1);
    // Structured state also uses the same removable composer chip and the
    // existing authenticated removal/notification protocol.
    const structured = {
      content: [],
      structuredContent: { fixture: true, value: 42 },
    };
    // The App re-sending context on its own right after Remove all (Bits &
    // Bolts redraws and re-posts) is refused: the removal stays removed.
    const contextPosts = () =>
      mocks.fetch.mock.calls.filter(([url]) =>
        String(url).endsWith("/model/context"),
      ).length;
    const posted = contextPosts();
    await act(async () => {
      await expect(update(structured)).rejects.toThrow(
        "Use the App to attach it again",
      );
    });
    expect(contextPosts()).toBe(posted);
    expect(screen.getByTestId("guest-context")).toHaveTextContent("null");
    expect(
      screen.queryByRole("button", { name: "Remove all Parts context" }),
    ).not.toBeInTheDocument();
    // The person clicks into the App (focus moves into its frame) and it
    // attaches again.
    const frame = document.createElement("iframe");
    frame.title = "MCP App: fixture.part";
    document.body.append(frame);
    frame.focus();
    await act(async () => {
      await update(structured);
    });
    frame.remove();
    expect(mocks.fetch.mock.lastCall![1].body).toContain('"attach":"user"');
    expect(
      screen.getByRole("button", { name: "Remove all Parts context" }),
    ).toBeInTheDocument();
    const previousRemoval = finishRemoval;
    fireEvent.click(
      screen.getByRole("button", { name: "Remove all Parts context" }),
    );
    await waitFor(() => expect(finishRemoval).not.toBe(previousRemoval));
    await act(async () => {
      finishRemoval(
        reply({
          outcome: "applied",
          snapshot: {
            revision: 4,
            sequence: 2,
            state: null,
            held: true,
            cursor: 3,
            removedAt: 3,
            attachedAt: 2,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove all Parts context" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("guest-context")).toHaveTextContent("null");
    expect(mocks.sourceEffects).toBe(1);
    // Keep the old leaf mounted deliberately: scope change must fence it before
    // passive cleanup, and returning cannot revive its former publications.
    document.body.append(frame);
    frame.focus();
    await act(async () => {
      await update(params);
    });
    frame.remove();
    expect(
      screen.getByRole("button", { name: "Remove all Parts context" }),
    ).toBeInTheDocument();
    view.rerender(<Workspace workspaceId="new-workspace" />);
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
    expect(
      screen.queryByRole("button", { name: "Remove all Parts context" }),
    ).not.toBeInTheDocument();
    view.rerender(<Workspace />);
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
    expect(
      screen.queryByRole("button", { name: "Remove all Parts context" }),
    ).not.toBeInTheDocument();
    expect(mocks.sourceEffects).toBe(1);
    view.rerender(<Workspace show={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("references")).toHaveTextContent("[]"),
    );
    await waitFor(() =>
      expect(
        mocks.fetch.mock.calls.some(([url]) =>
          String(url).endsWith("/model/close"),
        ),
      ).toBe(true),
    );
    await expect(update(params)).rejects.toThrow();
    expect(mocks.sourceEffects).toBe(1);
    expect(mocks.renderCount).toBeLessThan(40);
  });
});

describe("the client's Model context toggle", () => {
  function ToggledWorkspace({ contextEnabled }: { contextEnabled: boolean }) {
    const workspace = useOwnedModelAppWorkspace(
      sendMessage,
      { ...marker, key: "actor:workspace" },
      contextEnabled,
    );
    return (
      <OwnedModelAppPortsProvider value={workspace.value}>
        <output data-testid="references">
          {JSON.stringify(workspace.references)}
        </output>
        {workspace.attachments.map((item) => (
          <ContextAttachmentChip key={item.id} {...item} />
        ))}
        <OwnedModelApp
          marker={marker}
          renderProps={{
            toolCallId: "original-call",
            toolName: "fixture.part",
            serverId: "saved-server",
            resourceUri: "ui://part",
            toolState: "output-available",
            chatSessionId: "thread",
          }}
        />
      </OwnedModelAppPortsProvider>
    );
  }

  it("drops the App's reference and chip in the same render it turns off, keeping the App open", async () => {
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/renew")) return reply({});
      const body = JSON.parse(init.body as string);
      if (url.endsWith("/model/open")) return reply(handle);
      if (url.endsWith("/model/call"))
        return reply({ status: "completed", result: { content: [] } });
      if (url.endsWith("/model/context"))
        return reply({
          _meta: { "openai/modelContext": { updateId } },
          snapshot: {
            revision: 1,
            sequence: body.sequence,
            state: { updateId, ...body.params },
          },
        });
      if (url.endsWith("/model/close")) return reply({ closed: true });
      throw new Error("Unexpected API path");
    });
    const view = render(<ToggledWorkspace contextEnabled />);
    await waitFor(() => expect(mocks.host).not.toBeNull());
    await act(async () => {
      await mocks.host!.services.updateModelContext!(params);
    });
    expect(screen.getByTestId("references")).toHaveTextContent(token);
    expect(screen.getByText("Triangle")).toBeInTheDocument();
    // The host turns Model context off. The very next send must not carry the
    // App's reference (the server would refuse the whole turn), with no
    // effect or network round-trip in between.
    view.rerender(<ToggledWorkspace contextEnabled={false} />);
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
    expect(screen.queryByText("Triangle")).not.toBeInTheDocument();
    // The App itself keeps running.
    expect(mocks.mounted).toBe(1);
    expect(
      mocks.fetch.mock.calls.some(([url]) =>
        String(url).endsWith("/model/close"),
      ),
    ).toBe(false);
    // Turning it back on attaches the App's still-held context again.
    view.rerender(<ToggledWorkspace contextEnabled />);
    expect(screen.getByTestId("references")).toHaveTextContent(token);
    expect(mocks.mounted).toBe(1);
  });
});

it("only exposes a direct model-tool form to Apps in its own Compare workspace", async () => {
  mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/renew")) return reply({});
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/model/open")) return reply({ ...handle, instanceToken: body.instanceToken });
    if (url.endsWith("/model/close")) return reply({ closed: true });
    throw new Error("Unexpected API path");
  });
  const view = render(<><CompareModelLane lane="c" /><CompareModelLane lane="d" /></>);
  await waitFor(() => expect(mocks.pendingInputs.size).toBe(2));
  const workspace = compareLaneWorkspace({ actorId: "actor", projectId: "project", hostId: "host" }, "model", "c", "chat-c");
  const cancel = vi.fn();
  let unregister = () => {};
  act(() => { unregister = registerComposerForm({ id: "direct-mrtr-form", workspaceId: workspace.workspaceId, serverName: "CAD", cancel }); });
  expect(mocks.pendingInputs.get("c")).toBe(true);
  expect(mocks.pendingInputs.get("d")).toBe(false);
  act(() => unregister());
  expect(mocks.pendingInputs.get("c")).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
  expect(mocks.mounted).toBe(2);
  view.unmount();
});

it("gives a direct MCP tool's actual form priority without replaying the model App", async () => {
  mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/renew")) return reply({});
    if (url.endsWith("/model/open")) return reply(handle);
    if (url.endsWith("/model/close")) return reply({ closed: true });
    if (url.endsWith("/model/call") && JSON.parse(init.body as string).params.name === "fixture.load") return reply({ status: "completed", result: { content: [] } });
    throw new Error("Unexpected App operation");
  });
  const view = render(<ModelFormWorkspace />);
  await screen.findByRole("button", { name: "Ask App form" });
  await waitFor(() => expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith("/model/call"))).toHaveLength(1));
  const cancel = vi.fn();
  const submit = vi.fn();
  act(() => useHostedMrtrStore.getState().enqueue({
    key: "direct-model-tool:1", continuationId: "direct-model-tool", round: 1,
    serverId: "saved-server", method: "tools/call", operationLabel: "cad.reviewForm",
    pluginFormServiceScope: { projectId: "project", workspaceId: "workspace" },
    pluginFormProfile: { origin: "server", fileResources: false, userResources: false, previews: false },
    requests: [{ key: "review", mode: "form", message: "Direct tool form", requestedSchema: {
      type: "object", properties: { name: { type: "string", title: "Name" } },
    } }], expiresAt: Date.now() + 60_000, timestamp: new Date().toISOString(),
  }, { submit, cancel }));
  await waitFor(() => expect(screen.getByTestId("owned-form-slot")).toHaveTextContent("Direct tool form"));
  expect(mocks.pendingInputs.get("original-call")).toBe(true);
  expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith("/model/call"))).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel form" }));
  await waitFor(() => expect(mocks.pendingInputs.get("original-call")).toBe(false));
  expect(submit).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
  view.unmount();
});
