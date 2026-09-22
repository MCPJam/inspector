import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHostedClientCapabilities } from "../use-hosted-client-capabilities";

/**
 * These assert REFERENTIAL stability, not value correctness.
 *
 * A fresh object here re-runs `useApiContext`'s layout effect, which bumps the
 * global API-context revision twice, which re-fires `useAggregatedTools`, which
 * re-fetches /api/web/tools/list, which sets state, which re-renders — an
 * unbounded loop at render speed. On 2026-08-06 that produced ~43 requests per
 * second from a single user.
 */
describe("useHostedClientCapabilities", () => {
  it("keeps the same reference across re-renders when the host has capabilities", () => {
    const hostCaps = { extensions: {} };
    const { result, rerender } = renderHook(
      ({ caps }) => useHostedClientCapabilities(caps, null),
      { initialProps: { caps: hostCaps as unknown } },
    );

    const first = result.current;
    rerender({ caps: hostCaps as unknown });
    rerender({ caps: hostCaps as unknown });

    expect(result.current).toBe(first);
  });

  it("keeps the same reference across re-renders when falling back to defaults", () => {
    // The regression case. An unconnected/failing server leaves host
    // capabilities undefined, so resolution falls through to
    // getDefaultClientCapabilities(), which mints a new object per call.
    // Before the memo this returned a fresh reference on EVERY render.
    const { result, rerender } = renderHook(() =>
      useHostedClientCapabilities(undefined, null),
    );

    const first = result.current;
    rerender();
    rerender();
    rerender();

    expect(result.current).toBe(first);
  });

  it("keeps the same reference when the parent passes a fresh project config object with equal content", () => {
    // Guards the narrower trap: memoizing on a value the parent rebuilds each
    // render would defeat the memo. This documents that the identity contract
    // is only as good as the caller's own stability for this input.
    const config = { clientCapabilities: undefined };
    const { result, rerender } = renderHook(
      ({ cfg }) => useHostedClientCapabilities(undefined, cfg),
      { initialProps: { cfg: config as never } },
    );

    const first = result.current;
    rerender({ cfg: config as never });

    expect(result.current).toBe(first);
  });

  it("produces a new reference when the host actually hydrates capabilities", () => {
    // Stability must not become staleness: a real input change has to
    // propagate, or the API context would keep serving the default forever.
    const { result, rerender } = renderHook(
      ({ caps }) => useHostedClientCapabilities(caps, null),
      { initialProps: { caps: undefined as unknown } },
    );

    const fallback = result.current;
    const hydrated = { extensions: { "io.modelcontextprotocol/ui": {} } };
    rerender({ caps: hydrated as unknown });

    expect(result.current).not.toBe(fallback);
    expect(result.current).toBe(hydrated);
  });
});
