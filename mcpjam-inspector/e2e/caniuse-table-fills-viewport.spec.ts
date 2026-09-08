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

  // Everything below drives real pointer input, which `HostedShellGate`
  // (App.tsx) blocks whenever it is showing an overlay: the content gets
  // `inert` + `pointer-events-none`, so `scroller.hover()` never resolves and
  // the enclosing `toPass` dies with a bare "Timeout exceeded while waiting on
  // the predicate" and no assertion behind it. The signed-out lockdown gate
  // that used to make this permanent on staging is gone; what remains is the
  // transient project-loading overlay on a slow cold load. The geometry above
  // is unaffected (the gate changes input, not layout) and still measures the
  // real deployed table, so only this half is skipped when we catch one.
  //
  // Only paid against a deployed target; a local build is never hosted.
  const gated =
    !!process.env.PLAYWRIGHT_BASE_URL &&
    (await page
      .getByTestId("hosted-shell-gate-overlay")
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(
        () => true,
        () => false
      ));
  test.skip(
    gated,
    "a hosted shell overlay makes the page inert; pointer-driven scrolling can't be exercised there"
  );

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
    // Seed with the pre-scroll position: without it, a header that jumps on
    // the very first wheel step but then holds still for the rest would show
    // a small spread across the 4 post-scroll samples alone and pass despite
    // that initial jump.
    const positions: number[] = [(await headerCell.boundingBox())!.y];
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

// The property above ("reaches the viewport bottom") only exercises a table
// long enough to overflow. Filtering down to a couple of rows is a distinct
// case that isn't covered by that test at all: an earlier version of this fix
// made the card `flex-1` (always fill the remaining height, regardless of
// content) instead of capping at it — which fixed the long-table dead space
// below the card, but reintroduced the same dead space *inside* the
// bordered card for a short, filtered result. The card must hug its content
// when the content doesn't need the full height.
test("caniuse compare table hugs its content instead of stretching when filtered to a few rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/embed/host-compare?capability=elicitation");

  const card = page.getByTestId("compare-matrix");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const headerCell = page.locator("table thead th").first();
  await expect(headerCell).toBeVisible({ timeout: 30_000 });

  await expect(async () => {
    const cardBox = (await card.boundingBox())!;
    const tableBox = (await page.locator("table").boundingBox())!;
    const slack = cardBox.height - tableBox.height;
    // Absolute value: a card noticeably *shorter* than its own table content
    // would mean rows are being clipped (the card has overflow-hidden), which
    // is just as wrong as a card stretched far past its content.
    expect(
      Math.abs(slack),
      `card should hug its filtered-down content instead of stretching to fill the viewport; card=${Math.round(cardBox.height)}px table=${Math.round(tableBox.height)}px slack=${Math.round(slack)}px`
    ).toBeLessThan(120);
  }).toPass({ timeout: 30_000 });
});
