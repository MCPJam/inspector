import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
}));

// Partial-mock the SDK module so `fetchHostCompatCatalog` is controllable while
// the real `bundledHostCompatCatalog`/profiles/engine keep working.
vi.mock("@mcpjam/sdk/host-compat", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@mcpjam/sdk/host-compat")
  >();
  return { ...actual, fetchHostCompatCatalog: vi.fn() };
});

vi.mock("@/lib/analytics", () => ({
  track: trackMock,
}));

import {
  bundledHostCompatCatalog,
  fetchHostCompatCatalog,
  getCatalogHosts,
  getCatalogTemplate,
  type FetchHostCompatCatalogResult,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";
import { evaluateAllHosts } from "../engine";
import { getHostProfiles } from "../profiles";
import { useHostCatalog, resetHostCatalogForTests } from "../use-host-catalog";

const fetchMock = vi.mocked(fetchHostCompatCatalog);

// Client-side live-catalog plumbing: the logo join over catalog-built
// profiles (incl. the unknown-host placeholder) and the engine's
// bundled-fallback behavior when no live catalog is present. The fetch/parse
// mechanics live in the SDK (`sdk/tests/host-compat-catalog.test.ts`); the
// proxy fallback lives in `server/routes/v1/__tests__/host-catalog.test.ts`.

const cloneCatalog = (): HostCompatCatalog =>
  JSON.parse(JSON.stringify(bundledHostCompatCatalog())) as HostCompatCatalog;

const liveResult = (version = 5): FetchHostCompatCatalogResult => ({
  ok: true,
  catalog: cloneCatalog(),
  version,
  contentHash: "abc",
  publishedAt: 1750000000000,
  source: "live",
});

describe("getHostProfiles", () => {
  it("without a catalog, matches the cached bundled profiles", () => {
    expect(getHostProfiles()).toEqual(getHostProfiles(null));
    // Track the bundled catalog's own hosts rather than a hard-coded count so
    // this doesn't go stale when the catalog gains/loses a host.
    expect(
      getHostProfiles()
        .map((p) => p.id)
        .sort()
    ).toEqual(
      getCatalogHosts(bundledHostCompatCatalog())
        .map((h) => h.id)
        .sort()
    );
  });

  it("joins known logos onto catalog-built profiles", () => {
    const profiles = getHostProfiles(cloneCatalog());
    const cursor = profiles.find((p) => p.id === "cursor");
    expect(cursor?.logoSrc).toBe("/cursor_logo.png");
  });

  it("gives an unknown live-catalog host the placeholder logo (no broken img)", () => {
    const catalog = cloneCatalog();
    catalog.hostsById["brand-new-host"] = {
      ...catalog.hostsById.claude,
      id: "brand-new-host",
      label: "Brand New",
      provenance: "vendor-doc",
      rendersMcpApps: true,
      hostStyle: "brand-new-host",
    };
    const added = getHostProfiles(catalog).find(
      (p) => p.id === "brand-new-host"
    );
    expect(added?.logoSrc).toBe("/mcp.svg");
    expect(added?.logoSrcByTheme).toBeUndefined();
  });
});

describe("evaluateAllHosts catalog threading", () => {
  it("no catalog ⇒ bundled market hosts", () => {
    const { reports } = evaluateAllHosts(null, undefined, undefined);
    // Track the bundled catalog rather than a hard-coded count so this stays
    // green when MARKET_HOSTS gains/loses a host.
    expect(reports).toHaveLength(
      getCatalogHosts(bundledHostCompatCatalog()).length
    );
  });

  it("live catalog drives both verdict rows and presentation join", () => {
    const catalog = cloneCatalog();
    for (const id of Object.keys(catalog.hostsById)) {
      if (id !== "claude") delete catalog.hostsById[id];
    }
    const { reports } = evaluateAllHosts(null, undefined, undefined, catalog);
    expect(reports.map((r) => r.hostId)).toEqual(["claude"]);
    expect(reports[0].logoSrc).toBe("/claude_logo.png");
    expect(reports[0].rendersWidgets).toBe(true);
  });
});

describe("useHostCatalog", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetHostCatalogForTests();
    fetchMock.mockReset();
    trackMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    resetHostCatalogForTests();
    warnSpy.mockRestore();
  });

  it("starts loading, then exposes the live catalog once the fetch resolves", async () => {
    fetchMock.mockResolvedValue(liveResult(5));
    const { result } = renderHook(() => useHostCatalog());
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.source).toBe("live");
    expect(result.current.version).toBe(5);
  });

  it("exposes fallback status when the proxy served its bundled fallback", async () => {
    fetchMock.mockResolvedValue({ ...liveResult(0), source: "bundled" });
    const { result } = renderHook(() => useHostCatalog());
    await waitFor(() => expect(result.current.status).toBe("fallback"));
    expect(result.current.source).toBe("bundled");
    expect(
      getCatalogTemplate(result.current.catalog!, "mcpjam")?.hostStyle
    ).toBe("mcpjam");
    expect(trackMock).toHaveBeenCalledWith("host_catalog_degraded", {
      location: "host_catalog",
      status: "fallback",
      source: "bundled",
      version: 0,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[host-catalog] client catalog degraded",
      expect.objectContaining({ status: "fallback" })
    );
  });

  it("exposes error status when the fetch fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, reason: "network" });
    const { result } = renderHook(() => useHostCatalog());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.catalog).toBeNull();
    expect(trackMock).toHaveBeenCalledWith("host_catalog_degraded", {
      location: "host_catalog",
      status: "error",
      reason: "network",
    });
  });

  it("dedupes the fetch across concurrent consumers", async () => {
    fetchMock.mockResolvedValue(liveResult(5));
    const a = renderHook(() => useHostCatalog());
    const b = renderHook(() => useHostCatalog());
    await waitFor(() => expect(a.result.current.status).toBe("live"));
    await waitFor(() => expect(b.result.current.status).toBe("live"));
    // Module-level in-flight dedup: one fetch served both consumers.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a consumer mounting after the cache is populated sees live immediately", async () => {
    fetchMock.mockResolvedValue(liveResult(7));
    const first = renderHook(() => useHostCatalog());
    await waitFor(() => expect(first.result.current.status).toBe("live"));
    // Second mount reads the populated module cache synchronously.
    const second = renderHook(() => useHostCatalog());
    expect(second.result.current.version).toBe(7);
  });

  it("resetHostCatalogForTests clears the memo between cases", async () => {
    fetchMock.mockResolvedValue(liveResult(5));
    const first = renderHook(() => useHostCatalog());
    await waitFor(() => expect(first.result.current.status).toBe("live"));

    resetHostCatalogForTests();
    // A fresh mount after reset starts from loading again (memo cleared) rather
    // than leaking the prior catalog.
    fetchMock.mockResolvedValue({ ok: false, reason: "network" });
    const second = renderHook(() => useHostCatalog());
    expect(second.result.current.status).toBe("loading");
  });
});
