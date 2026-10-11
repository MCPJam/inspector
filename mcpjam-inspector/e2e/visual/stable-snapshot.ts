import { expect } from "@chromatic-com/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { captureApp } from "./snapshot";

// Text can arrive before resizable panels and animated icons settle. Require
// three matching renders rather than capturing an intermediate layout.
export async function captureStableApp(
  page: Page,
  testInfo: TestInfo,
  screen: string,
  theme: string,
  failures: string[],
) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let previous: Buffer | undefined;
  let matches = 0;
  await expect
    .poll(
      async () => {
        const current = await page.screenshot({ animations: "disabled" });
        matches = previous?.equals(current) ? matches + 1 : 0;
        previous = current;
        return matches;
      },
      { timeout: 10000, intervals: [100, 100, 100] },
    )
    .toBeGreaterThanOrEqual(2);
  await captureApp(page, testInfo, screen, theme, failures);
}
