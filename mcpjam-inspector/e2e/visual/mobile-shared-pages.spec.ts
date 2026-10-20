import { expect, test } from "@playwright/test";
import {
  prepareMobileApp,
  PROJECT_ID,
  resourceName,
  templateName,
  promptName,
  taskId,
  capture,
  checkWidth,
  inside,
  finish,
  baseline,
} from "./mobile-layout-fixtures";

for (const theme of ["light", "dark"])
  for (const width of [375, 1440]) {
    test(`shared pages ${theme} ${width}`, async ({
      page,
      context,
      baseURL,
    }, info) => {
      const mobile = width === 375;
      await page.setViewportSize({ width, height: mobile ? 812 : 900 });
      const failures = await prepareMobileApp(
        context,
        new URL(baseURL!).origin,
        theme,
      );
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      try {
        await page.goto(`/p/${PROJECT_ID}/resources`);
        await expect(page.getByText(resourceName, { exact: true })).toBeVisible(
          { timeout: 20000 },
        );
        await capture(page, `resources-list-${width}-${theme}`);
        if (mobile)
          await page
            .getByRole("button", { name: "Open menu", exact: true })
            .click();
        await capture(page, `menu-open-${width}-${theme}`);
        await page
          .getByRole("button", { name: "Prompts", exact: true })
          .click();
        await expect(page).toHaveURL(/prompts/);
        await capture(page, `menu-after-selection-${width}-${theme}`);
        if (mobile) {
          if (baseline) await page.keyboard.press("Escape");
          else await expect(page.getByRole("dialog")).toBeHidden();
        } else
          await expect(
            page.getByRole("button", { name: "Prompts", exact: true }),
          ).toBeVisible();
        await page.goto(`/p/${PROJECT_ID}/resources`);
        await expect(page.getByText(resourceName, { exact: true })).toBeVisible(
          { timeout: 20000 },
        );

        if (baseline)
          await page
            .getByText(resourceName, { exact: true })
            .dispatchEvent("click");
        else await page.getByText(resourceName, { exact: true }).click();
        await expect(
          page.getByText("Fixture document contents", { exact: true }),
        ).toBeVisible();
        await capture(page, `resource-detail-${width}-${theme}`);
        if (mobile && !baseline)
          await page
            .getByRole("button", { name: "Back to list", exact: true })
            .click();
        if (baseline)
          await page
            .getByRole("button", { name: /^Templates/ })
            .dispatchEvent("click");
        else await page.getByRole("button", { name: /^Templates/ }).click();
        await expect(
          page.getByText(templateName, { exact: true }),
        ).toBeVisible();
        if (baseline)
          await page
            .getByText(templateName, { exact: true })
            .dispatchEvent("click");
        else await page.getByText(templateName, { exact: true }).click();
        const param = page.getByRole("textbox", { name: /Enter name/ });
        await param.fill("report");
        await capture(page, `template-form-${width}-${theme}`);
        if (!baseline) {
          await checkWidth(page);
          await inside(
            page,
            page.getByRole("button", { name: "Read Resource", exact: true }),
          );
          await page
            .getByRole("button", { name: "Read Resource", exact: true })
            .click();
          if (mobile)
            await page
              .getByRole("tab", { name: "Results", exact: true })
              .click();
          await expect(
            page.getByText("Fixture document contents", { exact: true }),
          ).toBeVisible();
          if (mobile)
            await page
              .getByRole("tab", { name: "Browse", exact: true })
              .click();
          await expect(param).toHaveValue("report");
          await page
            .getByRole("button", { name: "Clear selection", exact: true })
            .click();
          await expect(
            page.getByText(templateName, { exact: true }),
          ).toBeVisible();
        }
        await page.goto(`/p/${PROJECT_ID}/prompts`);
        await expect(page.getByText(promptName, { exact: true })).toBeVisible({
          timeout: 20000,
        });
        await capture(page, `prompts-list-${width}-${theme}`);
        if (baseline)
          await page
            .getByText(promptName, { exact: true })
            .dispatchEvent("click");
        else await page.getByText(promptName, { exact: true }).click();
        const subject = page.getByRole("textbox", { name: "Enter subject" });
        await subject.fill("mobile QA");
        await capture(page, `prompt-form-${width}-${theme}`);
        if (!baseline) {
          await inside(
            page,
            page.getByRole("button", { name: "Run", exact: true }),
          );
          await page.getByRole("button", { name: "Run", exact: true }).click();
          if (mobile)
            await page
              .getByRole("tab", { name: "Results", exact: true })
              .click();
          await expect(
            page.getByText("Fixture prompt result", { exact: false }).first(),
          ).toBeVisible();
          await capture(page, `prompt-result-${width}-${theme}`);
          if (mobile) {
            await page.getByRole("tab", { name: "Logs", exact: true }).click();
            await page
              .getByRole("tab", { name: "Browse", exact: true })
              .click();
          }
          await expect(subject).toHaveValue("mobile QA");
          await page
            .getByRole("button", { name: "Show full tool list", exact: true })
            .click();
          await expect(
            page.getByText(promptName, { exact: true }),
          ).toBeVisible();
          await checkWidth(page);
        }
        await page.goto(`/p/${PROJECT_ID}/tasks`);
        await expect(
          page.getByText(taskId.substring(0, 12), { exact: true }),
        ).toBeVisible({ timeout: 20000 });
        await capture(page, `tasks-list-${width}-${theme}`);
        if (baseline)
          await page
            .getByText(taskId.substring(0, 12), { exact: true })
            .dispatchEvent("click");
        else
          await page
            .getByText(taskId.substring(0, 12), { exact: true })
            .click();
        await expect(
          page.getByRole("button", { name: "Cancel Task", exact: true }),
        ).toBeVisible();
        await capture(page, `task-detail-${width}-${theme}`);
        if (!baseline) {
          await inside(
            page,
            page.getByRole("button", { name: "Cancel Task", exact: true }),
          );
          await checkWidth(page);
          if (mobile) {
            await page
              .getByRole("button", { name: "Back to list", exact: true })
              .click();
            await expect(
              page.getByText(taskId.substring(0, 12), { exact: true }),
            ).toBeVisible();
          }
        }
      } finally {
        await finish(page, failures, errors, info);
      }
    });
  }
