import {
  renderHook,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(async () => {}),
  renderer: vi.fn(),
  host: { environment: { draftHostContext: {} } },
}));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.fetch }));
vi.mock("../../chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => mocks.host,
}));
vi.mock("../use-app-context", () => ({
  useAppContext: vi.fn(() => ({ snapshot: { state: null }, update: vi.fn() })),
  withAppContext: (host: unknown) => host,
}));
vi.mock("../thread-app-host", () => ({
  createThreadAppHost: () => mocks.host,
}));
vi.mock("../thread-app-api", () => ({
  createThreadAppApi: () => ({ invoke: mocks.invoke, close: mocks.close }),
}));
vi.mock("@mcpjam/widget-react", () => ({
  WidgetHostProvider: ({ children }: any) => children,
  MCPAppsRenderer: (props: any) => {
    mocks.renderer(props);
    return <div>Owned App ready</div>;
  },
}));
import type { PluginMessageIntent } from "@/shared/plugin-message";
import {
  OwnedModelApp,
  OwnedModelAppPortsProvider,
  useOwnedModelAppWorkspace,
} from "../OwnedModelApp";
const marker = {
  instanceToken: "a".repeat(43),
  projectId: "p",
  workspaceId: "w",
  hostId: "h",
  serverId: "saved-id",
};
const handle = {
  ...marker,
  instanceId: "instance",
  resourceUri: "ui://app",
  widgetContent: { html: "app" },
  toolMetadata: {},
  appToolsEnabled: true,
};
const props = {
  serverId: "ordinary-name",
  toolCallId: "call",
  toolName: "pickFile",
  toolState: "output-available" as const,
  resourceUri: "ui://app",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(handle)));
  mocks.invoke.mockResolvedValue({ content: [] });
});
describe("owned model App boundary", () => {
  it("waits for authenticated loading and overrides ordinary calls with the owned API", async () => {
    let resolve!: (response: Response) => void;
    mocks.fetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const generic = vi.fn();
    render(
      <OwnedModelApp
        marker={marker}
        renderProps={{
          ...props,
          onCallTool: generic,
          toolOutput: {
            content: [],
            _meta: { "mcpjam/model-app": marker, keep: "value" },
          },
          toolResponseMetadata: { "mcpjam/model-app": marker, keep: "value" },
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Opening App");
    expect(mocks.renderer).not.toHaveBeenCalled();
    await act(async () => resolve(new Response(JSON.stringify(handle))));
    await screen.findByText("Owned App ready");
    const rendered = mocks.renderer.mock.calls.at(-1)![0];
    expect(rendered.serverId).toBe("saved-id");
    expect(rendered.toolResponseMetadata).toEqual({ keep: "value" });
    expect(rendered.toolOutput).toEqual({
      content: [],
      _meta: { keep: "value" },
    });
    await rendered.onCallTool("cad.listParts", {});
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(generic).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls[0][3]).toEqual({
      name: "cad.listParts",
      arguments: {},
    });
  });
  it("never falls back to a generic renderer when ownership expires", async () => {
    mocks.fetch.mockResolvedValue(new Response("denied", { status: 403 }));
    render(<OwnedModelApp marker={marker} renderProps={props} />);
    await screen.findByRole("alert");
    expect(mocks.renderer).not.toHaveBeenCalled();
  });
  it("refuses malformed metadata without fetching", () => {
    render(
      <OwnedModelApp marker={{ unavailable: true }} renderProps={props} />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("closes the explicit owner at teardown", async () => {
    const view = render(<OwnedModelApp marker={marker} renderProps={props} />);
    await screen.findByText("Owned App ready");
    view.unmount();
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  });
});

it("publishes the same removable attachments and private reference once, then revokes on close", () => {
  const send = vi.fn(async () => true);
  const { result } = renderHook(() =>
    useOwnedModelAppWorkspace(send, { ...marker, key: "actor" }),
  );
  const remove = vi.fn();
  const attachments = [{ id: "context", title: "Part", remove }];
  const firstValue = result.current.value;
  act(() =>
    result.current.value.publishContext(
      marker.instanceToken,
      attachments,
      marker,
    ),
  );
  expect(result.current.attachments).toEqual(attachments);
  expect(result.current.references).toEqual([marker.instanceToken]);
  expect(result.current.value).toBe(firstValue);
  result.current.attachments[0].remove();
  expect(remove).toHaveBeenCalledOnce();
  act(() =>
    result.current.value.publishContext(marker.instanceToken, null, marker),
  );
  expect(result.current.references).toEqual([]);
});

it("fences old publishers and dispatchers across actor, workspace and admission changes", async () => {
  const send = vi.fn(async () => true);
  const scope = { ...marker, key: "actor-one" };
  const { result, rerender } = renderHook(
    ({ scope }) => useOwnedModelAppWorkspace(send, scope),
    { initialProps: { scope: scope as typeof scope | null } },
  );
  const attachments = [{ id: "context", title: "Part" }];
  const original = result.current.value;
  act(() => original.publishContext(marker.instanceToken, attachments, marker));
  expect(result.current.references).toEqual([marker.instanceToken]);
  rerender({ scope: { ...scope, key: "actor-two" } });
  expect(result.current.references).toEqual([]);
  act(() => original.publishContext(marker.instanceToken, attachments, marker));
  expect(result.current.references).toEqual([]);
  expect(await original.sendMessage({} as never, () => true)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  act(() =>
    result.current.value.publishContext(marker.instanceToken, attachments, {
      ...marker,
      workspaceId: "foreign-workspace",
    }),
  );
  expect(result.current.references).toEqual([]);
  rerender({ scope: null });
  act(() =>
    result.current.value.publishContext(
      marker.instanceToken,
      attachments,
      marker,
    ),
  );
  expect(result.current.references).toEqual([]);
  rerender({ scope });
  expect(result.current.references).toEqual([]);
  act(() => original.publishContext(marker.instanceToken, attachments, marker));
  expect(result.current.references).toEqual([]);
  act(() =>
    result.current.value.publishContext(
      marker.instanceToken,
      attachments,
      marker,
    ),
  );
  expect(result.current.references).toEqual([marker.instanceToken]);
});

it("prepares a new-chat transfer only for the exact live inline source", async () => {
  const send = vi.fn(async () => true);
  const { result, rerender } = renderHook(
    ({ scope }) => useOwnedModelAppWorkspace(send, scope),
    { initialProps: { scope: { ...marker, key: "actor-one" } } },
  );
  const intent = {
    instanceToken: marker.instanceToken,
    operationId: "operation",
    sourceThreadId: "thread",
    params: {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      _meta: { "openai/message": { target: "new", send: true } },
    },
  } as PluginMessageIntent;
  const live = vi.fn(() => true);
  const source = {
    serverId: marker.serverId,
    threadId: "thread",
    isLive: live,
  };
  const dispose = result.current.value.registerMessageSource(
    marker.instanceToken,
    source,
    marker,
  );
  mocks.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ preparationToken: "b".repeat(43) })),
  );
  expect(await result.current.prepareMessage(intent, () => true)).toEqual({
    ...intent,
    preparationToken: "b".repeat(43),
  });
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({
    serverId: marker.serverId,
    intent,
  });
  expect(
    await result.current.prepareMessage(
      { ...intent, sourceThreadId: "foreign" },
      () => true,
    ),
  ).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledOnce();
  dispose();
  expect(await result.current.prepareMessage(intent, () => true)).toBeNull();
  const previous = result.current.prepareMessage;
  result.current.value.registerMessageSource(
    marker.instanceToken,
    source,
    marker,
  );
  rerender({ scope: { ...marker, key: "actor-two" } });
  expect(await previous(intent, () => true)).toBeNull();
  expect(await result.current.prepareMessage(intent, () => true)).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledOnce();
});

it("refuses inline transfer results after source closure during admission", async () => {
  const { result } = renderHook(() =>
    useOwnedModelAppWorkspace(vi.fn(), { ...marker, key: "actor" }),
  );
  const dispose = result.current.value.registerMessageSource(
    marker.instanceToken,
    {
      serverId: marker.serverId,
      threadId: "thread",
      isLive: () => true,
    },
    marker,
  );
  let finish!: (value: Response) => void;
  mocks.fetch.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = result.current.prepareMessage(
    { instanceToken: marker.instanceToken, sourceThreadId: "thread" } as never,
    () => true,
  );
  dispose();
  finish(new Response(JSON.stringify({ preparationToken: "b".repeat(43) })));
  expect(await pending).toBeNull();
});

it("keeps the inline preparation source stable across equivalent marker renders", async () => {
  mocks.fetch.mockImplementation(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.endsWith("model/open")
            ? { ...handle, messageEnabled: true }
            : { preparationToken: "b".repeat(43) },
        ),
      ),
  );
  let workspace!: ReturnType<typeof useOwnedModelAppWorkspace>;
  const send = vi.fn();
  function Root({ revision }: { revision: number }) {
    workspace = useOwnedModelAppWorkspace(send, { ...marker, key: "actor" });
    return (
      <OwnedModelAppPortsProvider value={workspace.value}>
        <span>{revision}</span>
        <OwnedModelApp
          marker={{ ...marker }}
          renderProps={{ ...props, chatSessionId: "thread" }}
        />
      </OwnedModelAppPortsProvider>
    );
  }
  const view = render(<Root revision={1} />);
  await screen.findByText("Owned App ready");
  const intent = {
    instanceToken: marker.instanceToken,
    sourceThreadId: "thread",
  } as PluginMessageIntent;
  let finish!: (response: Response) => void;
  mocks.fetch.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = workspace.prepareMessage(intent, () => true);
  view.rerender(<Root revision={2} />);
  finish(new Response(JSON.stringify({ preparationToken: "b".repeat(43) })));
  expect(await pending).toEqual({
    ...intent,
    preparationToken: "b".repeat(43),
  });
});
