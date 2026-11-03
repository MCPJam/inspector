import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHarnessBuiltinTools } from "../useHarnessBuiltinTools";

const mocks = vi.hoisted(() => ({
  config: {} as { agentLoop?: string; harness?: string },
  fetch: vi.fn(),
}));
vi.mock("convex/react", () => ({ useConvexAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/hooks/useClients", () => ({ useHost: () => ({ host: { config: mocks.config } }) }));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.fetch }));

describe("runtime metadata for client-owned agent loops", () => {
  it("loads the selected runtime catalog and clears it for a legacy emulated client", async () => {
    mocks.config = { agentLoop: "codex" };
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ key: "shell", name: "Shell", description: "Run a command" }] }),
    });
    const { result, rerender } = renderHook(() => useHarnessBuiltinTools("client"));
    await waitFor(() => expect(result.current.tools).toHaveLength(1));
    expect(result.current.harnessId).toBe("codex");
    expect(mocks.fetch).toHaveBeenCalledWith("/api/v1/harness/codex/builtin-tools", expect.any(Object));
    act(() => { mocks.config = {}; rerender(); });
    expect(result.current.harnessId).toBeNull();
    expect(result.current.tools).toEqual([]);
  });
});
