import { expect, test } from "@playwright/test";

// Guards the collapsed (icon-mode) sidebar rail: every icon-only control in
// the footer must sit on the rail's horizontal centerline. This is geometry
// the vitest suite can't see (jsdom has no layout engine).
test("collapsed sidebar rail centers the footer icons", async ({ page }) => {
  // Seed completed onboarding so the NUX first-run redirect doesn't fire. It
  // navigates "/" → /playground asynchronously, which remounts the sidebar at
  // its default expanded width — after the collapse poll below has passed, so
  // the geometry loop would measure an expanded rail. See nux.spec.ts.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "completed", completedAt: 1 })
    );
  });

  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });

  // Guest footer (local mode and hosted signed-out): the Support and Settings
  // utility buttons. They're suppressed while auth resolves, so waiting for
  // Support also waits out authResolving.
  const supportButton = page.locator('button[aria-label="Support"]');
  await expect(supportButton).toBeVisible({ timeout: 30_000 });

  const sidebar = page.locator('[data-slot="sidebar"][data-state]');
  if ((await sidebar.getAttribute("data-state")) !== "collapsed") {
    // Use the visible sidebar control instead of the keyboard shortcut. The
    // guest utility buttons render synchronously once auth resolves, while the
    // shortcut listener is installed in an effect; racing that effect made the
    // collapse keystroke disappear and left the rail at its expanded width.
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
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
