import { expect, test } from "@chromatic-com/playwright";
import type { Page } from "@playwright/test";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { prepareApp } from "./app-network";
import { chatQueries, chatResponses } from "./chat-data";
import {
  evalQueries,
  evalResponses,
  evalStatuses,
  SUITE_ID,
  RUN_ID,
} from "./eval-data";
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

async function showChat(page: Page) {
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByText("San Francisco weather", { exact: true }).click();
  const app = page.frameLocator("iframe").frameLocator("iframe");
  await expect(
    app.getByRole("heading", { name: "San Francisco" }),
  ).toBeVisible();
  await expect(app.getByText("18°C", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "It is sunny and 18°C in San Francisco. A light jacket should be enough for your walk.",
    ),
  ).toBeVisible();
}

async function showFailure(page: Page) {
  await page.getByRole("button", { name: /Inspect Unknown city/ }).click();
  await page.getByRole("button", { name: "Open iteration 2 details" }).click();
  await expect(
    page.getByRole("dialog", { name: "#2 Weather reliability" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "User value failed" }),
  ).toBeVisible();
  await expect(
    page.getByText("Failed because an assertion on the result did not hold."),
  ).toBeVisible();
}

const screens = {
  "project-overview": "home",
  "tools-result": "tools",
  "chat-app": "playground",
  "eval-failure": `evaluate/suite/${SUITE_ID}/runs/${RUN_ID}`,
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
        {
          ...memberFixture,
          statuses: evalStatuses,
          queries: { ...memberFixture.queries, ...evalQueries, ...chatQueries },
          responses: {
            ...memberFixture.responses,
            ...evalResponses,
            ...chatResponses,
          },
        },
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
      else if (screen === "chat-app") await showChat(page);
      else await showFailure(page);
      await captureApp(page, testInfo, screen, theme, failures);
    });
  }
}
