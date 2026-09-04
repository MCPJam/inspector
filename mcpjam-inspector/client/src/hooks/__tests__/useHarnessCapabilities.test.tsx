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

/**
 * `pending` never settles — the window in which the previous harness's answer
 * is still in state. The rest are the ways the endpoint can let the caller
 * down, each of which must degrade to "I don't know" rather than to a guess.
 */
type MockEntry =
  HarnessCapabilities | "pending" | "reject" | "not-ok" | "malformed";

function mockFetch(byHarness: Record<string, MockEntry>) {
  return vi.fn((url: string) => {
    const id = decodeURIComponent(
      url.replace("/api/v1/harness/", "").replace("/capabilities", ""),
    );
    const entry = byHarness[id];
    if (entry === "pending" || entry === undefined)
      return new Promise(() => {});
    if (entry === "reject") return Promise.reject(new Error("network down"));
    if (entry === "not-ok") {
      return Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response);
    }
    if (entry === "malformed") {
      return Promise.resolve({
        ok: true,
        status: 200,
        // 200 with a body that is not the DTO: a proxy's error page, or an
        // endpoint that moved. `res.ok` alone does not catch this.
        json: async () => ({ notTheDto: true }),
      } as Response);
    }
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

  it("treats an empty harness id like an absent one, without a request", () => {
    // `""` is falsy, so the hook must take the emulated-host path. If it ever
    // fell through it would fetch `/api/v1/harness//capabilities`, which is a
    // different route.
    const fetchMock = mockFetch({});
    (globalThis as any).__authFetch = fetchMock;
    const { result } = renderHook(() => useHarnessCapabilities(""));
    expect(result.current.capabilities).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
   * THE SOFT-FAIL CONTRACT, three ways.
   *
   * Every one of these has to end at `undefined` with `loading` cleared, so the
   * caller falls back to the static map — the pre-existing behaviour. The two
   * bad outcomes are symmetric and both real: a hook that keeps `loading: true`
   * forever leaves the switch disabled on a runtime that supports approval, and
   * one that invents a value flips a security-relevant control off an error page.
   */
  it.each([
    ["a rejected request", "reject"],
    ["a non-OK response", "not-ok"],
    ["a 200 whose body is not the DTO", "malformed"],
  ] as const)("soft-fails to undefined on %s", async (_label, entry) => {
    (globalThis as any).__authFetch = mockFetch({ "claude-code": entry });
    const { result } = renderHook(() => useHarnessCapabilities("claude-code"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.capabilities).toBeUndefined();
  });

  it("does not cache a failure, so a later mount retries", async () => {
    // A transient 500 must not poison the answer for the life of the session:
    // the cache exists to avoid refetching a STATIC answer, not to remember
    // that the server was briefly unreachable.
    (globalThis as any).__authFetch = mockFetch({ "claude-code": "not-ok" });
    const first = renderHook(() => useHarnessCapabilities("claude-code"));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.capabilities).toBeUndefined();

    (globalThis as any).__authFetch = mockFetch({ "claude-code": CLAUDE });
    const second = renderHook(() => useHarnessCapabilities("claude-code"));
    await waitFor(() =>
      expect(second.result.current.capabilities?.harnessId).toBe("claude-code"),
    );
  });
});
