import { expect, test } from "@playwright/test";

// These tests cover the first-run NUX (new-user experience) redirect.
// They run against the local non-hosted build only; hosted-mode deployments
// require authentication before the NUX can fire, so they are not suitable
// targets for PLAYWRIGHT_BASE_URL.
//
// The NUX logic (App.tsx useLayoutEffect):
//   1. Waits for isWorkOsLoading = false and effectiveHostedShellGateState = "ready".
//   2. Skips if hasSeenFirstRunOnboarding (remote Convex flag) is true.
//   3. Calls isFirstRunEligible(hasBlockingServers, activeTab, workOsUser, remoteFlag):
//      - returns true when the active route is the root hub ("/", "/home",
//        "/servers", "/connect", "/hosts") AND no blocking servers AND no prior
//        localStorage onboarding state.
//   4. On eligible: navigates to /playground.
//
// After the 2631 change, "/" and "/home" both render HomeTab (no feature-flag
// gate), so they qualify as eligible NUX entry routes.

const ONBOARDING_KEY = "mcp-onboarding-state";

test.describe("NUX first-run redirect", () => {
  // Hosted deployments require WorkOS auth before the NUX gate settles,
  // so these tests only run against the local non-hosted build.
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL,
    "NUX tests require local non-hosted build; skip when PLAYWRIGHT_BASE_URL is set",
  );
  test("fresh user landing on / is redirected to /playground", async ({
    page,
  }) => {
    // Ensure no prior onboarding state (fresh context already has empty
    // localStorage, but be explicit so the intent is clear in CI logs).
    await page.addInitScript((key) => {
      localStorage.removeItem(key);
    }, ONBOARDING_KEY);

    await page.goto("/");

    // The app shell must mount before we assert the redirect so the test
    // doesn't race against the initial render.
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });

    // The NUX useLayoutEffect fires shortly after mount once auth/gate state
    // settles and navigates to /playground. 15 s covers that async delay.
    await page.waitForURL("**/playground", { timeout: 15_000 });
  });

  test("returning user with completed onboarding stays on home, not /playground", async ({
    page,
  }) => {
    // Seed completed onboarding state before the page loads.
    await page.addInitScript((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({ status: "completed", completedAt: 1 }),
      );
    }, ONBOARDING_KEY);

    await page.goto("/");

    // "Welcome to MCPJam" is rendered by HomeTab when no org context exists
    // (the unauthenticated local-mode empty state). Its presence confirms we
    // are on the Home page, not on /playground.
    await expect(page.getByText("Welcome to MCPJam")).toBeVisible({
      timeout: 30_000,
    });
    // Use toHaveURL (retried) rather than a snapshot of page.url() so that a
    // late-firing NUX redirect doesn't produce a false green.
    await expect(page).toHaveURL(/^(?!.*\/playground)/, { timeout: 5_000 });
  });
});
