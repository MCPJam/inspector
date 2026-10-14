import { expect, takeSnapshot } from "@chromatic-com/playwright";
import type { Page, TestInfo } from "@playwright/test";

export async function captureApp(
  page: Page,
  testInfo: TestInfo,
  screen: string,
  theme: string,
  failures: string[],
) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
  });
  await expect(page.locator("html")).toHaveClass(
    theme === "dark" ? /dark/ : /^(?!.*\bdark\b).*$/,
  );
  expect(failures).toEqual([]);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath(`${screen}-${theme}.png`),
  });
  await takeSnapshot(page, screen, testInfo);
  expect(failures).toEqual([]);
}
