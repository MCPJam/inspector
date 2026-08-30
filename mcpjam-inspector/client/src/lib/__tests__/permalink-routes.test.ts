/**
 * Every permalink route the SDK mints actually exists in this app.
 *
 * The SDK cannot check this: `@mcpjam/sdk/platform` is runtime-agnostic and
 * imports no app code, so its route table is a set of strings it has no way
 * to validate. The app CAN, and this is where the two halves are joined —
 * without it, renaming `/servers` or dropping `environments/:environmentId`
 * would leave every agent minting 404s, and nothing would fail until someone
 * followed one.
 */
import { describe, expect, it } from "vitest";
import {
  PLATFORM_PERMALINK_ROUTES,
  buildAppPermalink,
  type PlatformResourceType,
} from "@mcpjam/sdk/platform";
import { APP_ROUTES } from "../app-routes";
import { APP_SURFACES } from "@/shared/app-surfaces";
import {
  buildProjectEnvironmentPath,
  buildProjectPluginPath,
  buildProjectServerPath,
} from "../app-navigation";

const APP_ORIGIN = "https://app.mcpjam.com";
const PROJECT = "v977phvmg9dttdemo";

/** The app path one resource type mints, with ids that cannot collide. */
function pathFor(type: PlatformResourceType): string {
  const route = PLATFORM_PERMALINK_ROUTES[type] as { parent?: string };
  return buildAppPermalink(
    {
      type,
      id: "resource-id",
      ...(route.parent
        ? { parent: { type: route.parent as PlatformResourceType, id: "parent-id" } }
        : {}),
      projectId: PROJECT,
    },
    { appOrigin: APP_ORIGIN },
  ).path;
}

/** Match a concrete pathname against a react-router pattern from the table. */
function matchesRoute(pathname: string, pattern: string): boolean {
  const routeSegments = (pattern === "/" ? "" : pattern).split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (pattern === "/") return pathSegments.length === 0;
  if (routeSegments.length !== pathSegments.length) return false;
  return routeSegments.every(
    (segment, index) => segment.startsWith(":") || segment === pathSegments[index],
  );
}

describe("the SDK permalink registry ↔ the app route table", () => {
  it("every resource type lands on a real SCREEN route", () => {
    const screens = APP_ROUTES.filter((route) => route.kind === "screen");
    for (const type of Object.keys(
      PLATFORM_PERMALINK_ROUTES,
    ) as PlatformResourceType[]) {
      const pathname = new URL(pathFor(type), APP_ORIGIN).pathname;
      const matched = screens.filter((route) =>
        matchesRoute(pathname, route.path),
      );
      expect(
        matched.length,
        `${type} → ${pathname} matched ${matched.length} screen routes`,
      ).toBeGreaterThan(0);
    }
  });

  it("every resource type's route is claimed by a surface manifest", () => {
    // The manifest is what makes a screen reachable by the in-product agent
    // and visible in the atlas. A permalink to a route no manifest claims
    // would open a page the assistant cannot reason about.
    const patterns = new Set(
      APP_SURFACES.flatMap((surface) => surface.routePatterns),
    );
    for (const type of Object.keys(
      PLATFORM_PERMALINK_ROUTES,
    ) as PlatformResourceType[]) {
      const pathname = new URL(pathFor(type), APP_ORIGIN).pathname;
      const claimed = [...patterns].some((pattern) =>
        matchesRoute(pathname, pattern),
      );
      expect(claimed, `${type} → ${pathname}`).toBe(true);
    }
  });

  it("the app's own path builders agree with the SDK's, segment for segment", () => {
    // Two builders exist on purpose — the SDK's is pure and origin-explicit,
    // the app's is relative and used for in-app navigation — and they must
    // produce the same shape, or the URL a user copies from the address bar
    // would differ from the one an agent hands out for the same view.
    const cases: Array<[PlatformResourceType, string]> = [
      ["project_server", buildProjectServerPath("resource-id")],
      ["project_plugin", buildProjectPluginPath("resource-id")],
      ["project_environment", buildProjectEnvironmentPath("resource-id")],
    ];
    for (const [type, appPath] of cases) {
      expect(new URL(pathFor(type), APP_ORIGIN).pathname, type).toBe(appPath);
    }
  });

  it("carries the project scope on every route but organizations", () => {
    for (const type of Object.keys(
      PLATFORM_PERMALINK_ROUTES,
    ) as PlatformResourceType[]) {
      const search = new URL(pathFor(type), APP_ORIGIN).searchParams;
      expect(search.get("project"), type).toBe(
        type === "organization" ? null : PROJECT,
      );
    }
  });
});
