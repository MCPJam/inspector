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
 * The app shell's child routes.
 *
 * Found by "the route that HAS children" rather than by index: the router also
 * mounts a standalone `__e2e/oauth-debugger` entry, and an index-based lookup
 * would silently start reading that one the day another top-level route is
 * added ahead of the shell.
 */
function shellChildren() {
  const router = createAppRouter();
  const shell = router.routes.find(
    (route) => (route.children ?? []).length > 0
  );
  return shell?.children ?? [];
}

function pathsOf(routes: ReturnType<typeof shellChildren>): string[] {
  return routes.map((child) => (child.index ? "/" : child.path ?? ""));
}

/** The `p/:projectId` sub-tree — where project routes canonically live. */
function projectSubtree() {
  const subtree = shellChildren().find(
    (child) => child.path === "p/:projectId"
  );
  if (!subtree) throw new Error("no p/:projectId route is mounted");
  return subtree;
}

const projectRoutes = APP_ROUTES.filter((r) => r.scope === "project");
const unscopedRoutes = APP_ROUTES.filter((r) => r.scope !== "project");

describe("the router mounts every route it registers", () => {
  it("builds without a stranded or unrendered route", () => {
    // Both guards live inside `buildRouteChildren`, so constructing the router
    // is what exercises them. A throw here names the offending path.
    expect(() => createAppRouter()).not.toThrow();
  });

  it("mounts every project route below p/:projectId", () => {
    // The canonical registration of a project screen is ONLY here. If one
    // were mounted at the root instead, its URL would carry no project and
    // the screen would render against whatever project was last active.
    const mounted = new Set(pathsOf(projectSubtree().children ?? []));
    const missing = projectRoutes
      .map((route) => route.path)
      .filter((path) => !mounted.has(path));
    expect(missing).toEqual([]);
  });

  it("mounts every global and public route at the root", () => {
    const mounted = new Set(pathsOf(shellChildren()));
    const missing = unscopedRoutes
      .map((route) => route.path)
      .filter((path) => !mounted.has(path));
    expect(missing).toEqual([]);
  });

  it("mounts a legacy normalizer at the root for every project route", () => {
    // Old links (`/servers`, `/evals/suite/X?project=A`) must still open.
    // They are mounted at the root as well — rendering the normalizer, not
    // the screen — so an unscoped URL resolves its project and lands on the
    // canonical path without the wrong project's screen ever flashing.
    const mounted = new Set(pathsOf(shellChildren()));
    const missing = projectRoutes
      .map((route) => route.path)
      .filter((path) => !mounted.has(path));
    expect(missing).toEqual([]);
  });

  it("gives the project sub-tree its own not-found", () => {
    // Otherwise an unknown path under a real project falls through to the
    // root catch-all and the project chrome disappears mid-navigation.
    expect(pathsOf(projectSubtree().children ?? [])).toContain("*");
  });

  it("redirects the bare project prefix instead of rendering a screen there", () => {
    // `/p/<id>` is not a destination; `/p/<id>/home` is. Two URLs for one
    // screen is exactly what this migration is removing.
    const index = (projectSubtree().children ?? []).find(
      (child) => child.index
    );
    expect(index?.loader).toBeTypeOf("function");
    expect(index?.element).toBeUndefined();
  });

  it("does not redirect a malformed bare project prefix out of the boundary", async () => {
    // Loaders run BEFORE anything renders, so a redirect here escapes the
    // boundary entirely: `/p/none` would land on the unscoped legacy route and
    // adopt the viewer's own project — the user asks for one project and
    // silently gets another's home, while `/p/none/servers` reports itself
    // unavailable. The two have to agree.
    const index = (projectSubtree().children ?? []).find(
      (child) => child.index
    );
    const loader = index?.loader as ((args: any) => unknown) | undefined;
    expect(loader).toBeTypeOf("function");

    const malformed = await loader!({ params: { projectId: "none" } });
    expect(malformed).toBeNull();

    // A usable id still redirects to project home.
    const valid = (await loader!({
      params: { projectId: "k5700000000000000000000000a" },
    })) as Response;
    expect(valid).toBeInstanceOf(Response);
    expect(valid.headers.get("Location")).toBe(
      "/p/k5700000000000000000000000a/home"
    );
  });

  it("mounts the GitHub install callback", () => {
    // Named explicitly rather than left to the sweep above: this is the route
    // the regression was, and the whole binding flow is unreachable without it.
    expect(pathsOf(shellChildren())).toContain(
      "settings/integrations/github/callback"
    );
  });
});
