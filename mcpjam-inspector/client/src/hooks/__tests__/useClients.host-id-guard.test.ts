import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldQueryHostId, useHost } from "../useClients";

const { mockDbUserReady, mockUseMutation, mockUseQuery } = vi.hoisted(() => ({
  mockDbUserReady: { value: true },
  mockUseMutation: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: mockUseMutation,
  useQuery: mockUseQuery,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mockDbUserReady.value,
}));

// A real Convex document id: a long lowercase base32 string, nothing like the
// short catalog slugs (`chatgpt`, `claude`, `claude-code`) the hosts catalog
// uses for the same clients.
const CONVEX_HOST_ID = "m17b6q9xw2tv4kz8p3r5s0dc";

describe("shouldQueryHostId", () => {
  it("rejects catalog slugs, which reach `/hosts/:hostId` from typed or shared URLs", () => {
    expect(shouldQueryHostId("chatgpt")).toBe(false);
    expect(shouldQueryHostId("claude")).toBe(false);
    expect(shouldQueryHostId("claude-code")).toBe(false);
  });

  it("rejects empty, missing, and sentinel ids", () => {
    expect(shouldQueryHostId(null)).toBe(false);
    expect(shouldQueryHostId(undefined)).toBe(false);
    expect(shouldQueryHostId("")).toBe(false);
    expect(shouldQueryHostId("   ")).toBe(false);
    expect(shouldQueryHostId("none")).toBe(false);
    expect(shouldQueryHostId("undefined")).toBe(false);
  });

  it("rejects ids that carry separators a Convex id never contains", () => {
    // Long enough, but a UUID/local placeholder is still not a document id.
    expect(shouldQueryHostId("a3ae0f26-0747-4ef0-963f-2c93fbadbeef")).toBe(
      false,
    );
    expect(shouldQueryHostId("local_1234567890123456789")).toBe(false);
  });

  it("accepts a real Convex host id, with or without stray whitespace", () => {
    expect(shouldQueryHostId(CONVEX_HOST_ID)).toBe(true);
    expect(shouldQueryHostId(` ${CONVEX_HOST_ID} `)).toBe(true);
  });
});

describe("useHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbUserReady.value = true;
    mockUseMutation.mockReturnValue(vi.fn());
  });

  // The bug behind the `[CONVEX Q(hosts:getHost)] Server Error` in Sentry: the
  // slug was sent, failed `hosts:getHost`'s `v.id("hosts")` argument validator,
  // and a production deployment redacted the reason away. The backend now reads
  // a malformed id as not-found; a value that cannot resolve to a host should
  // still not be sent.
  it("skips the query for a catalog slug that can never resolve", () => {
    const { result } = renderHook(() =>
      useHost({ isAuthenticated: true, hostId: "chatgpt" }),
    );

    expect(mockUseQuery).toHaveBeenCalledWith("hosts:getHost", "skip");
    expect(result.current.host).toBeNull();
    // A skipped query is not a pending one — the canvas must not spin forever.
    expect(result.current.isLoading).toBe(false);
  });

  it("queries with the trimmed id for a real Convex host id", () => {
    mockUseQuery.mockReturnValue(null);

    renderHook(() =>
      useHost({ isAuthenticated: true, hostId: ` ${CONVEX_HOST_ID} ` }),
    );

    expect(mockUseQuery).toHaveBeenCalledWith("hosts:getHost", {
      hostId: CONVEX_HOST_ID,
    });
  });

  it("skips the query while signed out", () => {
    renderHook(() =>
      useHost({ isAuthenticated: false, hostId: CONVEX_HOST_ID }),
    );

    expect(mockUseQuery).toHaveBeenCalledWith("hosts:getHost", "skip");
  });

  it("still reports loading while a real query is in flight", () => {
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() =>
      useHost({ isAuthenticated: true, hostId: CONVEX_HOST_ID }),
    );

    expect(result.current.isLoading).toBe(true);
  });

  it("reports loading while an authenticated host waits for the database user", () => {
    mockDbUserReady.value = false;

    const { result } = renderHook(() =>
      useHost({ isAuthenticated: true, hostId: CONVEX_HOST_ID }),
    );

    expect(mockUseQuery).toHaveBeenCalledWith("hosts:getHost", "skip");
    expect(result.current.host).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });
});
