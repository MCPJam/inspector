import { describe, expect, it, vi } from "vitest";
// Static, not `await import` inside the test: importing App's module graph
// costs ~20s, and inside a test body that counts against the 30s timeout.
import { createAppRouter } from "@/router";

// `vi.hoisted`, because the static import above makes the mock factory run
// during collection, before a plain `const` would be initialized.
const { createSentryBrowserRouter } = vi.hoisted(() => ({
  createSentryBrowserRouter: vi.fn(() => ({ routes: [] })),
}));

// Stub every route component. `buildRouteChildren` walks APP_ROUTES, not the
// elements, so the tree shape this asserts on is unchanged — and loading the
// real App graph costs ~40s of collect for one assertion.
vi.mock("@/App", () => {
  const Stub = () => null;
  return new Proxy(
    { default: Stub },
    {
      // `then` must stay undefined or the module namespace looks thenable and
      // the dynamic import never resolves.
      get: (target, prop) =>
        prop === "then" ? undefined : (Reflect.get(target, prop) ?? Stub),
      has: () => true,
    },
  );
});

// Only the factory is stubbed; the rest of lib/sentry is real, because App's
// module graph pulls other exports from it.
vi.mock("@/lib/sentry", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/sentry")>("@/lib/sentry");
  return { ...actual, createSentryBrowserRouter };
});

/**
 * Guards the half of the Sentry wiring that `sentry.test.ts` cannot see.
 *
 * That file asserts `wrapCreateBrowserRouterV7` was called with
 * `createBrowserRouter` — a fact about `lib/sentry`. Swapping `router.tsx` back
 * to the bare `createBrowserRouter` left all of it green, and transactions
 * would silently go back to being named after the pageload URL.
 */
describe("createAppRouter", () => {
  it("builds the route tree through the Sentry-instrumented factory", () => {
    createAppRouter();

    expect(createSentryBrowserRouter).toHaveBeenCalledTimes(1);
    // The real app shell, not an empty placeholder.
    const routes = createSentryBrowserRouter.mock.calls[0][0] as {
      children?: unknown[];
    }[];
    expect(routes.some((route) => (route.children ?? []).length > 0)).toBe(true);
  });
});
