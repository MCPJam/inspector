import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ServerWithName } from "@/state/app-types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";

// ── Mocks ────────────────────────────────────────────────────────────

const mockActiveWorkspaceId = { current: "ws-default" };

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    activeWorkspaceId: mockActiveWorkspaceId.current,
  }),
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: vi.fn(),
}));

// Import after mocks
import { useInspectionCoordinator } from "../use-inspection-coordinator";
import { useInspectionStore } from "@/stores/inspection-store";
import { listTools } from "@/lib/apis/mcp-tools-api";
import { toast } from "sonner";

// ── Helpers ──────────────────────────────────────────────────────────

function createServer(overrides: Partial<ServerWithName> = {}): ServerWithName {
  return {
    name: overrides.name ?? "test-server",
    config: { url: new URL("http://localhost:3000") } as any,
    connectionStatus: "disconnected",
    retryCount: 0,
    lastConnectionTime: new Date(),
    ...overrides,
  } as ServerWithName;
}

function makeToolsResult(
  tools: Array<{ name: string; description?: string }> = [],
): ListToolsResultWithMetadata {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object" as const },
    })),
  };
}

const defaultInitInfo = {
  protocolVersion: "2025-03-26",
  transport: "streamable-http",
  serverVersion: { name: "test-server", version: "1.0.0" },
  instructions: "Be helpful.",
  serverCapabilities: { tools: {} },
};

// ── Tests ────────────────────────────────────────────────────────────

