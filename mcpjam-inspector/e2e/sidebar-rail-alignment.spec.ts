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
  // utility buttons. NOTE: in local mode `authResolving` is hosted-only
  // (mcp-sidebar.tsx), so Support renders on first paint — its visibility
  // does NOT mean the guest session has settled. Async auth/session
  // resolution can still remount the sidebar at its default expanded width
  // after this point, which is why the collapse below must be re-asserted
  // until stable rather than performed once.
  const supportButton = page.locator('button[aria-label="Support"]');
  await expect(supportButton).toBeVisible({ timeout: 30_000 });

  const sidebar = page.locator('[data-slot="sidebar"][data-state]');
  const rail = page.locator('[data-slot="sidebar-container"]');

  // Collapse until it STICKS: a late remount (guest session resolving, data
  // loading) re-expands a just-collapsed sidebar, so one Ctrl+B plus a single
  // width poll races it. The whole block retries — re-collapsing if needed —
  // and only passes once the rail has stayed collapsed across a settle
  // window. All geometry is measured inside the same stable window so the
  // rail cannot flip between the rail and icon measurements.
  await expect(async () => {
    if ((await sidebar.getAttribute("data-state")) !== "collapsed") {
      await page.keyboard.press("Control+b");
    }
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");

    // Let the 200ms width transition settle before measuring geometry.
    await expect
      .poll(async () => (await rail.boundingBox())?.width ?? 0, {
        timeout: 3_000,
      })
      .toBeLessThan(60);

    // Still collapsed after a settle window → no pending remount raced us.
    await page.waitForTimeout(400);
    expect(await sidebar.getAttribute("data-state")).toBe("collapsed");
    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    expect(railBox!.width).toBeLessThan(60);
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
  }).toPass({ timeout: 30_000 });
});
