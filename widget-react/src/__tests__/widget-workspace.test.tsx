import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppToolsRegistry,
  recordAppToolInvocation,
  useAppToolsRegistryApi,
  type AppInstance,
} from "../app-tools-registry";
import {
  createWidgetSurfaceStore,
  useWidgetSurfaceStoreApi,
} from "../widget-surface-store";
import {
  closeWorkspaceSurface,
  useWidgetWorkspace,
  WidgetWorkspaceProvider,
  WidgetWorkspaceSurfaceHost,
} from "../widget-workspace";
import { WidgetSurfaceHost } from "../widget-surface-host";
import type { MCPAppsRendererProps } from "../mcp-apps-renderer";
import { useWidgetHost } from "../widget-host-context";
import type { WidgetHost } from "../widget-host";

vi.mock("../mcp-apps-renderer", () => ({ MCPAppsRendererSurface: () => null }));

const props = (id = "call-1", chatSessionId = "thread-1") =>
  ({
    toolCallId: id,
    chatSessionId,
    serverId: "synthetic-server",
    resourceUri: "ui://synthetic/counter",
    toolName: "open_counter",
  } as MCPAppsRendererProps);
const instance = (bridgeId: string, overrides: Partial<AppInstance> = {}) =>
  ({
    bridgeId,
    parentToolCallId: "call-1",
    chatSessionId: "thread-1",
    serverId: "synthetic-server",
    appName: "Counter",
    surface: "inline",
    bridge: { callTool: vi.fn() },
    tools: [{ name: "increment", inputSchema: { type: "object" } }],
    registeredAtMs: 0,
    ...overrides,
  } as AppInstance);

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("workspace-owned widget surfaces", () => {
  it("fixes presentation before mounting and refuses to move a live app", () => {
    const store = createWidgetSurfaceStore({ retainInstances: true });
    store
      .getState()
      .upsertRegistration("modal", "call", props(), undefined, "modal");
    store.getState().upsertRegistration("modal", "call", props("changed"));
    expect(store.getState().surfaces.get("modal")?.presentation).toBe("modal");
    expect(() =>
      store
        .getState()
        .upsertRegistration("modal", "call", props(), undefined, "panel")
    ).toThrow(/presentation/);
    store.getState().upsertRegistration("panel", "other", props());
    expect(() =>
      store
        .getState()
        .upsertRegistration("panel", "other", props(), undefined, "modal")
    ).toThrow(/presentation/);
  });
  it("retains each surface's resolved host rather than reading another lane", () => {
    let workspace!: ReturnType<typeof useWidgetWorkspace>;
    function Probe() {
      workspace = useWidgetWorkspace();
      return (
        <WidgetWorkspaceSurfaceHost
          activeSurfaceId="a"
          renderSurface={(value) => <HostLabel id={value.toolCallId} />}
        />
      );
    }
    function HostLabel({ id }: { id: string }) {
      const host = useWidgetHost();
      return <div data-testid={id}>{host.environment.sharedHostStyle}</div>;
    }
    const first = { environment: { sharedHostStyle: "chatgpt" } } as WidgetHost;
    const second = { environment: { sharedHostStyle: "codex" } } as WidgetHost;
    const view = render(
      <WidgetWorkspaceProvider workspaceId="retained-hosts">
        <Probe />
      </WidgetWorkspaceProvider>
    );
    act(() => {
      workspace.surfaces
        .getState()
        .upsertRegistration("a", "first", props("first"), first);
      workspace.surfaces
        .getState()
        .upsertRegistration("b", "second", props("second"), second);
      workspace.surfaces.getState().releaseRegistration("a", "first");
    });
    expect(view.getByTestId("first").textContent).toBe("chatgpt");
    expect(view.getByTestId("second").textContent).toBe("codex");
    expect(workspace.surfaces.getState().surfaces.get("a")?.host).toBe(first);
  });
  it("retains the latest render input when the last row leaves; explicit close fences remount", () => {
    const store = createWidgetSurfaceStore({ retainInstances: true });
    store.getState().upsertRegistration("surface-1", "call-1", props());
    store.getState().upsertRegistration("surface-1", "call-1", {
      ...props(),
      toolOutput: { revision: 2 },
    });
    store.getState().releaseRegistration("surface-1", "call-1");
    store.getState().clearChatSession("thread-1");
    expect(
      store.getState().surfaces.get("surface-1")?.retainedProps.toolOutput
    ).toEqual({ revision: 2 });
    expect(store.getState().surfaces.get("surface-1")?.registrations.size).toBe(
      0
    );
    store.getState().destroySurface("surface-1");
    store.getState().upsertRegistration("surface-1", "call-1", props());
    expect(store.getState().surfaces.size).toBe(0);
  });

  it("preserves the legacy row/session teardown behavior", () => {
    const store = createWidgetSurfaceStore();
    store.getState().upsertRegistration("surface-1", "call-1", props());
    store.getState().releaseRegistration("surface-1", "call-1");
    expect(store.getState().surfaces.size).toBe(0);
    store.getState().upsertRegistration("surface-2", "call-2", props("call-2"));
    store.getState().clearChatSession("thread-1");
    expect(store.getState().surfaces.size).toBe(0);
  });

  it("bounds retained instances and refuses new owners without eviction", () => {
    const store = createWidgetSurfaceStore({
      retainInstances: true,
      maxInstances: 1,
    });
    store.getState().upsertRegistration("surface-1", "call-1", props());
    // A refusal is recorded, never thrown: this runs from a layout effect.
    expect(() =>
      store
        .getState()
        .upsertRegistration("surface-2", "call-2", props("call-2"))
    ).not.toThrow();
    expect([...store.getState().surfaces.keys()]).toEqual(["surface-1"]);
    expect(store.getState().refused.get("surface-2")).toMatchObject({
      code: "WIDGET_INSTANCE_LIMIT",
      limit: 1,
      message: expect.stringMatching(/Close an App/),
    });
    // Re-trying while still full doesn't churn subscribers.
    const before = store.getState().refused;
    store.getState().upsertRegistration("surface-2", "call-2", props("call-2"));
    expect(store.getState().refused).toBe(before);
  });

  it("counts live instances, so closing an App frees its slot", () => {
    const store = createWidgetSurfaceStore({
      retainInstances: true,
      maxInstances: 2,
    });
    // Far more lifetime identities than the old 2048 cap, two live at most.
    for (let i = 0; i < 2100; i += 1) {
      const surfaceId = `surface-${i}`;
      store
        .getState()
        .upsertRegistration(surfaceId, `call-${i}`, props(`call-${i}`));
      expect(store.getState().surfaces.has(surfaceId)).toBe(true);
      store.getState().destroySurface(surfaceId);
    }
    expect(store.getState().surfaces.size).toBe(0);
    expect(store.getState().refused.size).toBe(0);
  });

  it("admits a refused surface once a slot frees and clears its refusal", () => {
    const store = createWidgetSurfaceStore({
      retainInstances: true,
      maxInstances: 1,
    });
    store.getState().upsertRegistration("surface-1", "call-1", props());
    store.getState().upsertRegistration("surface-2", "call-2", props("call-2"));
    expect(store.getState().refused.has("surface-2")).toBe(true);
    store.getState().destroySurface("surface-1");
    store.getState().upsertRegistration("surface-2", "call-2", props("call-2"));
    expect([...store.getState().surfaces.keys()]).toEqual(["surface-2"]);
    expect(store.getState().refused.size).toBe(0);
  });

  it("describes a refused active App instead of crashing the workspace host", () => {
    let owner: ReturnType<typeof useWidgetWorkspace> | undefined;
    function Probe() {
      owner = useWidgetWorkspace();
      return null;
    }
    const view = render(
      <WidgetWorkspaceProvider workspaceId="full">
        <Probe />
        <WidgetWorkspaceSurfaceHost activeSurfaceId="surface-64" />
      </WidgetWorkspaceProvider>
    );
    act(() => {
      for (let i = 0; i < 65; i += 1)
        owner!.surfaces
          .getState()
          .upsertRegistration(
            `surface-${i}`,
            `call-${i}`,
            props(`call-${i}`)
          );
    });
    expect(owner!.surfaces.getState().surfaces.size).toBe(64);
    expect(view.getByRole("alert").textContent).toMatch(
      /Too many Apps are open \(64\)/
    );
  });

  it("ordinary chat (no workspace) keeps no lifetime bookkeeping and no limit", () => {
    const store = createWidgetSurfaceStore();
    for (let i = 0; i < 200; i += 1) {
      store
        .getState()
        .upsertRegistration(`surface-${i}`, `call-${i}`, props(`call-${i}`));
    }
    expect(store.getState().surfaces.size).toBe(200);
    for (let i = 0; i < 200; i += 1)
      store.getState().releaseRegistration(`surface-${i}`, `call-${i}`);
    // Without retention a released row's surface goes away, as before.
    expect(store.getState().surfaces.size).toBe(0);
    expect(store.getState().refused.size).toBe(0);
  });

  it("keeps render parents, iframe nodes and component state through selection and row removal", () => {
    let surfaceStore: ReturnType<typeof useWidgetSurfaceStoreApi>;
    function Counter({ toolCallId }: MCPAppsRendererProps) {
      const [count, setCount] = useState(0);
      return (
        <>
          <button data-testid={toolCallId} onClick={() => setCount(count + 1)}>
            {count}
          </button>
          <iframe title={toolCallId} />
        </>
      );
    }
    function Host({ selected, thread }: { selected: string; thread: string }) {
      surfaceStore = useWidgetSurfaceStoreApi();
      return (
        <>
          <WidgetSurfaceHost chatSessionId={thread} />
          <WidgetWorkspaceSurfaceHost
            activeSurfaceId={selected}
            renderSurface={(p) => <Counter {...p} />}
          />
        </>
      );
    }
    const view = render(
      <WidgetWorkspaceProvider workspaceId="workspace-1">
        <Host selected="surface-1" thread="thread-1" />
      </WidgetWorkspaceProvider>
    );
    act(() => {
      surfaceStore
        .getState()
        .upsertRegistration("surface-1", "call-1", props());
      surfaceStore
        .getState()
        .upsertRegistration("surface-2", "call-2", props("call-2", "thread-2"));
    });
    const frame = view.getByTitle("call-1");
    const parent = frame.parentElement;
    fireEvent.click(view.getByTestId("call-1"));
    act(() =>
      surfaceStore.getState().releaseRegistration("surface-1", "call-1")
    );
    view.rerender(
      <WidgetWorkspaceProvider workspaceId="workspace-1">
        <Host selected="surface-2" thread="thread-2" />
      </WidgetWorkspaceProvider>
    );
    expect(view.getByTitle("call-1")).toBe(frame);
    expect(frame.parentElement).toBe(parent);
    expect(view.getByTestId("call-1").textContent).toBe("1");
    expect(parent?.hidden).toBe(true);
    view.rerender(
      <WidgetWorkspaceProvider workspaceId="workspace-1">
        <Host selected="surface-1" thread="thread-1" />
      </WidgetWorkspaceProvider>
    );
    expect(frame.parentElement).toBe(parent);
    expect(parent?.hidden).toBe(false);
  });

  it("isolates surface and tool stores in two workspaces and cancels only the closed owner", async () => {
    const workspaces: ReturnType<typeof useWidgetWorkspace>[] = [];
    function Probe() {
      const w = useWidgetWorkspace();
      workspaces.push(w);
      expect(useAppToolsRegistryApi()).toBe(w.registry);
      return null;
    }
    render(
      <>
        <WidgetWorkspaceProvider workspaceId="a">
          <Probe />
        </WidgetWorkspaceProvider>
        <WidgetWorkspaceProvider workspaceId="b">
          <Probe />
        </WidgetWorkspaceProvider>
      </>
    );
    const [a, b] = workspaces;
    a.surfaces.getState().upsertRegistration("same-id", "call-1", props());
    b.surfaces.getState().upsertRegistration("same-id", "call-1", props());
    await a.registry.getState().registerInstance(instance("a-bridge"));
    await b.registry.getState().registerInstance(instance("b-bridge"));
    const pendingA = new AbortController(),
      pendingB = new AbortController();
    a.registry.getState().registerPendingCall("a-bridge", pendingA);
    b.registry.getState().registerPendingCall("b-bridge", pendingB);
    closeWorkspaceSurface(a, "same-id");
    expect(pendingA.signal.aborted).toBe(true);
    expect(pendingB.signal.aborted).toBe(false);
    expect(a.registry.getState().aliases.size).toBe(0);
    expect(b.registry.getState().aliases.size).toBe(1);
    expect(b.surfaces.getState().surfaces.size).toBe(1);
    recordAppToolInvocation(
      {
        alias: "app_12345678",
        rawName: "increment",
        appName: "Counter",
        serverId: "synthetic-server",
        parentToolCallId: "call-1",
        bridgeId: "a-bridge",
        input: { privateFixture: "a" },
        raw: { content: [{ type: "text", text: "a" }] },
      },
      undefined,
      a.invocations
    );
    expect(a.invocations.getState().records).toHaveLength(1);
    expect(b.invocations.getState().records).toHaveLength(0);
  });

  it("ignores alias registration after unregister/disposal and aborts stale dispatch", async () => {
    const registry = createAppToolsRegistry();
    const pending = registry.getState().registerInstance(instance("late"));
    registry.getState().unregisterInstance("late");
    await pending;
    expect(registry.getState().aliases.size).toBe(0);
    const pendingAfter = registry
      .getState()
      .registerInstance(instance("disposed"));
    registry.getState().dispose();
    await pendingAfter;
    expect(registry.getState().aliases.size).toBe(0);
    const controller = new AbortController();
    registry.getState().registerPendingCall("disposed", controller);
    expect(controller.signal.aborted).toBe(true);
  });

  it("survives development effect replay and releases stores on actual unmount", async () => {
    vi.useFakeTimers();
    let owner: ReturnType<typeof useWidgetWorkspace>;
    function Probe() {
      owner = useWidgetWorkspace();
      return null;
    }
    const view = render(
      <StrictMode>
        <WidgetWorkspaceProvider workspaceId="strict">
          <Probe />
        </WidgetWorkspaceProvider>
      </StrictMode>
    );
    act(() => vi.runAllTimers());
    owner!.surfaces
      .getState()
      .upsertRegistration("surface-1", "call-1", props());
    expect(owner!.surfaces.getState().surfaces.size).toBe(1);
    await owner!.registry
      .getState()
      .registerInstance(instance("strict-bridge"));
    const pending = new AbortController();
    owner!.registry.getState().registerPendingCall("strict-bridge", pending);
    view.unmount();
    expect(pending.signal.aborted).toBe(true);
    expect(owner!.registry.getState().snapshotForChatBody()).toEqual([]);
    owner!.surfaces
      .getState()
      .upsertRegistration("surface-2", "call-2", props("call-2"));
    expect(owner!.surfaces.getState().surfaces.size).toBe(1);
    act(() => vi.runAllTimers());
    expect(owner!.surfaces.getState().surfaces.size).toBe(0);
    owner!.surfaces
      .getState()
      .upsertRegistration("surface-1", "call-1", props());
    expect(owner!.surfaces.getState().surfaces.size).toBe(0);
  });

  it("keeps only the newest bridge when two slot registrations hash concurrently", async () => {
    const registry = createAppToolsRegistry();
    const old = registry.getState().registerInstance(instance("old"));
    const newer = registry.getState().registerInstance(instance("new"));
    await Promise.all([old, newer]);
    expect([...registry.getState().instancesByBridgeId.keys()]).toEqual([
      "new",
    ]);
    expect(registry.getState().aliases.size).toBe(1);
  });

  it("bounds workspace tool ownership without silently evicting another app", async () => {
    const registry = createAppToolsRegistry({ maxInstances: 1 });
    await registry.getState().registerInstance(instance("first"));
    await expect(
      registry
        .getState()
        .registerInstance(instance("other", { parentToolCallId: "other-call" }))
    ).rejects.toThrow(/instance limit.*Close an App/);
    expect([...registry.getState().instancesByBridgeId.keys()]).toEqual([
      "first",
    ]);
  });

  it("counts live tool owners, not every bridge ever registered", async () => {
    const registry = createAppToolsRegistry({
      maxInstances: 1,
      maxIdentities: 2,
    });
    // Well past the old lifetime cap: each closed App frees its identity.
    for (let i = 0; i < 2100; i += 1) {
      const bridgeId = `bridge-${i}`;
      await registry
        .getState()
        .registerInstance(
          instance(bridgeId, { parentToolCallId: `call-${i}` })
        );
      expect(registry.getState().instancesByBridgeId.has(bridgeId)).toBe(true);
      registry.getState().unregisterInstance(bridgeId);
    }
    expect(registry.getState().instancesByBridgeId.size).toBe(0);
    expect(registry.getState().aliases.size).toBe(0);
  });

  it("still invalidates a registration that is hashing when its bridge closes", async () => {
    const registry = createAppToolsRegistry();
    const pending = registry.getState().registerInstance(instance("late"));
    registry.getState().unregisterInstance("late");
    await pending;
    expect(registry.getState().instancesByBridgeId.size).toBe(0);
    // And the same bridge can register again afterwards.
    await registry.getState().registerInstance(instance("late"));
    expect([...registry.getState().instancesByBridgeId.keys()]).toEqual([
      "late",
    ]);
  });
});
