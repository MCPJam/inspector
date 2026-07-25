/**
 * The bridge's contract: stable wrappers registered once per mount, latest
 * closures consulted at dispatch time, and complete teardown on unmount.
 */
import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake group for "evals" so the group-registration path is exercisable
// while the real SURFACE_TOOL_GROUPS map is still empty.
vi.mock("../groups", () => ({
  SURFACE_TOOL_GROUPS: {
    evals: {
      surfaceId: "evals",
      buildTools: () => [
        {
          name: "ui_evals_probe",
          description: "Test-only group tool for the bridge suite.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          readOnly: true,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          execute: async () => ({
            content: [{ type: "text" as const, text: "ok" }],
          }),
        },
      ],
    },
  },
  listSurfaceGroupToolNames: (id: string) =>
    id === "evals" ? ["ui_evals_probe"] : [],
}));

// Wrap (not replace) the registration entry points so call counts are
// observable while real semantics stay intact.
vi.mock("@/lib/inspector-command-handlers", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/inspector-command-handlers")
    >();
  return {
    ...actual,
    registerInspectorCommandHandler: vi.fn(
      actual.registerInspectorCommandHandler,
    ),
  };
});
vi.mock("../surface-snapshot-registry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../surface-snapshot-registry")>();
  return {
    ...actual,
    registerSurfaceSnapshotProvider: vi.fn(
      actual.registerSurfaceSnapshotProvider,
    ),
  };
});

import {
  executeInspectorCommand,
  hasInspectorCommandHandler,
  registerInspectorCommandHandler,
} from "@/lib/inspector-command-handlers";
import type { InspectorCommand } from "@/shared/inspector-command.js";
import { useUiToolsRegistry } from "../ui-tools-registry";
import {
  __resetSurfaceSnapshotProvidersForTests,
  hasSurfaceSnapshotProvider,
  readSurfaceSnapshot,
  registerSurfaceSnapshotProvider,
} from "../surface-snapshot-registry";
import {
  useSurfaceAgentBridge,
  type SurfaceAgentBridgeOptions,
} from "../use-surface-agent-bridge";

function selectToolCommand(): InspectorCommand {
  return {
    id: "cmd-1",
    type: "selectTool",
    payload: { surface: "playground", toolName: "echo" },
  } as InspectorCommand;
}

