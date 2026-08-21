import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "../app-routes";
import { createAppRouter } from "@/router";

/**
 * Every registered route element is actually MOUNTED.
 *
 * One direction of that invariant has always failed loudly: `buildRouteChildren`
 * throws when an `APP_ROUTES` entry has no element. The other direction used to
 * fail SILENTLY, and that is why this file exists — `buildRouteChildren`
 * iterates `APP_ROUTES`, so a path registered only in `ROUTE_ELEMENTS` is never
 * mounted at all. The URL falls through to the `"*"` catch-all and renders a
 * different screen, with nothing in the console, no failing unit test (a
 * component test mounts the component directly, so it never notices), and
 * nothing to see until somebody follows the link.
 *
 * Not hypothetical: the GitHub install callback reached review registered in
 * `ROUTE_ELEMENTS` alone, which would have landed every return trip from GitHub
 * on the servers screen.
 *
 * `buildRouteChildren` now throws on both directions, so BUILDING the router is
 * the assertion — no source parsing, nothing to keep in step with a regex, and
 * the same check the real app runs at startup.
 */
/**
 * Paths of the app shell's child routes.
 *
 * Found by "the route that HAS children" rather than by index: the router also
 * mounts a standalone `__e2e/oauth-debugger` entry, and an index-based lookup
 * would silently start reading that one the day another top-level route is
 * added ahead of the shell.
 */
function mountedPaths(): string[] {
  const router = createAppRouter();
  const shell = router.routes.find(
    (route) => (route.children ?? []).length > 0
  );
  return (shell?.children ?? []).map((child) =>
    child.index ? "/" : child.path ?? ""
  );
}

describe("the router mounts every route it registers", () => {
  it("builds without a stranded or unrendered route", () => {
    // Both guards live inside `buildRouteChildren`, so constructing the router
    // is what exercises them. A throw here names the offending path.
    expect(() => createAppRouter()).not.toThrow();
  });

  it("mounts a child route for every path in the table", () => {
    const mounted = new Set(mountedPaths());
    const missing = APP_ROUTES.map((route) => route.path).filter(
      (routePath) => !mounted.has(routePath)
    );
    expect(missing).toEqual([]);
  });

  it("mounts the GitHub install callback", () => {
    // Named explicitly rather than left to the sweep above: this is the route
    // the regression was, and the whole binding flow is unreachable without it.
    expect(mountedPaths()).toContain("settings/integrations/github/callback");
  });
});
