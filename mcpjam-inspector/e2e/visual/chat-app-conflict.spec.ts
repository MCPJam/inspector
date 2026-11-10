import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { buildSync } from "esbuild";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { prepareApp } from "./app-network";
import { chatQueries, chatResponses } from "./chat-data";
import { memberFixture } from "./product-data";

type ChatRequest = {
  chatSessionId: string;
  expectedVersion?: number;
  appTools?: { alias: string; rawName: string }[];
  messages: unknown[];
};

test("product light: a conflict keeps the mounted App and its tool", async ({
  page,
  context,
  baseURL,
}) => {
  const script = buildSync({
    entryPoints: [
      fileURLToPath(new URL("../fixtures/counter-app.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
  }).outputFiles[0].text;
  const widgetPath = "/api/web/apps/mcp-apps/widget-content";
  const fixtureFailures = await prepareApp(
    context,
    "light",
    {
      ...memberFixture,
      queries: { ...memberFixture.queries, ...chatQueries },
      responses: {
        ...memberFixture.responses,
        ...chatResponses,
        [widgetPath]: {
          ...chatResponses[widgetPath],
          html: `<button disabled>Count 0</button><script>${script.replace(/<\/script/gi, "<\\/script")}</script>`,
        },
      },
    },
    baseURL,
  );
  page.on("pageerror", (error) => fixtureFailures.push(error.message));
  await page.clock.setFixedTime(FIXED_TIME);

  const requests: ChatRequest[] = [];
  let alias: string | undefined;
  await page.route("**/api/web/chat-v2", async (route) => {
    const body: ChatRequest = route.request().postDataJSON();
    requests.push(body);
    const turn = requests.length;
    const turnId = `turn-${turn}`;
    const toolCall = turn === 2;
    const chunks = [
      { type: "start", messageId: `assistant-${turn}` },
      { type: "start-step" },
      {
        type: "data-trace-event",
        transient: true,
        data: {
          type: "turn_start",
          turnId,
          promptIndex: 0,
          startedAtMs: Date.now(),
        },
      },
      ...(toolCall
        ? [
            {
              type: "tool-input-available",
              toolCallId: "read-counter",
              toolName: alias,
              input: {},
            },
          ]
        : [
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "Turn complete" },
            { type: "text-end", id: "text" },
          ]),
      { type: "finish-step" },
      { type: "finish" },
      {
        type: "data-persist-receipt",
        transient: true,
        data: {
          chatSessionId: body.chatSessionId,
          turnId,
          ...(turn === 1
            ? { outcome: "conflict", currentVersion: 2 }
            : { outcome: "saved", version: turn - 1 }),
        },
      },
    ];
    await route.fulfill({
      contentType: "text/event-stream",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body:
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        "data: [DONE]\n\n",
    });
  });

  await page.goto(`/p/${PROJECT_ID}/playground`);
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByText("San Francisco weather", { exact: true }).click();
  const frame = page.locator("iframe");
  const counter = frame
    .contentFrame()
    .frameLocator("iframe")
    .getByRole("button", { name: /Count/ });
  await expect(counter).toBeEnabled();
  for (let count = 1; count <= 3; count += 1) {
    await counter.press("Enter");
    await expect(counter).toHaveText(`Count ${count}`);
  }
  const originalFrame = await frame.evaluateHandle((node) => node);
  const instance = await counter.getAttribute("data-instance");
  expect(instance).toBeTruthy();

  const composer = page.locator("textarea").first();
  await composer.fill("Continue this conversation");
  await composer.press("Enter");
  await expect(page.getByText(/Someone else updated this chat/)).toBeVisible();
  expect(requests[0].chatSessionId).toBe("visual-chat-session");
  expect(requests[0].expectedVersion).toBe(1);
  alias = requests[0].appTools?.find(
    (tool) => tool.rawName === "read_count",
  )?.alias;
  expect(alias).toBeTruthy();
  expect(await originalFrame.evaluate((node) => node.isConnected)).toBe(true);
  await expect(counter).toHaveText("Count 3");
  expect(await counter.getAttribute("data-instance")).toBe(instance);

  await composer.fill("Read the counter");
  await composer.press("Enter");
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(3);
  expect(requests[1].chatSessionId).not.toBe(requests[0].chatSessionId);
  expect(requests[1].expectedVersion).toBeUndefined();
  expect(requests[1].appTools).toContainEqual(
    expect.objectContaining({ alias }),
  );
  expect(requests[2].messages.at(-1)).toMatchObject({
    parts: expect.arrayContaining([
      expect.objectContaining({
        toolCallId: "read-counter",
        type: `tool-${alias}`,
        state: "output-available",
        output: {
          content: [
            { type: "text", text: JSON.stringify({ instance, count: 3 }) },
          ],
        },
      }),
    ]),
  });

  const source = page.getByText("San Francisco weather", { exact: true });
  if (!(await source.isVisible())) {
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
  }
  await source.click();
  await expect(counter).toHaveText("Count 0");
  expect(await originalFrame.evaluate((node) => node.isConnected)).toBe(false);
  await expect(counter).toBeEnabled();
  expect(await counter.getAttribute("data-instance")).not.toBe(instance);
  expect(fixtureFailures).toEqual([]);
});
