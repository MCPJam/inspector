import { expect, test } from "@playwright/test";

// App-level smoke only: prove the framework works end-to-end and that the app
// actually serves a mounted shell, without coupling to any specific feature UI,
// route, feature flag, or auth state. Build more specific specs from here.
test("home route serves a mounted app shell", async ({ page }) => {
  const response = await page.goto("/");

  expect(response, "navigation to / should return a response").not.toBeNull();
  expect(
    response?.ok(),
    `expected a 2xx response from /, got ${response?.status()}`,
  ).toBe(true);

  // `data-testid="app-shell"` marks the top-level mounted chrome wrapper in
  // client/src/App.tsx. It renders outside the auth/billing gates, so this
  // holds for guest and authed users and across local/hosted builds.
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
});
