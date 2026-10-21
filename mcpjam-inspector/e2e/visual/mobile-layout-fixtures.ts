import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { memberFixture, server } from "./product-data";
export { PROJECT_ID } from "./app-data";

export const resourceName =
  "workspace_documents_with_a_very_long_uninterrupted_resource_name";
export const templateName = "workspace_document_template_with_a_very_long_name";
export const promptName =
  "summarize_workspace_documents_with_a_very_long_prompt_name";
export const taskId =
  "task-with-a-long-identifier-that-must-wrap-without-hiding-cancel";
export const description =
  "Local fixture description with enough words to wrap across several lines on a phone. The final words must remain readable.";
const task = {
  taskId,
  status: "working",
  createdAt: "2026-10-20T12:00:00Z",
  lastUpdatedAt: "2026-10-20T12:00:01Z",
  ttl: 60000,
  pollInterval: 1000,
};
export async function prepareMobileApp(
  context: BrowserContext,
  origin: string,
  theme: string,
  responses: Record<string, unknown> = {},
) {
  const { prepareApp } = await import("./app-network");
  await context.addInitScript(() => {
    localStorage.setItem(
      "mcp-local-browser-consent-v1",
      JSON.stringify({
        token: "synthetic-mobile-layout-consent",
        grantedAt: "2026-10-20",
      }),
    );
  });
  const failures = await prepareApp(
    context,
    theme,
    {
      ...memberFixture,
      convexOrigin: "wss://visual.invalid",
      responses: {
        ...memberFixture.responses,
        "/api/web/flags": { flags: { "local-browser-enabled": true } },
        "/api/mcp/servers": {
          success: true,
          servers: [
            {
              id: server.name,
              status: "connected",
              config: { url: server.url },
            },
          ],
        },
        "/api/mcp/resources/list": {
          resources: [
            {
              name: resourceName,
              uri: "fixture://workspace/document",
              description,
            },
          ],
        },
        "/api/mcp/resource-templates/list": {
          resourceTemplates: [
            {
              name: templateName,
              uriTemplate: "fixture://workspace/{name}",
              description,
            },
          ],
        },
        "/api/mcp/resources/read": {
          content: {
            contents: [
              {
                type: "text",
                uri: "fixture://workspace/document",
                text: "Fixture document contents",
              },
            ],
          },
        },
        "/api/mcp/prompts/list": {
          prompts: [
            {
              name: promptName,
              description,
              arguments: [
                {
                  name: "subject",
                  description: "Subject to summarize",
                  required: true,
                },
              ],
            },
          ],
        },
        "/api/mcp/prompts/get": {
          content: {
            messages: [
              {
                role: "user",
                content: { type: "text", text: "Fixture prompt result" },
              },
            ],
          },
        },
        "/api/mcp/tasks/capabilities": {
          wire: "legacy",
          toolCalls: true,
          list: true,
          cancel: true,
          update: true,
          inlineResult: false,
        },
        "/api/mcp/tasks/list": { wire: "legacy", tasks: [task] },
        "/api/mcp/tasks/get": { wire: "legacy", task },
        "/api/mcp/tasks/progress": { progress: null },
        "/api/mcp/tasks/progress/all": { progress: [] },
        "/api/mcp/subscriptions/state": {
          supported: false,
          desired: { resources: [], taskIds: [] },
          observed: { resources: [], taskIds: [] },
        },
        ...responses,
      },
    },
    origin,
  );
  await context.routeWebSocket(
    (url) =>
      url.origin === origin.replace(/^http/, "ws") &&
      url.pathname === "/" &&
      url.searchParams.has("token"),
    (socket) => socket.send(JSON.stringify({ type: "connected" })),
  );
  await context.route(`${origin}/api/mcp/mrtr/stream**`, (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await context.route(`${origin}/api/mcp/subscriptions/stream**`, (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await context.route(`${origin}/api/mcp/elicitation/stream**`, (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "retry: 60000\n\n",
    }),
  );
  return failures;
}
export async function checkWidth(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
export async function inside(
  page: Page,
  locator: ReturnType<Page["getByRole"]>,
) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const v = page.viewportSize()!;
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(v.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(v.height + 1);
}
export async function finish(failures: string[], errors: string[]) {
  expect.soft(failures).toEqual([]);
  expect.soft(
    errors.filter(
      (x) =>
        x !==
        "Unknown event handler property `%s`. It will be ignored. onProjectShared",
    ),
  ).toEqual([]);
}
