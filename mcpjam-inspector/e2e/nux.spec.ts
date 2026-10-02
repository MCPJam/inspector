import { expect, test } from "@playwright/test";

// These tests cover the first-run NUX (new-user experience) redirect.
// They run against the local non-hosted build only; hosted-mode deployments
// require authentication before the NUX can fire, so they are not suitable
// targets for PLAYWRIGHT_BASE_URL.
//
// First-run users see onboarding on Home. Returning users stay on Home
// without onboarding; a provisioned guest project may canonicalize the URL.

const LEGACY_ONBOARDING_KEY = "mcp-onboarding-state";
const SERVER_CHOICE_KEY = "mcp-first-run-server-choice-state";

test.describe("NUX first-run redirect", () => {
  // Hosted deployments require WorkOS auth before the NUX gate settles,
  // so these tests only run against the local non-hosted build.
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL,
    "NUX tests require local non-hosted build; skip when PLAYWRIGHT_BASE_URL is set",
  );
  test("fresh user landing on / sees onboarding on Home", async ({ page }) => {
    // Ensure no prior onboarding state (fresh context already has empty
    // localStorage, but be explicit so the intent is clear in CI logs).
    await page.addInitScript(
      ([legacyKey, serverChoiceKey]) => {
        localStorage.removeItem(legacyKey);
        localStorage.removeItem(serverChoiceKey);
      },
      [LEGACY_ONBOARDING_KEY, SERVER_CHOICE_KEY],
    );

    await page.goto("/");

    // The app shell must mount before we assert the redirect so the test
    // doesn't race against the initial render.
    await expect(page.getByTestId("app-shell")).toBeVisible({
      timeout: 30_000,
    });

    await page.waitForURL("**/home", { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Welcome to MCPJam" }),
    ).toBeVisible();
  });

  test("returning user with completed onboarding stays on the Home surface", async ({
    page,
  }) => {
    // Seed completed onboarding state before the page loads.
    // Key is inlined (no parameter passing) to avoid any serialization edge
    // cases with addInitScript's arg channel.
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

    await page.goto("/");

    // Wait for the app before checking the returning-user Home surface.
    await expect(page.getByTestId("app-shell")).toBeVisible({
      timeout: 30_000,
    });

    // Verify the localStorage seed survived initial page load.
    // If this assertion fails the issue is in the seed, not the NUX redirect.
    const seededStatus = await page.evaluate(() => {
      try {
        const raw = window.localStorage.getItem("mcp-onboarding-state");
        return raw
          ? ((JSON.parse(raw) as { status?: string }).status ?? null)
          : null;
      } catch {
        return null;
      }
    });
    expect(
      seededStatus,
      "localStorage onboarding status should be 'completed' after page load",
    ).toBe("completed");

    await expect(
      page.getByRole("heading", { name: "Welcome to MCPJam" }),
    ).toHaveCount(0);
    // Guest projects use canonical URLs; the local fallback stays unscoped.
    await expect(page).toHaveURL(
      /^https?:\/\/[^/]+\/(?:p\/[a-z0-9]{16,64}\/home)?$/,
    );
  });
});
