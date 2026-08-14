import { expect, test } from "@playwright/test";

// Guards the caniuse.dev compare table's scroll model. Two properties have to
// hold together, and fixing one in isolation has broken the other twice:
//
//   1. The table reaches the bottom of the viewport. Capping its scroll box at
//      a fixed viewport fraction (`max-h-[70vh]`) left a dead band of empty
//      background below it on tall screens.
//   2. The column header stays pinned while the table scrolls underneath it —
//      the whole point of the sticky `<thead>`.
//
// Property 2 has a specific, non-obvious failure mode: the entrance animation
// wrapper (`motion.div`) leaves a non-`none` `transform` on itself. If the
// table's scroll box is not a *direct child* of that transformed element,
// `position: sticky` can end up constrained to the wrong ancestor and stop
// pinning — a real cross-browser inconsistency, not just a jsdom gap this
// suite can't see otherwise. The scroll box asserted on here
// (`compare-matrix-scroll`) must stay the transformed element's direct child.
test("caniuse compare table fills the viewport and keeps its header pinned", async ({
  page,
}) => {
  // Tall viewport: a fractional cap is only visibly wrong when there is more
  // screen than the fraction claims.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/embed/host-compare");

  const scroller = page.getByTestId("compare-matrix-scroll");
  await expect(scroller).toBeVisible({ timeout: 30_000 });
  // The preset columns hydrate after first paint; measuring before they land
  // reads the empty-state box instead of the table.
  const headerCell = page.locator("table thead th").first();
  await expect(headerCell).toBeVisible({ timeout: 30_000 });

  // Retry the whole measurement: late hydration can resize the box after a
  // single poll would have passed.
  await expect(async () => {
    // Structural guard for the sticky-vs-transform failure mode: the scroll
    // box must be a direct child of the animated card, not nested further in.
    const isDirectChild = await scroller.evaluate(
      (el) => el.parentElement?.dataset.testid === "compare-matrix"
    );
    expect(
      isDirectChild,
      "the scroll box must be a direct child of [data-testid=compare-matrix] — an element between them can break sticky positioning"
    ).toBe(true);

    const box = (await scroller.boundingBox())!;
    expect(box).not.toBeNull();

    const viewportHeight = page.viewportSize()!.height;
    const deadSpaceBelow = viewportHeight - (box.y + box.height);
    // Only the page's own bottom padding may sit below the table.
    expect(
      deadSpaceBelow,
      `table bottom should reach the viewport bottom, found ${Math.round(deadSpaceBelow)}px of empty space below it`
    ).toBeLessThanOrEqual(48);

    const overflows = await scroller.evaluate(
      (el) => el.scrollHeight > el.clientHeight
    );
    expect(
      overflows,
      "table box should scroll internally, otherwise the sticky header has no scrolling ancestor"
    ).toBe(true);
  }).toPass({ timeout: 30_000 });

  // The header row stays at a fixed spot in the viewport across a real,
  // physical scroll (not just a single before/after snapshot — a
  // transform-vs-sticky mismatch can let it drift partway through). Hover the
  // scroller itself (not a hardcoded point) so the wheel events are
  // guaranteed to land on it rather than some other element under the cursor.
  //
  // Retried as a whole: preset columns can still be hydrating, and a re-render
  // mid-attempt can reset the scroller's `scrollTop` back to 0, which would
  // otherwise read as "the wheel event missed" rather than the harmless
  // hydration hiccup it actually is.
  await expect(async () => {
    // Reset to a known position at the start of every attempt: otherwise a
    // failed prior attempt (e.g. a header-drift read) leaves the table
    // scrolled down, and once it's near the scroll bottom there's no 100px of
    // room left to move — turning a transient failure into a misleading
    // timeout instead of a clean retry.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await scroller.hover();
    const scrollTopBefore = await scroller.evaluate((el) => el.scrollTop);
    const positions: number[] = [];
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(200);
      positions.push((await headerCell.boundingBox())!.y);
    }
    const scrollTopAfter = await scroller.evaluate((el) => el.scrollTop);
    // Otherwise a wheel event that missed the scroller would leave the header
    // untouched too, and the drift check below would pass vacuously.
    expect(
      scrollTopAfter - scrollTopBefore,
      `wheel scroll should have moved the table's internal scroller, went from ${scrollTopBefore} to ${scrollTopAfter}`
    ).toBeGreaterThan(100);

    // A real loss of stickiness tracks the scroll delta (~300px per step,
    // since that's what we just scrolled by), not a few px of render jitter —
    // the tolerance only needs to be well below that to catch it.
    const spread = Math.max(...positions) - Math.min(...positions);
    expect(
      spread,
      `sticky header should stay put while scrolling, drifted ${Math.round(spread)}px across ${JSON.stringify(positions.map(Math.round))}`
    ).toBeLessThanOrEqual(20);
  }).toPass({ timeout: 20_000 });
});
