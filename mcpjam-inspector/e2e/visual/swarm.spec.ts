import { expect, test } from "@chromatic-com/playwright";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { prepareApp } from "./app-network";
import { captureApp } from "./snapshot";
import { swarmFixture } from "./swarm-data";

for (const theme of ["light", "dark"] as const) {
  for (const screen of ["swarm-overview", "swarm-personas", "swarm-sessions"]) {
    test(`product ${theme}: ${screen}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const failures = await prepareApp(context, theme, swarmFixture, baseURL);
      page.on("pageerror", (error) => failures.push(error.message));
      await page.clock.setFixedTime(FIXED_TIME);
      await page.goto(`/p/${PROJECT_ID}/swarms`);
      await expect(
        page.getByRole("button", { name: /Plan a weather-safe walk/ }),
      ).toBeVisible();
      if (screen === "swarm-personas") {
        await page
          .getByRole("button", { name: "Personas", exact: true })
          .click();
        await expect(
          page
            .getByText(
              "Check the weather and recommend whether to bring a jacket.",
              { exact: true },
            )
            .first(),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: /Open run completed/ }),
        ).toBeVisible();
      } else if (screen === "swarm-sessions") {
        await page
          .getByRole("button", { name: "Sessions", exact: true })
          .click();
        await expect(
          page.getByText("What is the weather in an unknown city?", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByText("3 sessions in scope", { exact: true }),
        ).toBeVisible();
      }
      await captureApp(page, testInfo, screen, theme, failures);
    });
  }
}
