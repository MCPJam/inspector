import { expect, test } from "@chromatic-com/playwright";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { prepareApp } from "./app-network";
import { memberFixture, server } from "./product-data";
import { captureApp } from "./snapshot";
import { taskOwnerScope } from "../../shared/task-owner";

const accountA = "11111111111111111111111111111111";
const accountB = "22222222222222222222222222222222";
const taskId = "task-owned-by-account-b";
const scope = taskOwnerScope(PROJECT_ID, "cccccccccccccccccccccccccccccccc")!;

for (const theme of ["light", "dark"] as const) {
  for (const mode of ["none", "form", "url"] as const) {
    test(`product ${theme}: ${mode === "none" ? "task account panel" : `task ${mode} input`}`, async ({
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
            "/api/web/oauth/connections": {
              shared: false,
              connections: [
                {
                  connectionId: accountA,
                  label: "Personal workspace",
                  isDefault: true,
                },
                {
                  connectionId: accountB,
                  label: "Team workspace",
                  isDefault: false,
                },
              ],
            },
          },
        },
        baseURL,
      );
      await context.addInitScript(
        ({ serverId, taskId, scope, accountB, createdAt }) => {
          localStorage.setItem(
            "mcp-tracked-tasks-v4",
            JSON.stringify({
              version: 4,
              tasks: [
                {
                  serverId,
                  taskId,
                  scope,
                  connectionId: accountB,
                  wire: "extension",
                  createdAt,
                },
              ],
            }),
          );
        },
        {
          serverId: server._id,
          taskId,
          scope,
          accountB,
          createdAt: new Date(FIXED_TIME).toISOString(),
        },
      );
      await context.addInitScript(() => {
        window.open = () =>
          ({
            opener: null,
            location: {
              replace: (url: string) =>
                sessionStorage.setItem("taskConsentUrl", url),
            },
          }) as unknown as Window;
      });
      let needsInput = mode !== "none";
      let cancelled = false;
      const inputs: Record<string, unknown>[] = [];
      const commands: Record<string, unknown>[] = [];
      await page.route("**/api/web/tasks/**", async (route) => {
        const body = route.request().postDataJSON();
        const path = new URL(route.request().url()).pathname;
        const task = {
          taskId,
          status: cancelled
            ? "cancelled"
            : needsInput
              ? "input_required"
              : "working",
          ...(needsInput
            ? {
                inputRequests: {
                  answer: {
                    method: "elicitation/create",
                    params:
                      mode === "url"
                        ? {
                            mode: "url",
                            message: "Connect the Task account",
                            url: "https://example.test/connect?state=opaque",
                          }
                        : {
                            message: "Choose the city for this Task",
                            requestedSchema: {
                              type: "object",
                              properties: {
                                city: { type: "string", title: "City" },
                              },
                              required: ["city"],
                            },
                          },
                  },
                },
              }
            : {}),
          createdAt: new Date(FIXED_TIME).toISOString(),
          lastUpdatedAt: new Date(FIXED_TIME).toISOString(),
          ttlMs: null,
          pollIntervalMs: 3000,
        };
        let response: unknown;
        if (path.endsWith("/capabilities"))
          response = {
            wire: "extension",
            toolCalls: true,
            list: false,
            cancel: true,
            update: true,
            inlineResult: true,
          };
        else if (path.endsWith("/list"))
          response = { wire: "extension", tasks: [], registryTasks: [] };
        else if (path.endsWith("/get-batch"))
          response = { wire: "extension", tasks: [{ taskId, task }] };
        else if (path.endsWith("/get")) response = { wire: "extension", task };
        else if (path.endsWith("/update")) {
          inputs.push(body);
          needsInput = false;
          response = {
            wire: "extension",
            task: { ...task, status: "working", inputRequests: {} },
          };
        } else if (path.endsWith("/cancel")) {
          commands.push(body);
          cancelled = true;
          response = {
            wire: "extension",
            task: { ...task, status: "cancelled" },
          };
        } else {
          failures.push(`Unexpected Task route: ${path}`);
          response = {};
        }
        await route.fulfill({ json: response });
      });
      page.on("pageerror", (error) => failures.push(error.message));
      await page.clock.setFixedTime(FIXED_TIME);
      await page.goto(`/p/${PROJECT_ID}/tasks`);
      await expect(
        page.getByRole("combobox", { name: "Task account" }),
      ).toHaveText("Team workspace");
      await page.getByText(taskId.substring(0, 12), { exact: true }).click();
      if (mode !== "none") {
        await expect(page.getByRole("dialog")).toBeVisible();
        await captureApp(page, testInfo, `task-${mode}-input`, theme, failures);
        if (mode === "url") {
          expect(
            await page.evaluate(() => sessionStorage.getItem("taskConsentUrl")),
          ).toBeNull();
          await page.getByRole("button", { name: /open in new tab/i }).click();
          expect(
            await page.evaluate(() => sessionStorage.getItem("taskConsentUrl")),
          ).toBe("https://example.test/connect?state=opaque");
        } else {
          await page.getByRole("textbox", { name: /City/ }).fill("La Paz");
          await page
            .getByRole("button", { name: "Accept", exact: true })
            .click();
        }
        await expect.poll(() => inputs.length).toBe(1);
        expect(inputs[0]).toMatchObject({
          serverId: server._id,
          taskId,
          connectionId: accountB,
          ownerScope: scope,
          wire: "extension",
          inputResponses: {
            answer: {
              action: "accept",
              ...(mode === "form" ? { content: { city: "La Paz" } } : {}),
            },
          },
        });
        await expect(page.getByRole("dialog")).not.toBeVisible();
      }
      await expect(
        page.getByRole("button", { name: "Cancel Task", exact: true }),
      ).toBeVisible();
      if (mode === "none")
        await captureApp(page, testInfo, "task-account-panel", theme, failures);
      await page
        .getByRole("button", { name: "Cancel Task", exact: true })
        .click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({
        serverId: server._id,
        taskId,
        connectionId: accountB,
        ownerScope: scope,
        wire: "extension",
      });
      await page.getByRole("combobox", { name: "Task account" }).click();
      await expect(
        page.getByRole("option", { name: "Personal workspace", exact: true }),
      ).toBeVisible();
      expect(failures).toEqual([]);
    });
  }
}
