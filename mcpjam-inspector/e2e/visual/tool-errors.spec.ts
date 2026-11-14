import { expect, test } from "@chromatic-com/playwright";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { prepareApp } from "./app-network";
import { memberFixture } from "./product-data";
import { captureStableApp as captureApp } from "./stable-snapshot";

for (const theme of ["light", "dark"] as const) {
  test(`product ${theme}: tool-error`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const failures = await prepareApp(
      context,
      theme,
      {
        ...memberFixture,
        responses: {
          ...memberFixture.responses,
          "/api/web/tools/execute": {
            status: "completed",
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Unknown city: Atlantis. Enter a real city.",
                },
              ],
            },
          },
        },
      },
      baseURL,
    );
    page.on("pageerror", (error) => failures.push(error.message));
    await page.clock.setFixedTime(FIXED_TIME);
    await page.goto(`/p/${PROJECT_ID}/tools`);
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.getByText("get_weather", { exact: true }).click();
    await page.getByRole("textbox", { name: "Enter city" }).fill("Atlantis");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(
      page
        .getByText("Unknown city: Atlantis. Enter a real city.", {
          exact: false,
        })
        .first(),
    ).toBeVisible();
    await captureApp(page, testInfo, "tool-error", theme, failures);
  });
}
