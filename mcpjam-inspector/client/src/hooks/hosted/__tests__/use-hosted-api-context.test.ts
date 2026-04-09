/**
 * useHostedApiContext — guest session cleanup on sign-in
 *
 * When isAuthenticated transitions from false → true, the hook must
 * clear the stale guest session from localStorage so that no code path
 * can accidentally reuse an expired guest bearer after sign-in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/guest-session", () => ({
  clearGuestSession: vi.fn(),
}));

vi.mock("@/lib/apis/web/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apis/web/context")>(
    "@/lib/apis/web/context",
  );
  return {
    ...actual,
    setHostedApiContext: vi.fn(),
    resetTokenCache: vi.fn(),
  };
});

import { useHostedApiContext } from "../use-hosted-api-context";
import { clearGuestSession } from "@/lib/guest-session";
import {
  setHostedApiContext,
  resetTokenCache,
} from "@/lib/apis/web/context";

function buildProps(overrides: Partial<Parameters<typeof useHostedApiContext>[0]> = {}) {
  return {
    workspaceId: null as string | null,
    serverIdsByName: {} as Record<string, string>,
    getAccessToken: vi.fn(async () => null as string | undefined | null),
    isAuthenticated: false,
    ...overrides,
  };
}

describe("useHostedApiContext guest cleanup on sign-in", () => {
  beforeEach(() => {
    vi.mocked(setHostedApiContext).mockClear();
    vi.mocked(resetTokenCache).mockClear();
    vi.mocked(clearGuestSession).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears guest session when isAuthenticated transitions false → true", () => {
    const props = buildProps({ isAuthenticated: false });
    const { rerender } = renderHook(
      (p: Parameters<typeof useHostedApiContext>[0]) => useHostedApiContext(p),
      { initialProps: props },
    );

    vi.mocked(clearGuestSession).mockClear();

    // Simulate sign-in: isAuthenticated flips to true
    rerender(buildProps({ isAuthenticated: true }));

    expect(clearGuestSession).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear guest session on initial render when already authenticated", () => {
    renderHook(
      (p: Parameters<typeof useHostedApiContext>[0]) => useHostedApiContext(p),
      { initialProps: buildProps({ isAuthenticated: true }) },
    );

    // Should not clear on mount — only on transition
    expect(clearGuestSession).not.toHaveBeenCalled();
  });

  it("does NOT clear guest session when isAuthenticated stays false", () => {
    const props = buildProps({ isAuthenticated: false });
    const { rerender } = renderHook(
      (p: Parameters<typeof useHostedApiContext>[0]) => useHostedApiContext(p),
      { initialProps: props },
    );

    vi.mocked(clearGuestSession).mockClear();

    rerender(buildProps({ isAuthenticated: false, workspaceId: "ws-1" }));

    expect(clearGuestSession).not.toHaveBeenCalled();
  });

  it("clears guest session only once per transition, not on every re-render while authenticated", () => {
    const props = buildProps({ isAuthenticated: false });
    const { rerender } = renderHook(
      (p: Parameters<typeof useHostedApiContext>[0]) => useHostedApiContext(p),
      { initialProps: props },
    );

    vi.mocked(clearGuestSession).mockClear();

    // Transition to authenticated
    rerender(buildProps({ isAuthenticated: true }));
    expect(clearGuestSession).toHaveBeenCalledTimes(1);

    vi.mocked(clearGuestSession).mockClear();

    // Re-render while still authenticated (workspace loads)
    rerender(buildProps({ isAuthenticated: true, workspaceId: "ws-1" }));
    expect(clearGuestSession).not.toHaveBeenCalled();
  });
});
