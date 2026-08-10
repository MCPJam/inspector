import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * Parser back-compat matrix for the /config shape. The rule under test: the
 * `engines` block is always present POST-PARSE — a server that predates it
 * (or sends a malformed block) gets the legacy-pair derivation, in which the
 * local engine NEVER exists (an old server has no local engine to offer).
 *
 * `vi.resetModules()` per test: the module caches its first parsed answer.
 */
describe("useComputersDataPlaneConfig — engines parse", () => {
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

  it("parses the full new shape", async () => {
    const mod = await loadWithConfig({
      localConfigured: false,
      remoteDataPlaneUrl: null,
      engines: {
        local: {
          available: true,
          terminalAvailable: true,
          workspaceDisplayRoot: "~/.mcpjam/computer",
        },
        cloud: { available: true },
      },
      capabilities: {
        personalCloudAvailable: true,
        ephemeralCloudAvailable: false,
      },
      defaultEngine: "local",
    });
    const { result } = renderHook(() => mod.useComputersDataPlaneConfig());
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.engines.local).toEqual({
      available: true,
      terminalAvailable: true,
      workspaceDisplayRoot: "~/.mcpjam/computer",
    });
    expect(result.current!.defaultEngine).toBe("local");
  });

  it("derives for an OLD server: local never exists, cloud from the legacy pair", async () => {
    const mod = await loadWithConfig({
      localConfigured: false,
      remoteDataPlaneUrl: "https://dp.example.com",
    });
    const { result } = renderHook(() => mod.useComputersDataPlaneConfig());
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.engines.local.available).toBe(false);
    expect(result.current!.engines.cloud.available).toBe(true);
    expect(result.current!.defaultEngine).toBe("cloud");
  });

  it("reads a MALFORMED engines block like an old server — never half-trusted", async () => {
    const mod = await loadWithConfig({
      localConfigured: false,
      remoteDataPlaneUrl: null,
      engines: { local: { available: "yes" }, cloud: {} },
      defaultEngine: "local",
    });
    const { result } = renderHook(() => mod.useComputersDataPlaneConfig());
    await waitFor(() => expect(result.current).toBeDefined());
    // A partial parse could invent a local engine; derivation cannot.
    expect(result.current!.engines.local.available).toBe(false);
    expect(result.current!.defaultEngine).toBeNull();
  });

  it("tolerates defaultEngine null (no engine exists on that server)", async () => {
    const mod = await loadWithConfig({
      localConfigured: false,
      remoteDataPlaneUrl: null,
      engines: {
        local: {
          available: false,
          terminalAvailable: false,
          workspaceDisplayRoot: null,
          reason: "disabled",
        },
        cloud: { available: false },
      },
      defaultEngine: null,
    });
    const { result } = renderHook(() => mod.useComputersDataPlaneConfig());
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.defaultEngine).toBeNull();
    expect(result.current!.engines.local.reason).toBe("disabled");
  });

  it("fetch-failure fallback keeps legacy semantics — no phantom local engine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const mod = await import("../useProjectComputer");
    const { result } = renderHook(() => mod.useComputersDataPlaneConfig());
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.localConfigured).toBe(true);
    expect(result.current!.engines.local.available).toBe(false);
    expect(result.current!.engines.cloud.available).toBe(true);
  });
});
