import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * The preflight bit the cloud-only surfaces (swarms / evals / user testing)
 * read before launch. The subtle rows are the derivations: a server that
 * predates `capabilities` falls back to `localConfigured` — NOT to
 * `remoteDataPlaneUrl`, because remote delegation covers only the personal
 * computer and says nothing about executing in disposable sandboxes.
 *
 * `vi.resetModules()` per test because the module caches its first parsed
 * /config answer for the whole SPA session.
 */
describe("useEphemeralCloudAvailable", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  async function loadWithConfig(response: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => response })),
    );
    return await import("../useProjectComputer");
  }

  it("reads capabilities.ephemeralCloudAvailable when the server sends it", async () => {
    const mod = await loadWithConfig({
      localConfigured: true,
      remoteDataPlaneUrl: null,
      capabilities: { ephemeralCloudAvailable: false },
    });
    const { result } = renderHook(() => mod.useEphemeralCloudAvailable());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("derives from localConfigured on an older server — a remote data plane does NOT count", async () => {
    // Remote-only inspector: personal bash/terminal delegate fine, but not a
    // single disposable-sandbox command can run here.
    const mod = await loadWithConfig({
      localConfigured: false,
      remoteDataPlaneUrl: "https://dp.example.com",
    });
    const { result } = renderHook(() => mod.useEphemeralCloudAvailable());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("is true on an older server that holds the credentials itself", async () => {
    const mod = await loadWithConfig({
      localConfigured: true,
      remoteDataPlaneUrl: null,
    });
    const { result } = renderHook(() => mod.useEphemeralCloudAvailable());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("ignores a non-boolean capabilities value and derives from localConfigured", async () => {
    const mod = await loadWithConfig({
      localConfigured: false,
      remoteDataPlaneUrl: null,
      capabilities: { ephemeralCloudAvailable: "yes" },
    });
    const { result } = renderHook(() => mod.useEphemeralCloudAvailable());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("treats an unparseable body like a fetch failure — per-mount fail-open", async () => {
    const mod = await loadWithConfig(null);
    const { result } = renderHook(() => mod.useEphemeralCloudAvailable());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("fails open on a fetch failure — no scary banners from a flaky request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const mod = await import("../useProjectComputer");
    const { result } = renderHook(() => mod.useEphemeralCloudAvailable());
    await waitFor(() => expect(result.current).toBe(true));
  });
});
