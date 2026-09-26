import { expect, test } from "@playwright/test";

// Non-hosted builds may provision a guest Convex project, which canonicalizes
// project routes. Without one, the local fallback keeps the same screen unscoped.
// Cross-project selection and offline fallback are covered by routing unit tests.
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
      window.localStorage.setItem(
        "mcp-first-run-server-choice-state",
        JSON.stringify({ status: "completed", completedAt: 1, shownAt: 1 }),
      );
    });
  });

  for (const path of ["/servers", "/playground"]) {
    test(`the local inspector preserves the ${path} destination`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page.getByTestId("app-shell")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("route-not-found")).toHaveCount(0);
      // Both supported modes must retain the requested screen. A guest
      // project's asynchronous provisioning must not make this assertion race.
      await expect(page).toHaveURL(
        new RegExp(`^https?://[^/]+(?:/p/[a-z0-9]{16,64})?${path}$`),
      );
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
