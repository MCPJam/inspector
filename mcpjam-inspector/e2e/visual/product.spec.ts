import { expect, test } from "@chromatic-com/playwright";
import type { Page } from "@playwright/test";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { prepareApp } from "./app-network";
import { memberFixture } from "./product-data";
import { captureApp } from "./snapshot";

async function showTools(page: Page) {
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByText("get_weather", { exact: true }).click();
  await page.getByRole("textbox", { name: "Enter city" }).fill("San Francisco");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Input Schema", exact: true }).click();
  await expect(
    page.getByText("San Francisco: 18°C, sunny", { exact: false }).first(),
  ).toBeVisible();
}

const screens = {
  "project-overview": "home",
  "tools-result": "tools",
};
for (const theme of ["light", "dark"] as const) {
  for (const [screen, route] of Object.entries(screens)) {
    test(`product ${theme}: ${screen}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const failures = await prepareApp(
        context,
        theme,
        memberFixture,
        baseURL,
      );
      page.on("pageerror", (error) => failures.push(error.message));
      await page.clock.setFixedTime(FIXED_TIME);
      await page.goto(`/p/${PROJECT_ID}/${route}`);
      await expect(
        page.getByRole("button", {
          name: "Switch context: Acme Labs / Weather Assistant",
        }),
      ).toBeVisible();
      if (screen === "project-overview") {
        await expect(
          page.getByRole("heading", { name: "Good afternoon, Visual" }),
        ).toBeVisible();
        await expect(
          page.getByText("tool exec · 30d", { exact: true }),
        ).toBeVisible();
        await page
          .getByRole("heading", { name: "Good afternoon, Visual" })
          .click();
      } else if (screen === "tools-result") await showTools(page);
      await captureApp(page, testInfo, screen, theme, failures);
    });
  }
}
