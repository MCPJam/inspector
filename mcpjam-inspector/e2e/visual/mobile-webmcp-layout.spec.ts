import { test, expect } from "@playwright/test";
import {
  prepareMobileApp,
  PROJECT_ID,
  checkWidth,
  inside,
  finish,
} from "./mobile-layout-fixtures";
import {
  encodeFrameStreamRecord,
  FRAME_STREAM_KIND,
} from "../../shared/browserd-frame-stream";
const tool = {
  toolKey: "fixture::add_topping",
  name: "add_topping",
  origin: "https://fixture.invalid",
  fromSubframe: false,
  description: "Fixture page tool: add a topping",
  registrationKind: "imperative",
  inputSchema: {
    type: "object",
    properties: { topping: { type: "string", description: "Topping to add" } },
    required: ["topping"],
  },
};
for (const theme of ["light", "dark"])
  for (const width of [375, 1440]) {
    test(`WebMCP layout ${theme} ${width}`, async ({
      page,
      context,
      baseURL,
    }) => {
      const mobile = width === 375;
      await page.setViewportSize({ width, height: mobile ? 812 : 900 });
      const origin = new URL(baseURL!).origin;
      const failures = await prepareMobileApp(context, origin, theme);
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      const jpeg = await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 800;
        c.height = 600;
        const g = c.getContext("2d")!;
        g.fillStyle = "white";
        g.fillRect(0, 0, 800, 600);
        g.fillStyle = "black";
        g.font = "24px sans-serif";
        g.fillText("Local fixture browser page", 50, 100);
        g.fillText("Pizza order: margherita", 50, 160);
        return c.toDataURL("image/jpeg").split(",")[1];
      });
      const frame = Buffer.from(
        encodeFrameStreamRecord({
          kind: FRAME_STREAM_KIND.frame,
          deviceWidth: 800,
          deviceHeight: 600,
          scale: 1,
          ts: 1,
          seq: 1,
          jpeg: Buffer.from(jpeg, "base64"),
        }),
      );
      const session = {
        sessionId: "mobile-fixture",
        status: "ready",
        url: "https://fixture.invalid",
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000,
        hardExpiresAt: Date.now() + 600000,
        viewportTransport: { kind: "native-window" },
        protocolVersion: 1,
      };
      await context.route(`${origin}/api/mcp/webmcp/sessions`, (route) =>
        route.fulfill({ json: session }),
      );
      await context.route(
        `${origin}/api/mcp/webmcp/sessions/mobile-fixture/events**`,
        (route) =>
          route.fulfill({
            contentType: "text/event-stream",
            body:
              "retry: 60000\n\n" +
              [
                { type: "session", session },
                { type: "tools", tools: [tool] },
                {
                  type: "activity",
                  entry: {
                    id: "a1",
                    ts: 1,
                    kind: "session_started",
                    url: session.url,
                  },
                },
              ]
                .map((e) => `data: ${JSON.stringify(e)}\n\n`)
                .join(""),
          }),
      );
      await context.route(
        `${origin}/api/mcp/webmcp/sessions/mobile-fixture/stream-nonce`,
        (route) => route.fulfill({ json: { nonce: "synthetic-frame-nonce" } }),
      );
      await context.routeWebSocket(
        /\/api\/web\/webmcp\/sessions\/mobile-fixture\/frames/,
        (socket) => {
          socket.send(JSON.stringify({ type: "capabilities", features: [] }));
          socket.send(frame);
        },
      );
      let input: unknown;
      await context.route(
        `${origin}/api/mcp/webmcp/sessions/mobile-fixture/command`,
        (route) => {
          const c = route.request().postDataJSON();
          if (c.type === "invoke_tool") input = c.input;
          return route.fulfill({
            json:
              c.type === "capture_screenshot"
                ? { screenshotBase64: jpeg }
                : c.type === "set_screencast"
                  ? { streaming: c.enabled }
                  : c.type === "invoke_tool"
                    ? { outcome: { state: "succeeded", output: "Added olives" } }
                    : { ok: true },
          });
        },
      );
      try {
        await page.goto(`/p/${PROJECT_ID}/webmcp`);
        await expect(
          page.getByRole("textbox", { name: "Page URL to inspect" }),
        ).toBeVisible({ timeout: 20000 });
        await page
          .getByRole("textbox", { name: "Page URL to inspect" })
          .fill(session.url);
        await page
          .getByRole("button", { name: "Open browser", exact: true })
          .click();
        await expect(page.getByText(tool.name, { exact: true })).toBeVisible();
        await page.getByText(tool.name, { exact: true }).click();
        const topping = page.getByRole("textbox", { name: "Enter topping" });
        await topping.fill("olives");
        await inside(
          page,
          page.getByRole("button", { name: "Invoke", exact: true }),
        );
        await page.getByRole("button", { name: "Invoke", exact: true }).click();
        await expect.poll(() => input).toEqual({ topping: "olives" });
        if (mobile)
          await page.getByRole("tab", { name: "Browser", exact: true }).click();
        await expect(page.locator("canvas").first()).toBeVisible();
        if (mobile) {
          await page
            .getByRole("tab", { name: "Activity", exact: true })
            .click();
          await expect(
            page.getByRole("tabpanel", { name: "Activity", exact: true }),
          ).toBeVisible();
          await page.getByRole("tab", { name: "Browse", exact: true }).click();
        }
        await expect(topping).toHaveValue("olives");
        await page
          .getByRole("button", { name: "Show full tool list", exact: true })
          .click();
        await expect(page.getByText(tool.name, { exact: true })).toBeVisible();
        await checkWidth(page);
      } finally {
        await finish(failures, errors);
      }
    });
  }
