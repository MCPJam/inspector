import { expect, test } from "@playwright/test";

// Guards the collapsed (icon-mode) sidebar rail: every icon-only control in
// the footer must sit on the rail's horizontal centerline. This is geometry
// the vitest suite can't see (jsdom has no layout engine).
test("collapsed sidebar rail centers the footer icons", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });

  // Guest footer (local mode and hosted signed-out): the Support and Settings
  // utility buttons. They're suppressed while auth resolves, so waiting for
  // Support also waits out authResolving.
  const supportButton = page.locator('button[aria-label="Support"]');
  await expect(supportButton).toBeVisible({ timeout: 30_000 });

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

  for (const label of ["Support", "Settings"]) {
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
