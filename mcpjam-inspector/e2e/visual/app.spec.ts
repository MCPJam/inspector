import { captureApp } from "./snapshot";
import { expect, test } from "@chromatic-com/playwright";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { prepareApp } from "./app-network";

for (const theme of ["light", "dark"] as const) {
  for (const screen of ["connections", "add-server", "playground"] as const) {
    test(`inspector ${theme}: ${screen}`, async ({
      page,
      context,
    }, testInfo) => {
      const failures = await prepareApp(context, theme);
      page.on("pageerror", (error) => failures.push(error.message));
      await page.clock.setFixedTime(FIXED_TIME);
      await page.goto(
        `/p/${PROJECT_ID}/${screen === "playground" ? "playground" : "servers"}`,
      );
      await expect(page.getByTestId("app-shell")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Switch project: Visual Pilot" }),
      ).toBeVisible();
      if (screen !== "playground") {
        await expect(
          page.getByRole("heading", { name: "No servers connected" }),
        ).toBeVisible();
        if (screen === "add-server") {
          await page
            .getByRole("button", { name: "Add Your First Server" })
            .click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await expect(
            page.getByRole("heading", { name: "Add MCP Server" }),
          ).toBeVisible();
        }
      } else {
        await expect(page.getByTestId("app-shell")).not.toContainText(
          "Something went wrong",
        );
        await expect(page.locator("textarea").first()).toBeVisible();
        await expect(
          page.getByText("This is your playground for MCP.", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Connect a server", exact: true }),
        ).toBeVisible();
      }
      await captureApp(page, testInfo, screen, theme, failures);
    });
  }
}
