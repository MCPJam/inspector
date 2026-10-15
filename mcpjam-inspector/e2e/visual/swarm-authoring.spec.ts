import { expect, test } from "@chromatic-com/playwright";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { prepareApp } from "./app-network";
import { swarmFixture } from "./swarm-data";
import { captureStableApp as captureApp } from "./stable-snapshot";

for (const theme of ["light", "dark"] as const) {
  for (const screen of ["swarm-empty", "swarm-create"]) {
    test(`product ${theme}: ${screen}`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const failures = await prepareApp(
        context,
        theme,
        {
          ...swarmFixture,
          queries: {
            ...swarmFixture.queries,
            "personas:listPersonas": [],
            "journeyRuns:getSwarmOverview": {
              runs: [],
              runsConsidered: 0,
              goalCompletion: {
                gradedCount: 0,
                passedCount: 0,
                passRate: null,
                runsWithGrades: 0,
                trend: [],
              },
            },
          },
        },
        baseURL,
      );
      page.on("pageerror", (error) => failures.push(error.message));
      await page.clock.setFixedTime(FIXED_TIME);
      await page.goto(
        `/p/${PROJECT_ID}/swarms${screen === "swarm-create" ? "/new" : ""}`,
      );
      if (screen === "swarm-create") {
        await expect(
          page.getByRole("heading", { name: "Create a swarm of your users" }),
        ).toBeVisible();
        await page
          .getByTestId("new-swarm-describe-input")
          .fill(
            "Travelers planning weekend walks need clear weather advice, including what to do when a city cannot be found.",
          );
        await page
          .getByRole("heading", { name: "Create a swarm of your users" })
          .click();
      } else {
        await expect(
          page.getByRole("heading", { name: "Create your first swarm" }),
        ).toBeVisible();
      }
      await captureApp(page, testInfo, screen, theme, failures);
    });
  }
}