describe("useSurfaceAgentBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiToolsRegistry.setState({
      tools: new Map(),
      globalNames: new Set(),
      shippedNames: new Set(),
    });
    __resetSurfaceSnapshotProvidersForTests();
  });

  it("registers group tools, handlers, and snapshot provider; unmount removes all three", async () => {
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "evals",
        handlers: { selectTool: () => ({ selected: true }) },
        snapshot: () => ({ open: "suite-1" }),
      }),
    );

    expect(
      useUiToolsRegistry.getState().resolve("ui_evals_probe"),
    ).not.toBeNull();
    // Surface scope, not global: group tools must sit behind the catalog in
    // the snapshot's 64-entry cap.
    expect(
      useUiToolsRegistry.getState().globalNames.has("ui_evals_probe"),
    ).toBe(false);
    expect(hasInspectorCommandHandler("selectTool")).toBe(true);
    expect(hasSurfaceSnapshotProvider("evals")).toBe(true);
    const snapshot = await readSurfaceSnapshot("evals");
    expect(snapshot).toEqual({ ok: true, data: { open: "suite-1" } });

    unmount();
    expect(useUiToolsRegistry.getState().resolve("ui_evals_probe")).toBeNull();
    expect(hasInspectorCommandHandler("selectTool")).toBe(false);
    expect(hasSurfaceSnapshotProvider("evals")).toBe(false);
  });

  it("rerenders with fresh closures re-register nothing, yet dispatch sees the latest closure", async () => {
    const initialUiToolCount = useUiToolsRegistry.getState().tools.size;
    const { rerender } = renderHook(
      (props: SurfaceAgentBridgeOptions) => useSurfaceAgentBridge(props),
      {
        initialProps: {
          surfaceId: "evals",
          handlers: { selectTool: () => "v1" },
          snapshot: () => ({ version: 1 }),
        } as SurfaceAgentBridgeOptions,
      },
    );

    const handlerRegistrations = vi.mocked(registerInspectorCommandHandler)
      .mock.calls.length;
    const providerRegistrations = vi.mocked(registerSurfaceSnapshotProvider)
      .mock.calls.length;
    expect(handlerRegistrations).toBe(1);
    expect(providerRegistrations).toBe(1);
    expect(useUiToolsRegistry.getState().tools.size).toBe(
      initialUiToolCount + 1,
    );

    // New object identities and new closures every render — the steady-state
    // React reality the stable-ref contract exists for.
    rerender({
      surfaceId: "evals",
      handlers: { selectTool: () => "v2" },
      snapshot: () => ({ version: 2 }),
    });
    rerender({
      surfaceId: "evals",
      handlers: { selectTool: () => "v3" },
      snapshot: () => ({ version: 3 }),
    });

    expect(
      vi.mocked(registerInspectorCommandHandler).mock.calls.length,
    ).toBe(handlerRegistrations);
    expect(
      vi.mocked(registerSurfaceSnapshotProvider).mock.calls.length,
    ).toBe(providerRegistrations);
    expect(useUiToolsRegistry.getState().tools.size).toBe(
      initialUiToolCount + 1,
    );

    const response = await executeInspectorCommand(selectToolCommand());
    expect(response).toMatchObject({ status: "success", result: "v3" });
    const snapshot = await readSurfaceSnapshot("evals");
    expect(snapshot).toEqual({ ok: true, data: { version: 3 } });
  });

  it("a handler entry that vanishes after mount falls through as unsupported_in_mode", async () => {
    const { rerender } = renderHook(
      (props: SurfaceAgentBridgeOptions) => useSurfaceAgentBridge(props),
      {
        initialProps: {
          surfaceId: "evals",
          handlers: { selectTool: () => "live" },
        } as SurfaceAgentBridgeOptions,
      },
    );

    rerender({ surfaceId: "evals", handlers: {} });

    // Wrapper still registered (key set is fixed at mount)…
    expect(hasInspectorCommandHandler("selectTool")).toBe(true);
    // …but dispatch gets the bus's fall-through error, same as unregistered.
    const response = await executeInspectorCommand(selectToolCommand());
    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
  });

  it("survives StrictMode's setup/cleanup/setup without double registration", async () => {
    const { unmount } = renderHook(
      () =>
        useSurfaceAgentBridge({
          surfaceId: "evals",
          handlers: { selectTool: () => "strict" },
          snapshot: () => ({ strict: true }),
        }),
      { wrapper: StrictMode },
    );

    // Exactly one live registration of each kind after the double-mount.
    expect(
      useUiToolsRegistry.getState().resolve("ui_evals_probe"),
    ).not.toBeNull();
    expect(useUiToolsRegistry.getState().tools.size).toBe(1);
    const response = await executeInspectorCommand(selectToolCommand());
    expect(response).toMatchObject({ status: "success", result: "strict" });
    expect(hasSurfaceSnapshotProvider("evals")).toBe(true);

    unmount();
    expect(useUiToolsRegistry.getState().tools.size).toBe(0);
    expect(hasInspectorCommandHandler("selectTool")).toBe(false);
    expect(hasSurfaceSnapshotProvider("evals")).toBe(false);
  });

  it("a surface with no tool group registers handlers and snapshot only", () => {
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "home",
        handlers: { selectTool: () => "home" },
        snapshot: () => ({ home: true }),
      }),
    );

    expect(useUiToolsRegistry.getState().tools.size).toBe(0);
    expect(hasInspectorCommandHandler("selectTool")).toBe(true);
    expect(hasSurfaceSnapshotProvider("home")).toBe(true);
    unmount();
    expect(hasInspectorCommandHandler("selectTool")).toBe(false);
    expect(hasSurfaceSnapshotProvider("home")).toBe(false);
  });

  it("registers no snapshot provider when the prop is absent at mount", () => {
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({ surfaceId: "home" }),
    );
    expect(vi.mocked(registerSurfaceSnapshotProvider)).not.toHaveBeenCalled();
    expect(hasSurfaceSnapshotProvider("home")).toBe(false);
    unmount();
  });
});
