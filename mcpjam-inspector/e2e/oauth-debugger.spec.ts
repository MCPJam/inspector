import { expect, type Page, type Route, test } from "@playwright/test";
import { startFakeOAuthMcpServer } from "./fixtures/fake-oauth-mcp-server";

type ProxyPayload = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type OAuthE2EFlowState = {
  authorizationUrl?: string;
  currentStep?: string;
  state?: string;
};

function toBodyInit(payload: ProxyPayload): string | undefined {
  if (payload.body === undefined || payload.body === null) {
    return undefined;
  }

  const headers = new Headers(payload.headers ?? {});
  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(
      payload.body as Record<string, unknown>
    )) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
    return params.toString();
  }

  return typeof payload.body === "string"
    ? payload.body
    : JSON.stringify(payload.body);
}

async function fulfillDebugProxy(route: Route) {
  const payload = JSON.parse(
    route.request().postData() ?? "{}"
  ) as ProxyPayload;
  const headers = new Headers(payload.headers ?? {});
  headers.delete("host");
  headers.delete("content-length");

  const upstream = await fetch(payload.url, {
    method: payload.method ?? "GET",
    headers,
    body: toBodyInit(payload),
  });

  const text = await upstream.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: upstream.status,
      statusText: upstream.statusText,
      headers: Object.fromEntries(upstream.headers.entries()),
      body,
    }),
  });
}

async function advanceUntilAuthorize(page: Page) {
  const authorizeButton = page.getByRole("button", { name: /^Authorize$/ });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await authorizeButton.isVisible().catch(() => false)) {
      return authorizeButton;
    }

    await page.getByRole("button", { name: /^Continue$/ }).click();
    await page.waitForTimeout(300);
  }

  await expect(authorizeButton).toBeVisible({ timeout: 10_000 });
  return authorizeButton;
}

async function advanceUntilConnectServer(page: Page) {
  const connectServerButton = page.getByRole("button", {
    name: /^Connect Server$/,
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await connectServerButton.isVisible().catch(() => false)) {
      return connectServerButton;
    }

    const continueButton = page.getByRole("button", { name: /^Continue$/ });
    if (await continueButton.isVisible().catch(() => false)) {
      await continueButton.click();
    }
    await page.waitForTimeout(500);
  }

  await expect(connectServerButton).toBeVisible({ timeout: 10_000 });
  return connectServerButton;
}

test.describe("OAuth Debugger smoke", () => {
  test("completes OAuth, imports tokens, then reconnects without a bearer shortcut", async ({
    page,
  }) => {
    const fakeServer = await startFakeOAuthMcpServer();
    const importRequests: unknown[] = [];
    const reconnectRequests: Array<{
      headers: Record<string, string>;
      body: unknown;
    }> = [];

    await page.route("**/api/**/oauth/debug/proxy", fulfillDebugProxy);
    await page.route("**/api/web/oauth/import-tokens", async (route) => {
      importRequests.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          kind: "generic",
          expiresAt: Date.now() + 3600_000,
        }),
      });
    });
    await page.route("**/__e2e/oauth/reconnect", async (route) => {
      reconnectRequests.push({
        headers: route.request().headers(),
        body: JSON.parse(route.request().postData() ?? "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });

    try {
      await page.goto("/__e2e/oauth-debugger");

      await expect(
        page.getByRole("heading", { name: "Configure Server to Test" })
      ).toBeVisible();
      await page.getByLabel("Server Name").fill("oauth-e2e-target");
      await page.getByLabel("Server URL").fill(fakeServer.serverUrl);
      await page.getByRole("button", { name: "Save configuration" }).click();
      const activeConfigDialog = page.getByRole("dialog", {
        name: "Configure Server to Test",
      });
      await page.keyboard.press("Escape");
      await expect(activeConfigDialog).toBeHidden({ timeout: 10_000 });

      await expect(
        page.getByRole("button", { name: `${fakeServer.serverUrl} Edit` })
      ).toBeVisible();

      const authorizeButton = await advanceUntilAuthorize(page);

      page.on("popup", (popup) => {
        void popup.close().catch(() => {});
      });
      await authorizeButton.click();
      const flowStateHandle = await page.waitForFunction(() => {
        const state = window.__oauthDebuggerE2EFlowState;
        return state?.authorizationUrl && state?.state ? state : null;
      });
      const flowState =
        (await flowStateHandle.jsonValue()) as OAuthE2EFlowState;
      expect(flowState.authorizationUrl).toContain(fakeServer.origin);
      expect(flowState.state).toBeTruthy();

      await page.evaluate((state) => {
        const message = {
          type: "OAUTH_CALLBACK",
          code: "e2e-auth-code",
          state,
        };
        window.postMessage(message, window.location.origin);
        const channel = new BroadcastChannel("oauth_callback_channel");
        channel.postMessage(message);
        channel.close();
      }, flowState.state);

      const connectServerButton = await advanceUntilConnectServer(page);
      await connectServerButton.click();

      await expect(page.getByTestId("oauth-e2e-status")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 10_000 }
      );

      expect(importRequests).toHaveLength(1);
      expect(importRequests[0]).toMatchObject({
        projectId: "oauth-debugger-e2e-project",
        serverId: "oauth-debugger-e2e-server",
        serverUrl: fakeServer.serverUrl,
        kind: "generic",
        clientInformation: {
          clientId: "e2e-client-id",
        },
        tokens: {
          access_token: "e2e-access-token",
          refresh_token: "e2e-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        },
      });

      expect(reconnectRequests).toHaveLength(1);
      expect(reconnectRequests[0].headers.authorization).toBeUndefined();
      expect(JSON.stringify(reconnectRequests[0].body)).not.toContain(
        "Bearer e2e-access-token"
      );
      expect(JSON.stringify(reconnectRequests[0].body)).not.toContain(
        "e2e-access-token"
      );

      expect(
        fakeServer.requests.some(
          (request) =>
            request.path === "/mcp" &&
            request.authorization === "Bearer e2e-access-token"
        )
      ).toBe(true);
    } finally {
      await fakeServer.close();
    }
  });
});