describe("useInspectionCoordinator", () => {
  const onViewChanges = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWorkspaceId.current = "ws-default";
    useInspectionStore.setState({ records: {} });
    vi.mocked(listTools).mockResolvedValue(
      makeToolsResult([{ name: "tool1" }]),
    );
  });

  it("runs inspection on connect transition with initInfo", async () => {
    const { rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useInspectionCoordinator(servers, onViewChanges),
      {
        initialProps: {
          servers: { s1: createServer({ name: "s1" }) },
        },
      },
    );

    // Transition to connected with initInfo
    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          initializationInfo: defaultInitInfo,
        }),
      },
    });

    // Wait for async inspection to complete
    await vi.waitFor(() => {
      expect(listTools).toHaveBeenCalledWith({
        serverId: "s1",
        cursor: undefined,
      });
    });

    // Should have saved a record
    await vi.waitFor(() => {
      const record = useInspectionStore.getState().getRecord("ws-default::s1");
      expect(record).toBeDefined();
      expect(record!.latestDiff).toBeNull(); // first connect
    });
  });

  it("does NOT run when already connected (rerender)", async () => {
    const connectedServer = createServer({
      name: "s1",
      connectionStatus: "connected",
      initializationInfo: defaultInitInfo,
    });

    const { rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useInspectionCoordinator(servers, onViewChanges),
      {
        initialProps: { servers: { s1: connectedServer } },
      },
    );

    // Rerender with same connected status
    rerender({ servers: { s1: connectedServer } });
    rerender({ servers: { s1: connectedServer } });

    // listTools should NOT be called (no transition occurred)
    expect(listTools).not.toHaveBeenCalled();
  });

  it("shows toast only when diff has meaningful changes", async () => {
    // Seed a baseline
    useInspectionStore.getState().saveInspection(
      "ws-default::s1",
      {
        init: { protocolVersion: "2025-03-26" },
        tools: [],
        capturedAt: 1000,
      },
      null,
    );

    // Return different tools on reconnect
    vi.mocked(listTools).mockResolvedValue(
      makeToolsResult([{ name: "new_tool", description: "New!" }]),
    );

    const { rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useInspectionCoordinator(servers, onViewChanges),
      {
        initialProps: {
          servers: { s1: createServer({ name: "s1" }) },
        },
      },
    );

    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          initializationInfo: defaultInitInfo,
        }),
      },
    });

    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Server changes detected",
        expect.objectContaining({
          description: expect.stringContaining("s1"),
        }),
      );
    });
  });

  it("no toast on first connect (no baseline)", async () => {
    const { rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useInspectionCoordinator(servers, onViewChanges),
      {
        initialProps: {
          servers: { s1: createServer({ name: "s1" }) },
        },
      },
    );

    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          initializationInfo: defaultInitInfo,
        }),
      },
    });

    await vi.waitFor(() => {
      expect(
        useInspectionStore.getState().getRecord("ws-default::s1"),
      ).toBeDefined();
    });

    expect(toast).not.toHaveBeenCalled();
  });

  it("inspection failure does not overwrite previous record", async () => {
    const existingSnapshot = {
      init: { protocolVersion: "old" },
      tools: [],
      capturedAt: 1000,
    };
    useInspectionStore
      .getState()
      .saveInspection("ws-default::s1", existingSnapshot, null);

    // Make listTools throw
    vi.mocked(listTools).mockRejectedValue(new Error("network error"));

    const { rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useInspectionCoordinator(servers, onViewChanges),
      {
        initialProps: {
          servers: { s1: createServer({ name: "s1" }) },
        },
      },
    );

    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          initializationInfo: defaultInitInfo,
        }),
      },
    });

    // Wait a tick for async to settle
    await new Promise((r) => setTimeout(r, 50));

    // Previous record should be untouched
    const record = useInspectionStore.getState().getRecord("ws-default::s1");
    expect(record!.latestSnapshot.capturedAt).toBe(1000);
  });

  it("incomplete pagination skips diff and preserves previous baseline", async () => {
    const existingSnapshot = {
      init: { protocolVersion: "old" },
      tools: [],
      capturedAt: 1000,
    };
    useInspectionStore
      .getState()
      .saveInspection("ws-default::s1", existingSnapshot, null);

    // Return page with nextCursor, then fail on second page
    vi.mocked(listTools)
      .mockResolvedValueOnce({
        tools: [{ name: "t1", inputSchema: { type: "object" } }],
        nextCursor: "page2",
      } as any)
      .mockRejectedValueOnce(new Error("pagination failed"));

    const { rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useInspectionCoordinator(servers, onViewChanges),
      {
        initialProps: {
          servers: { s1: createServer({ name: "s1" }) },
        },
      },
    );

    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          initializationInfo: defaultInitInfo,
        }),
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Previous record should be untouched
    const record = useInspectionStore.getState().getRecord("ws-default::s1");
    expect(record!.latestSnapshot.capturedAt).toBe(1000);
    expect(toast).not.toHaveBeenCalled();
  });

  it("discards result if workspace changes before async inspection completes", async () => {
    let resolveTools: (value: any) => void;
    vi.mocked(listTools).mockReturnValue(
      new Promise((resolve) => {
        resolveTools = resolve;
      }),
    );

    const { rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useInspectionCoordinator(servers, onViewChanges),
      {
        initialProps: {
          servers: { s1: createServer({ name: "s1" }) },
        },
      },
    );

    // Trigger inspection
    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          initializationInfo: defaultInitInfo,
        }),
      },
    });

    // Switch workspace while inspection is in-flight
    mockActiveWorkspaceId.current = "ws-other";
    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          initializationInfo: defaultInitInfo,
        }),
      },
    });

    // Now resolve the tools fetch
    resolveTools!(makeToolsResult([{ name: "tool1" }]));
    await new Promise((r) => setTimeout(r, 50));

    // Result should have been discarded (generation mismatch)
    // The old workspace key should not have a record
    expect(
      useInspectionStore.getState().getRecord("ws-default::s1"),
    ).toBeUndefined();
  });

  it("waits for initInfo before running inspection", async () => {
    const { rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useInspectionCoordinator(servers, onViewChanges),
      {
        initialProps: {
          servers: { s1: createServer({ name: "s1" }) },
        },
      },
    );

    // Connected but no initInfo yet
    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          // no initializationInfo
        }),
      },
    });

    // Should not fetch tools yet
    expect(listTools).not.toHaveBeenCalled();

    // Now initInfo arrives
    rerender({
      servers: {
        s1: createServer({
          name: "s1",
          connectionStatus: "connected",
          initializationInfo: defaultInitInfo,
        }),
      },
    });

    await vi.waitFor(() => {
      expect(listTools).toHaveBeenCalled();
    });
  });
});
