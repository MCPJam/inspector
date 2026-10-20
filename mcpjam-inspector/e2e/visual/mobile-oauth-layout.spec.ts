import { test, expect, type Page, type Route } from "@playwright/test";
import { inside, checkWidth } from "./mobile-layout-fixtures";
import { startFakeOAuthMcpServer } from "../fixtures/fake-oauth-mcp-server";
async function proxy(route: Route) {
  const p = route.request().postDataJSON();
  const headers = new Headers(p.headers ?? {});
  headers.delete("host");
  headers.delete("content-length");
  const body =
    p.body == null
      ? undefined
      : headers
            .get("content-type")
            ?.includes("application/x-www-form-urlencoded")
        ? new URLSearchParams(p.body).toString()
        : typeof p.body === "string"
          ? p.body
          : JSON.stringify(p.body);
  const r = await fetch(p.url, { method: p.method ?? "GET", headers, body });
  const raw = await r.text();
  let result: unknown = raw;
  try {
    result = JSON.parse(raw);
  } catch {
    /* OAuth proxy also supports text responses. */
  }
  await route.fulfill({
    json: {
      status: r.status,
      statusText: r.statusText,
      headers: Object.fromEntries(r.headers.entries()),
      body: result,
    },
  });
}
async function step(page: Page) {
  const before = await page.evaluate(
    () => window.__oauthDebuggerE2EFlowState?.currentStep,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__oauthDebuggerE2EFlowState?.currentStep),
    )
    .not.toBe(before);
}
for (const theme of ["light", "dark"])
  for (const width of [375, 1440]) {
    test(`OAuth layout ${theme} ${width}`, async ({ page, context }) => {
      const mobile = width === 375;
      await page.setViewportSize({ width, height: mobile ? 812 : 900 });
      const fake = await startFakeOAuthMcpServer();
      const errors: string[] = [];
      const consoleErrors: string[] = [];
      const cloudAuthRequests: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          url.hostname.endsWith(".convex.cloud") ||
          url.hostname.endsWith(".mcpjam.com")
        )
          cloudAuthRequests.push(url.origin + url.pathname);
      });
      page.on("pageerror", (e) => errors.push(e.message));
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await context.addInitScript(
        (t) => localStorage.setItem("themeMode", t),
        theme,
      );
      await page.route("**/api/**/oauth/debug/proxy", proxy);
      await page.route("**/api/web/guest-session", (route) =>
        route.fulfill({
          json: {
            guestId: "mobile-fixture",
            token: "synthetic-guest-token",
            expiresAt: 4102444800000,
          },
        }),
      );
      await page.route("**/api/session-token", (route) =>
        route.fulfill({ json: { ok: true } }),
      );
      await page.route("**/api/web/oauth/import-tokens", (route) =>
        route.fulfill({ json: { success: true, kind: "generic" } }),
      );
      await page.route("**/__e2e/servers/connect", (route) =>
        route.fulfill({ json: { success: true } }),
      );
      try {
        await page.goto("/__e2e/oauth-debugger");
        await expect(page.getByTestId("oauth-e2e-status")).toHaveAttribute(
          "data-status",
          "idle",
          { timeout: 30000 },
        );
        await page
          .getByRole("button", { name: "Add OAuth server through debugger" })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Configure Server to Test",
        });
        await dialog
          .getByRole("textbox", { name: "Server Name" })
          .fill("oauth-e2e-target");
        await dialog
          .getByRole("textbox", { name: "Server URL" })
          .fill(
            fake.serverUrl +
              "?mobile-layout-long-url=" +
              "readable-target-".repeat(8),
          );
        await dialog
          .getByRole("button", { name: "Save configuration" })
          .click();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        // Remove only this DEV harness's configuration chrome; the real OAuthFlowTab fills the viewport.
        await page.addStyleTag({
          content:
            'form[aria-label="Add plain HTTP server"]{display:none} body>div#root>div>div.border-b{display:none}',
        });
        await page
          .locator('form[aria-label="Add plain HTTP server"]')
          .evaluate((el) => {
            el.parentElement!.style.display = "none";
          });
        for (const name of ["Continue", "Reset", "Copy", "Add"])
          await inside(page, page.getByRole("button", { name, exact: true }));
        const url = page
          .locator("button")
          .filter({ hasText: fake.serverUrl })
          .first();
        await inside(page, url);
        const text = url.locator("p");
        expect(
          await text.evaluate((el) => getComputedStyle(el).whiteSpace),
        ).toBe(mobile ? "nowrap" : "normal");
        await url.click();
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await checkWidth(page);
        for (let n = 0; n < 12; n++) {
          if (
            await page
              .getByRole("button", { name: "Authorize", exact: true })
              .isVisible()
          )
            break;
          await step(page);
        }
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        expect(
          await page.evaluate(() => navigator.clipboard.readText()),
        ).not.toBe("");
        if (mobile) {
          await page
            .getByRole("button", { name: "Show in diagram", exact: true })
            .first()
            .click();
          await expect(
            page.getByRole("tab", { name: "Diagram", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          await expect(
            page.getByRole("tab", { name: "Diagram", exact: true }),
          ).toBeFocused();
          await expect(page.locator(".react-flow__viewport")).toBeVisible();
          expect(
            await page.locator(".react-flow__viewport").getAttribute("style"),
          ).not.toMatch(/NaN|Infinity/);
          await page
            .getByRole("tab", { name: "Guide", exact: true })
            .first()
            .click();
        }
        page.on("popup", (p) => void p.close());
        await page
          .getByRole("button", { name: "Authorize", exact: true })
          .click();
        await expect
          .poll(() =>
            page.evaluate(
              () => !!window.__oauthDebuggerE2EFlowState?.authorizationUrl,
            ),
          )
          .toBe(true);
        const flow = await page.evaluate(
          () => window.__oauthDebuggerE2EFlowState!,
        );
        const redirect = await fetch(flow.authorizationUrl!, {
          redirect: "manual",
        });
        const cb = new URL(redirect.headers.get("location")!);
        await page.evaluate(
          ({ code, state }) =>
            window.postMessage(
              { type: "OAUTH_CALLBACK", code, state },
              location.origin,
            ),
          {
            code: cb.searchParams.get("code"),
            state: cb.searchParams.get("state"),
          },
        );
        for (let n = 0; n < 8; n++) {
          if (
            await page
              .getByRole("button", { name: "Connect Server", exact: true })
              .isVisible()
          )
            break;
          await step(page);
        }
        await inside(
          page,
          page.getByRole("button", { name: "Connect Server", exact: true }),
        );
        await page
          .getByRole("button", { name: "Connect Server", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Refresh Tokens", exact: true }),
        ).toBeVisible();
        await inside(
          page,
          page.getByRole("button", { name: "Refresh Tokens", exact: true }),
        );
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await expect
          .poll(() =>
            page.evaluate(
              () => window.__oauthDebuggerE2EFlowState?.currentStep,
            ),
          )
          .toBe("idle");
        await inside(
          page,
          page.getByRole("button", { name: "Continue", exact: true }),
        );
        await step(page);
        let requestStarted = false;
        let finishRequest: () => void = () => {};
        const requestFinished = new Promise<void>((resolve) => {
          finishRequest = resolve;
        });
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route(
          "**/api/**/oauth/debug/proxy",
          async (route) => {
            requestStarted = true;
            await gate;
            await proxy(route);
            finishRequest();
          },
          { times: 1 },
        );
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await expect.poll(() => requestStarted).toBe(true);
        const pending = page
          .getByRole("button", { name: /POST.*pending/ })
          .first();
        await expect(pending).toBeVisible();
        await inside(
          page,
          page.getByRole("button", { name: "Continue", exact: true }),
        );
        release();
        await requestFinished;
        await expect
          .poll(() =>
            page.evaluate(
              () => window.__oauthDebuggerE2EFlowState?.currentStep,
            ),
          )
          .not.toBe("idle");
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await step(page);
        await page.route("**/api/**/oauth/debug/proxy", (route) =>
          route.fulfill({
            json: {
              status: 503,
              statusText: "Fixture unavailable",
              headers: {},
              body: "Local fixture error",
            },
          }),
        );
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page.getByRole("tab", { name: "Raw", exact: true }).click();
        await expect(
          page.getByText(/503|Fixture unavailable|Local fixture error/).first(),
        ).toBeVisible();
        await inside(
          page,
          page.getByRole("button", { name: "Reset", exact: true }),
        );
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        if (mobile) {
          await page.getByRole("tab", { name: "Diagram", exact: true }).click();
          expect(
            await page.locator(".react-flow__viewport").getAttribute("style"),
          ).not.toMatch(/NaN|Infinity/);
        }
        await checkWidth(page);
        expect(errors).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(cloudAuthRequests).toEqual([]);
      } finally {
        await fake.close();
      }
    });
  }
