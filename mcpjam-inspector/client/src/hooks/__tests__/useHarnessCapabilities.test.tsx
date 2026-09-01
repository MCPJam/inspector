/**
 * The capability probe backs a SWITCH, so a stale answer is not cosmetic: the
 * Behavior tab enables "require tool approval" off `supportsNativeToolApproval`,
 * and a host saved with approval on that its transport cannot honor is refused
 * pre-flight at turn time.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useHarnessCapabilities,
  __resetHarnessCapabilitiesCacheForTests,
  type HarnessCapabilities,
} from "../useHarnessCapabilities";

const CLAUDE: HarnessCapabilities = {
  harnessId: "claude-code",
  supportsNativeToolApproval: true,
  supportsHostExecutedToolApproval: true,
  supportsMcpToolApproval: true,
  mcpDelivery: "native",
};

function mockFetch(byHarness: Record<string, HarnessCapabilities | "pending">) {
  return vi.fn((url: string) => {
    const id = decodeURIComponent(
      url.replace("/api/v1/harness/", "").replace("/capabilities", ""),
    );
    const entry = byHarness[id];
    // A request that never settles is the whole point of the switch case: it is
    // the window in which the previous harness's answer is still in state.
    if (entry === "pending" || entry === undefined) return new Promise(() => {});
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => entry,
    } as Response);
  });
}

vi.mock("@/lib/session-token", () => ({
  authFetch: (url: string, init?: RequestInit) =>
    (globalThis as unknown as { __authFetch: typeof fetch }).__authFetch(
      url,
      init,
    ),
}));

afterEach(() => {
  __resetHarnessCapabilitiesCacheForTests();
  vi.restoreAllMocks();
});

describe("useHarnessCapabilities", () => {
  it("reports the harness it was asked about", async () => {
    (globalThis as any).__authFetch = mockFetch({ "claude-code": CLAUDE });
    const { result } = renderHook(() => useHarnessCapabilities("claude-code"));
    await waitFor(() =>
      expect(result.current.capabilities?.harnessId).toBe("claude-code"),
    );
    expect(result.current.capabilities?.supportsNativeToolApproval).toBe(true);
  });

  it("never reports another harness's capabilities while switching", async () => {
    // Claude Code resolves; Codex never does. Without a synchronous id match the
    // hook keeps returning Claude Code's `supportsNativeToolApproval: true`
    // after the caller has already switched to Codex, and the switch renders
    // enabled for a transport that cannot pause.
    (globalThis as any).__authFetch = mockFetch({
      "claude-code": CLAUDE,
      codex: "pending",
    });
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useHarnessCapabilities(id),
      { initialProps: { id: "claude-code" } },
    );
    await waitFor(() =>
      expect(result.current.capabilities?.harnessId).toBe("claude-code"),
    );

    rerender({ id: "codex" });
    expect(result.current.capabilities).toBeUndefined();

    // And it stays undefined while the real answer is in flight, rather than
    // flickering back to the stale one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.capabilities).toBeUndefined();
  });

  it("reports nothing for an emulated host", () => {
    (globalThis as any).__authFetch = mockFetch({});
    const { result } = renderHook(() => useHarnessCapabilities(null));
    expect(result.current.capabilities).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });
});
