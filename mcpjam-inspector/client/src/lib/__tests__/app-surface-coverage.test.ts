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
import { APP_ROUTES, getAppRouteScope, matchAppRoute } from "../app-routes";
import {
  APP_SURFACES,
  buildAppAtlas,
  getAppSurface,
  isAppSurfaceId,
  listAppSurfaceNavSegments,
} from "@/shared/app-surfaces";
import {
  buildOrganizationPath,
  ORGANIZATION_ROUTE_SECTIONS,
  parseOrganizationSection,
  routePaths,
} from "../app-navigation";
import { HOSTED_HASH_BLOCKED_TABS } from "../hosted-tab-policy";

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

describe("every organization section is actually reachable", () => {
  // The failure this catches: a section can be added to the nav, given a path
  // by `buildOrganizationPath`, and rendered by OrganizationsTab while no
  // route ever matches it. There is no 404 to notice — the router's `"*"`
  // falls through to Servers, so the nav item silently navigates to the wrong
  // screen. Discord shipped exactly that way.
  //
  // Passing ":orgId" as the id makes the built path come out as the literal
  // route pattern, so this is an exact comparison rather than a regex.
  const patterns = new Set(screenRoutes.map((r) => `/${r.path}`));

  it.each([...ORGANIZATION_ROUTE_SECTIONS])(
    "%s has a registered route",
    (section) => {
      const built = buildOrganizationPath(":orgId", section);
      expect(patterns.has(built), `${section} → ${built}`).toBe(true);
    },
  );

  it.each([...ORGANIZATION_ROUTE_SECTIONS])(
    "%s round-trips back out of its own path",
    (section) => {
      // The other direction: a registered route whose segment the parser does
      // not know lands on "overview", which looks like the nav item doing
      // nothing rather than like a bug.
      const built = buildOrganizationPath("org-1", section);
      const segment = built.split("/")[3];
      expect(parseOrganizationSection(segment)).toBe(section);
    },
  );
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
  it("names a real nav segment for every blocked tab", () => {
    // The policy filters segments; it must not name one that no longer
    // exists, or it silently stops filtering anything. This holds by
    // construction now that the list is derived — the test guards the
    // derivation, not a hand-kept copy of it.
    const segments = new Set(listAppSurfaceNavSegments());
    for (const tab of HOSTED_HASH_BLOCKED_TABS) {
      expect(segments.has(tab), `policy tab "${tab}"`).toBe(true);
    }
  });

  it("blocks hosted surfaces sparingly", () => {
    // A growing block list means screens are being written that hosted
    // cannot serve — worth noticing deliberately rather than by drift.
    //
    // `webmcp` came OFF this list: it used to drive a browser on the machine
    // running the inspector, which a hosted replica cannot do, but a hosted
    // session drives one on the member's own computer instead. Its visibility
    // is a feature flag now, not a deployment fact.
    expect(HOSTED_HASH_BLOCKED_TABS).toEqual(["tracing"]);
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
    expect(buildAppAtlas({ hosted: true })).toBe(
      buildAppAtlas({ hosted: true }),
    );
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

describe("route scope ↔ surface scope", () => {
  // The failure this catches: a screen route registered as project-owned
  // while its manifest says global (or the reverse). The route table decides
  // where the screen MOUNTS and the manifest decides what agent navigation
  // and the atlas believe about it; if those disagree, `ui_navigate` sends
  // the model to a URL the router will not render.
  it("every screen route agrees with its surface", () => {
    for (const route of screenRoutes) {
      const surface = getAppSurface(route.surfaceId);
      expect(
        surface?.scope,
        `route "${route.path}" is ${route.scope}, surface "${route.surfaceId}" is ${surface?.scope}`,
      ).toBe(route.scope);
    }
  });

  it("keeps every manifest path LOGICAL — no literal :projectId", () => {
    // A concrete project id in a manifest would be unusable: these strings
    // are what agent navigation and the atlas hand around, and the project is
    // resolved per viewer at navigation time.
    for (const surface of APP_SURFACES) {
      expect(surface.canonicalPath, surface.id).not.toContain(":projectId");
      expect(surface.canonicalPath, surface.id).not.toMatch(/^\/p\//);
      for (const pattern of surface.routePatterns) {
        expect(pattern, surface.id).not.toContain(":projectId");
      }
    }
  });

  it("classifies the surfaces this migration had to decide on", () => {
    // Spot-checked rather than left to the sweep: each of these reads or
    // mutates project-owned data despite a generic-sounding name, and getting
    // one wrong strands a screen outside its project (or prefixes a global
    // one with a project it must not have).
    expect(getAppSurface("sessions")?.scope).toBe("project");
    expect(getAppSurface("registry")?.scope).toBe("project");
    expect(getAppSurface("computer")?.scope).toBe("project");
    expect(getAppSurface("tracing")?.scope).toBe("project");
    expect(getAppSurface("oauth-flow")?.scope).toBe("project");
    expect(getAppSurface("project-environments")?.scope).toBe("project");
    // Reclassified by that audit: Learning reads the active project to launch
    // a lesson's agent session into it, so it is project-owned despite
    // reading like a docs page.
    expect(getAppSurface("learning")?.scope).toBe("project");
    // Global: account-level or organization-level, never a project.
    expect(getAppSurface("settings")?.scope).toBe("global");
    expect(getAppSurface("organizations")?.scope).toBe("global");
    expect(getAppSurface("profile")?.scope).toBe("global");
    // Compare stays global even though it can overlay the active project's
    // hosts: one surface, one scope, and this surface also owns the PUBLIC
    // capability pages (`/capabilities/:slug`) and the chrome-less embed. It
    // degrades to the preset-only view with no project.
    expect(getAppSurface("host-compare")?.scope).toBe("global");
    expect(getAppSurface("support")?.scope).toBe("global");
  });

  it("keeps share tokens, embeds and callbacks out of project scope", () => {
    // These are read by people with no session at all. A project prefix on
    // one would be an authorization change dressed as a URL change.
    for (const path of [
      "evals/shared/:token",
      "conformance/shared/:token",
      "results/:runToken",
      "embed/score",
      "embed/host-compare",
      "callback",
      "oauth/callback/*",
      "login",
    ]) {
      const route = APP_ROUTES.find((r) => r.path === path);
      expect(route?.scope, path).toBe("public");
    }
  });
});

describe("matchAppRoute", () => {
  it("prefers a static segment over a param", () => {
    // Same specificity order the router uses: `/user-testing/new` is its own
    // screen, not a scenario whose id happens to be "new".
    expect(matchAppRoute("/user-testing/new")?.path).toBe("user-testing/new");
    expect(matchAppRoute("/user-testing/s_1")?.path).toBe(
      "user-testing/:scenarioId",
    );
  });

  it("matches splat sub-trees", () => {
    expect(matchAppRoute("/ci-evals/suite/s1/runs/r1")?.path).toBe(
      "ci-evals/*",
    );
    expect(matchAppRoute("/oauth/callback/debug")?.path).toBe(
      "oauth/callback/*",
    );
  });

  it("returns null rather than the catch-all for an unknown path", () => {
    // "No route" and "the not-found route" are different answers: navigation
    // must not prefix an unregistered path with a project.
    expect(matchAppRoute("/nope/nothing/here")).toBeNull();
    expect(getAppRouteScope("/nope")).toBeNull();
  });

  it("answers the scope of the paths navigation actually asks about", () => {
    expect(getAppRouteScope("/")).toBe("project");
    expect(getAppRouteScope("/servers")).toBe("project");
    expect(getAppRouteScope("/evals/suite/s1/runs/r1")).toBe("project");
    expect(getAppRouteScope("/settings/api-keys")).toBe("global");
    expect(getAppRouteScope("/evals/shared/tok")).toBe("public");
  });

  it("normalizes empty segments away rather than inventing a param match", () => {
    // A stray or trailing slash is the same route, not a host whose id is "".
    expect(matchAppRoute("/hosts//")?.path).toBe("hosts");
    expect(matchAppRoute("/hosts/")?.path).toBe("hosts");
    expect(matchAppRoute("/")?.path).toBe("/");
  });
});
