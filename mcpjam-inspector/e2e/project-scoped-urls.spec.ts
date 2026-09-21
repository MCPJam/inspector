import { expect, test } from "@playwright/test";

/**
 * Canonical project URLs, from the two angles a browser can check without an
 * account.
 *
 * The scoped half of the contract (`/p/<projectId>/servers` selecting that
 * project, two tabs holding two projects) needs a signed-in Convex project, so
 * it lives in the unit suite — `use-project-route-coordinator.test.tsx` and
 * `project-route.test.ts`. What only a real browser can answer is the other
 * half: that the LOCAL inspector, which has no Convex project at all, still
 * opens its screens on plain unscoped paths, and that an unknown URL now says
 * so instead of quietly rendering Connect.
 *
 * Local build only: hosted deployments gate everything here behind WorkOS.
 */
test.describe("canonical project URLs", () => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL,
    "local non-hosted build only; skip when PLAYWRIGHT_BASE_URL is set",
  );

  // Skip the first-run redirect so these assertions are about routing.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "mcp-onboarding-state",
        JSON.stringify({ status: "completed", completedAt: 1 }),
      );
    });
  });

  // A local project id is a UUID, not a Convex id, so it is never canonical —
  // the legacy normalizer must render the screen rather than hold a spinner
  // waiting for a project that will never resolve.
  //
  // One test per screen: a cold load of this app is ~13s here, and two of them
  // in one test leaves nothing between passing and a timeout.
  for (const path of ["/servers", "/playground"]) {
    test(`the local inspector opens ${path} unscoped`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId("app-shell")).toBeVisible({
        timeout: 30_000,
      });
      // The shell alone would also mount for a URL that fell through to the
      // catch-all, so the routing claim is these two together: a real screen
      // matched, and the path was not rewritten.
      await expect(page.getByTestId("route-not-found")).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(path);
    });
  }

  test("an unknown URL renders an explicit not-found", async ({ page }) => {
    // It used to render Connect for whatever project was active, so a typo or
    // a truncated link looked like a successful navigation.
    await page.goto("/definitely-not-a-route/at-all");
    await expect(page.getByTestId("route-not-found")).toBeVisible({
      timeout: 30_000,
    });
    expect(new URL(page.url()).pathname).toBe("/definitely-not-a-route/at-all");
  });

  // One test per route rather than a loop in a single test: each cold load of
  // the app costs a real boot, and three of them do not fit in one test's
  // budget — which is a timeout, not a finding.
  for (const path of ["/settings", "/profile", "/organizations"]) {
    test(`${path} never gains a project prefix`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId("app-shell")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("route-not-found")).toHaveCount(0);
      // Not an exact-path assertion: a global route may legitimately redirect
      // in this build (`/organizations` bounces when the local visitor has no
      // organization). What must hold either way is that nothing here picked
      // up a project prefix.
      expect(new URL(page.url()).pathname.startsWith("/p/")).toBe(false);
    });
  }
});
