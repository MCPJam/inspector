import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import { evaluateAllHosts } from "../engine";
import { getHostProfiles } from "../profiles";

// Client-side live-catalog plumbing: the logo join over catalog-built
// profiles (incl. the unknown-host placeholder) and the engine's
// bundled-fallback behavior when no live catalog is present. The fetch/parse
// mechanics live in the SDK (`sdk/tests/host-compat-catalog.test.ts`); the
// proxy fallback lives in `server/routes/v1/__tests__/host-catalog.test.ts`.

const cloneCatalog = () =>
  JSON.parse(JSON.stringify(bundledHostCompatCatalog()));

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
      bundledHostCompatCatalog()
        .marketHosts.map((h) => h.id)
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
    catalog.marketHosts.push({
      id: "brand-new-host",
      label: "Brand New",
      provenance: "vendor-doc",
      rendersMcpApps: true,
    });
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
    expect(reports).toHaveLength(bundledHostCompatCatalog().marketHosts.length);
  });

  it("live catalog drives both verdict rows and presentation join", () => {
    const catalog = cloneCatalog();
    catalog.marketHosts = catalog.marketHosts.filter(
      (h: { id: string }) => h.id === "claude"
    );
    const { reports } = evaluateAllHosts(null, undefined, undefined, catalog);
    expect(reports.map((r) => r.hostId)).toEqual(["claude"]);
    expect(reports[0].logoSrc).toBe("/claude_logo.png");
    expect(reports[0].rendersWidgets).toBe(true);
  });
});
