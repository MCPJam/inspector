import { expect, test } from "@playwright/test";

// Guards the collapsed (icon-mode) sidebar rail: every icon-only control in
// the footer must sit on the rail's horizontal centerline. This is geometry
// the vitest suite can't see (jsdom has no layout engine). Regression context:
// the signed-out "Sign in" footer button uses a `size="lg"` menu button, which
// drops its padding in icon mode so a 32px avatar can fill it — with a 16px
// icon instead, the icon parked 8px left of the centerline.
test("collapsed sidebar rail centers the footer icons", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });

  // Guest footer (local mode and hosted signed-out): Sign in + Support and
  // Settings utility buttons. Waiting for Sign in also waits out authResolving.
  const signInButton = page.locator('button[aria-label="Sign in"]');
  await expect(signInButton).toBeVisible({ timeout: 30_000 });

  const sidebar = page.locator('[data-slot="sidebar"][data-state]');
  if ((await sidebar.getAttribute("data-state")) !== "collapsed") {
    await page.keyboard.press("Control+b");
  }
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  // Let the 200ms width transition settle before measuring geometry.
  const rail = page.locator('[data-slot="sidebar-container"]');
  await expect
    .poll(async () => (await rail.boundingBox())?.width ?? 0)
    .toBeLessThan(60);

  const railBox = await rail.boundingBox();
  expect(railBox).not.toBeNull();
  const railCenter = railBox!.x + railBox!.width / 2;

  for (const label of ["Sign in", "Support", "Settings"]) {
    const icon = page.locator(`button[aria-label="${label}"] svg`).first();
    await expect(
      icon,
      `${label} icon should be visible in the collapsed rail`
    ).toBeVisible();
    const box = (await icon.boundingBox())!;
    const iconCenter = box.x + box.width / 2;
    expect(
      Math.abs(iconCenter - railCenter),
      `${label} icon center (${iconCenter}px) should sit on the rail centerline (${railCenter}px)`
    ).toBeLessThanOrEqual(1.5);
  }
});
