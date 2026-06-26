import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ServerWithName } from "@/state/app-types";

const mockListTools = vi.fn();
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (...args: unknown[]) => mockListTools(...args),
}));

// useWidgetUsage (used by useHostCompatReports, not the hook under test) reads
// resources; stub it so importing the module doesn't drag real fetches in.
vi.mock("@/lib/host-compat/use-widget-usage", () => ({
  useWidgetUsage: () => undefined,
}));

import { useServerToolsData } from "@/lib/host-compat/use-host-compat";

const connected = (name: string): ServerWithName =>
  ({
    name,
    connectionStatus: "connected",
    lastConnectionTime: new Date(),
    config: { url: "https://example.com/mcp" },
  }) as ServerWithName;

const disconnected = (name: string): ServerWithName =>
  ({ ...connected(name), connectionStatus: "disconnected" }) as ServerWithName;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useServerToolsData", () => {
  it("does not fetch for a null or disconnected server", () => {
    const { result, rerender } = renderHook(
      ({ s }: { s: ServerWithName | null }) => useServerToolsData(s),
      { initialProps: { s: null as ServerWithName | null } },
    );
    expect(result.current).toBeNull();
    rerender({ s: disconnected("s1") });
    expect(result.current).toBeNull();
    expect(mockListTools).not.toHaveBeenCalled();
  });

  it("fetches and returns tools for a connected server", async () => {
    const data = { tools: [] };
    mockListTools.mockResolvedValue(data);
    const { result } = renderHook(() => useServerToolsData(connected("s1")));
    await waitFor(() => expect(result.current).toBe(data));
    expect(mockListTools).toHaveBeenCalledWith({ serverId: "s1" });
  });

  it("clears prior tools when the active server switches (no stale bleed)", async () => {
    const a = { tools: [{ name: "a" }] };
    mockListTools.mockResolvedValueOnce(a);
    const { result, rerender } = renderHook(
      ({ s }: { s: ServerWithName }) => useServerToolsData(s),
      { initialProps: { s: connected("a") } },
    );
    await waitFor(() => expect(result.current).toBe(a));

    // Switch to b whose fetch never resolves: the effect must clear to null
    // immediately, never leave server a's tools showing under server b.
    mockListTools.mockReturnValueOnce(new Promise(() => {}));
    rerender({ s: connected("b") });
    expect(result.current).toBeNull();
  });

  it("retries on failure up to the max attempts, then stops", async () => {
    vi.useFakeTimers();
    mockListTools.mockRejectedValue(new Error("boom"));
    renderHook(() => useServerToolsData(connected("s1")));
    // Attempt 0 fires synchronously on mount.
    expect(mockListTools).toHaveBeenCalledTimes(1);
    // Flush the rejection + backoff timers for the two retries.
    await vi.runAllTimersAsync();
    expect(mockListTools).toHaveBeenCalledTimes(3); // TOOLS_FETCH_MAX_ATTEMPTS
    vi.useRealTimers();
  });
});
