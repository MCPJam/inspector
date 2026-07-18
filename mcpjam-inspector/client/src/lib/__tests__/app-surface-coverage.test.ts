/**
 * Route ↔ surface coverage.
 *
 * The point of this file: a new screen must not be able to ship
 * agent-invisible. If someone adds a route and forgets the manifest, the
 * screen would still work for humans while silently not existing for the
 * assistant — `ui_navigate` couldn't reach it and the atlas wouldn't mention
 * it. That's the failure this catches, and it's why the diff runs BOTH ways.
 *
 * Reads only pure data modules on purpose (see `app-routes.ts`).
 */
import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "../app-routes";
import {
  APP_SURFACES,
  buildAppAtlas,
  getAppSurface,
  isAppSurfaceId,
  listAppSurfaceNavSegments,
} from "@/shared/app-surfaces";
import { routePaths } from "../app-navigation";
import {
  HOSTED_HASH_ALLOWED_TABS,
  HOSTED_HASH_BLOCKED_TABS,
} from "../hosted-tab-policy";

const screenRoutes = APP_ROUTES.filter((r) => r.kind === "screen");

describe("route table ↔ surface manifests", () => {
  it("every screen route names a real surface", () => {
    for (const route of screenRoutes) {
      expect(
        isAppSurfaceId(route.surfaceId),
        `route "${route.path}" names unknown surface "${route.surfaceId}"`,
      ).toBe(true);
    }
  });

  it("every surface is rendered by at least one screen route", () => {
    const rendered = new Set(screenRoutes.map((r) => r.surfaceId));
    const orphans = APP_SURFACES.filter((s) => !rendered.has(s.id)).map(
      (s) => s.id,
    );
    expect(orphans).toEqual([]);
  });

  it("every surface's routePatterns match the routes that render it", () => {
    // Both directions: a manifest can't claim a pattern the router doesn't
    // have, and can't omit one the router points at it.
    for (const surface of APP_SURFACES) {
      const fromTable = screenRoutes
        .filter((r) => r.surfaceId === surface.id)
        .map((r) => r.path)
        .sort();
      expect([...surface.routePatterns].sort(), surface.id).toEqual(fromTable);
    }
  });

  it("every surface's canonicalPath is one of its own routes", () => {
    for (const surface of APP_SURFACES) {
      const normalized = surface.canonicalPath.replace(/^\//, "") || "/";
      const owns = surface.routePatterns.some(
        (p) => p === normalized || p === surface.canonicalPath,
      );
      expect(owns, `${surface.id}: ${surface.canonicalPath}`).toBe(true);
    }
  });

  it("declares no duplicate route paths", () => {
    const paths = APP_ROUTES.map((r) => r.path);
    expect(paths.length).toBe(new Set(paths).size);
  });

  it("declares no duplicate surface ids", () => {
    const ids = APP_SURFACES.map((s) => s.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("surface manifests are model-usable", () => {
  it("every surface documents a purpose and real activities", () => {
    // These strings ARE the agent's understanding of the app. An empty one
    // is a screen it will never think to visit.
    for (const surface of APP_SURFACES) {
      expect(surface.purpose.trim().length, surface.id).toBeGreaterThan(20);
      expect(surface.userActivities.length, surface.id).toBeGreaterThan(0);
      for (const activity of surface.userActivities) {
        expect(activity.trim().length, surface.id).toBeGreaterThan(0);
      }
    }
  });

  it("every surface declares at least one nav segment", () => {
    for (const surface of APP_SURFACES) {
      expect(surface.navSegments.length, surface.id).toBeGreaterThan(0);
    }
  });

  it("no nav segment is claimed by two surfaces", () => {
    const owner = new Map<string, string>();
    for (const surface of APP_SURFACES) {
      for (const segment of surface.navSegments) {
        expect(
          owner.get(segment),
          `segment "${segment}" claimed by ${owner.get(segment)} and ${surface.id}`,
        ).toBeUndefined();
        owner.set(segment, surface.id);
      }
    }
  });

  it("every canonicalPath is a known routePath", () => {
    const known = new Set<string>(Object.values(routePaths));
    for (const surface of APP_SURFACES) {
      expect(known.has(surface.canonicalPath), surface.id).toBe(true);
    }
  });
});

describe("hosted tab policy stays consistent with the manifests", () => {
  it("every hosted policy entry names a real nav segment", () => {
    // The policy filters segments; it must not name one that no longer
    // exists, or it silently stops filtering anything.
    const segments = new Set(listAppSurfaceNavSegments());
    for (const tab of [
      ...HOSTED_HASH_ALLOWED_TABS,
      ...HOSTED_HASH_BLOCKED_TABS,
    ]) {
      expect(segments.has(tab), `policy tab "${tab}"`).toBe(true);
    }
  });

  it("hostedBlocked manifests match the blocked policy list exactly", () => {
    const blockedByManifest = APP_SURFACES.filter((s) => s.hostedBlocked)
      .flatMap((s) => s.navSegments)
      .sort();
    expect(blockedByManifest).toEqual([...HOSTED_HASH_BLOCKED_TABS].sort());
  });
});

describe("buildAppAtlas", () => {
  it("names every atlas surface with a navigable target", () => {
    const atlas = buildAppAtlas();
    for (const surface of APP_SURFACES.filter((s) => s.showInAtlas)) {
      expect(atlas, surface.id).toContain(surface.title);
      expect(atlas, surface.id).toContain(`(${surface.navSegments[0]})`);
    }
  });

  it("omits hosted-blocked surfaces when built for a hosted deployment", () => {
    // Handing the model a map to a door that's locked wastes a turn on an
    // error it can't act on.
    const atlas = buildAppAtlas({ hosted: true });
    expect(atlas).not.toContain("### Tracing");
    expect(atlas).toContain("### Connect");
  });

  it("includes hosted-blocked surfaces otherwise", () => {
    expect(buildAppAtlas()).toContain("### Tracing");
  });

  it("is stable across calls (it lives in the cacheable prefix)", () => {
    expect(buildAppAtlas({ hosted: true })).toBe(buildAppAtlas({ hosted: true }));
  });

  it("stays a reasonable size for a system prompt", () => {
    // Rough token proxy. If this trips, trim prose — don't delete surfaces.
    expect(buildAppAtlas({ hosted: true }).length).toBeLessThan(12_000);
  });
});

describe("getAppSurface", () => {
  it("resolves known ids and rejects unknown ones", () => {
    expect(getAppSurface("playground")?.title).toBe("Playground");
    expect(getAppSurface("nope")).toBeUndefined();
    expect(isAppSurfaceId("playground")).toBe(true);
    expect(isAppSurfaceId("nope")).toBe(false);
    expect(isAppSurfaceId(undefined)).toBe(false);
  });
});
