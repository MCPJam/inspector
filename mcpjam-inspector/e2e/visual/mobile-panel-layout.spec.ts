import { expect, test } from "@playwright/test";
import { weatherTool } from "./product-data";
import {
  prepareMobileApp,
  PROJECT_ID,
  checkWidth,
  finish,
} from "./mobile-layout-fixtures";

const longName = "search_documents_across_all_workspace_knowledge_collections";
const tools = [
  {
    ...weatherTool,
    description:
      "Local fixture: get weather for a city without calling an external server.",
  },
  {
    ...weatherTool,
    name: longName,
    description:
      "Local fixture with a long tool name. This description should remain readable on a phone, including all the words at the end of this description.",
  },
];

for (const theme of ["light", "dark"] as const) {
  for (const width of [375, 1440]) {
    test(`mobile panels ${theme} ${width}: tool parameters, result and return`, async ({
      page,
      context,
      baseURL,
    }) => {
      const mobile = width === 375;
      await page.setViewportSize({ width, height: mobile ? 812 : 900 });
      const origin = new URL(baseURL!).origin;
      const savedPreference = theme === "light" ? "true" : "false";
      await context.addInitScript(
        (saved) =>
          localStorage.setItem("mcpjam-inspector-jsonrpc-panel-visible", saved),
        savedPreference,
      );
      const failures = await prepareMobileApp(context, origin, theme, {
        "/api/mcp/tools/list": { tools },
        "/api/web/tools/list": { tools },
        "/api/mcp/tasks/capabilities": {
          supported: false,
          wire: "none",
          toolCalls: false,
        },
      });
      let executedCity: unknown;
      await context.route(
        /\/api\/(?:mcp|web)\/tools\/execute$/,
        async (route) => {
          executedCity = route.request().postDataJSON().parameters?.city;
          await route.fulfill({
            json: {
              status: "completed",
              result: {
                content: [
                  { type: "text", text: "Fixture result: Oslo is 18°C." },
                ],
              },
            },
          });
        },
      );
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      try {
        await page.goto(`/p/${PROJECT_ID}/tools`);
        await expect(
          page.getByText("get_weather", { exact: true }),
        ).toBeVisible({ timeout: 20_000 });

        await page.getByText("get_weather", { exact: true }).click();
        const city = page.getByRole("textbox", { name: "Enter city" });
        await expect(city).toBeVisible();
        await city.fill("Oslo");

        await checkWidth(page);
        if (!mobile) {
          const panes = page.locator(
            '[data-panel-id^="tools-"] > [data-slot="tabs-content"]',
          );
          await expect(panes).toHaveCount(3);
          expect(
            await panes.evaluateAll((items) =>
              items.every(
                (pane) =>
                  pane.tabIndex === -1 &&
                  pane.getAttribute("role") !== "tabpanel",
              ),
            ),
          ).toBe(true);
        }
        if (mobile)
          await expect(
            page.getByRole("tab", { name: "Browse", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await expect.poll(() => executedCity).toBe("Oslo");
        if (mobile) {
          await expect(
            page.getByRole("tab", { name: "Browse", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          await page.getByRole("tab", { name: "Results", exact: true }).click();
        }
        await expect(
          page
            .getByText("Fixture result: Oslo is 18°C.", { exact: false })
            .first(),
        ).toBeVisible();

        if (mobile) {
          await page.getByRole("tab", { name: "Logs", exact: true }).click();
          await expect(
            page.getByRole("tabpanel", { name: "Logs", exact: true }),
          ).toBeVisible();

          await page.getByRole("tab", { name: "Browse", exact: true }).click();
        }
        await expect(city).toHaveValue("Oslo");
        await city.evaluate((node) =>
          node.setAttribute("data-mount-probe", "preserved"),
        );
        await page.setViewportSize({
          width: mobile ? 1440 : 375,
          height: mobile ? 900 : 812,
        });
        await expect(city).toBeVisible();
        await expect(city).toHaveValue("Oslo");
        await expect(city).toHaveAttribute("data-mount-probe", "preserved");
        await page.setViewportSize({ width, height: mobile ? 812 : 900 });
        await expect(city).toHaveValue("Oslo");
        expect(
          await page.evaluate(() =>
            localStorage.getItem("mcpjam-inspector-jsonrpc-panel-visible"),
          ),
        ).toBe(savedPreference);
        if (!mobile) {
          const left = page.locator('[data-panel-id="tools-left"]');
          const before = (await left.boundingBox())!.width;
          const handle = page.getByRole("separator").first();
          const grip = (await handle.boundingBox())!;
          await page.mouse.move(
            grip.x + grip.width / 2,
            grip.y + grip.height / 2,
          );
          await page.mouse.down();
          await page.mouse.move(grip.x + 50, grip.y + grip.height / 2, {
            steps: 5,
          });
          await page.mouse.up();
          await expect
            .poll(async () => (await left.boundingBox())!.width)
            .not.toBe(before);
          await page
            .getByRole("button", { name: "Hide sidebar", exact: true })
            .click();
          await expect(city).not.toBeVisible();
          await page
            .getByRole("button", { name: "Show tools sidebar", exact: true })
            .click();
          await expect(city).toBeVisible();
          expect((await left.boundingBox())!.width).toBeGreaterThan(200);
          await expect(city).toHaveValue("Oslo");
          if (savedPreference === "false") {
            await page
              .getByRole("button", { name: "Show panel", exact: true })
              .click();
            const right = page.locator('[data-panel-id="tools-right"]');
            expect((await right.boundingBox())!.width).toBeGreaterThan(150);
          }
        }
        await page
          .getByRole("button", { name: "Show full tool list", exact: true })
          .click();
        await expect(
          page.getByText("get_weather", { exact: true }),
        ).toBeVisible();
        await page
          .getByText(longName, { exact: true })
          .scrollIntoViewIfNeeded();
        await checkWidth(page);
        if (mobile) {
          const name = page.getByText(longName, { exact: true });
          expect(
            await name.evaluate((node) =>
              Array.from(node.getClientRects()).every(
                (rect) => rect.left >= 0 && rect.right <= innerWidth,
              ),
            ),
          ).toBe(true);
        }
      } finally {
        await finish(failures, consoleErrors);
      }
    });
  }
}
