import { expect, type Page, type Route, test } from "@playwright/test";
import {
  startFakeOAuthMcpServer,
  startFakePlainMcpServer,
} from "./fixtures/fake-oauth-mcp-server";

type ServerKind = "plain" | "oauth";

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

type ConnectRequestRecord = {
  headers: Record<string, string>;
  body: {
    projectId?: string;
    serverId?: string;
    serverName?: string;
    serverUrl?: string;
    kind?: ServerKind;
    intent?: string;
  };
};

type BackendCredentialUseRecord = {
  serverName?: string;
  serverUrl?: string;
  authorization: string;
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

function initializeBody(serverName: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: `${serverName}-initialize`,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "mcpjam-e2e-backend",
        version: "0.0.0",
      },
    },
  });
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

async function fulfillBackendConnect(
  route: Route,
  storedCredentials: Map<string, string>,
  backendCredentialUses: BackendCredentialUseRecord[]
) {
  const body = JSON.parse(
    route.request().postData() ?? "{}"
  ) as ConnectRequestRecord["body"];
  const serverName = body.serverName ?? "unknown-server";
  const serverUrl = body.serverUrl;

  if (!serverUrl) {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "missing_server_url" }),
    });
    return;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (body.kind === "oauth") {
    const storedToken = storedCredentials.get(body.serverId ?? "");
    if (!storedToken) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "missing_credential" }),
      });
      return;
    }
    headers.Authorization = `Bearer ${storedToken}`;
    backendCredentialUses.push({
      serverName: body.serverName,
      serverUrl,
      authorization: headers.Authorization,
    });
  }

  const upstream = await fetch(serverUrl, {
    method: "POST",
    headers,
    body: initializeBody(serverName),
  });

  await route.fulfill({
    status: upstream.ok ? 200 : 502,
    contentType: "application/json",
    body: JSON.stringify({
      success: upstream.ok,
      upstreamStatus: upstream.status,
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

async function completeOAuthDebuggerFlow(page: Page, fakeOAuthOrigin: string) {
  const authorizeButton = await advanceUntilAuthorize(page);

  page.on("popup", (popup) => {
    void popup.close().catch(() => {});
  });
  await authorizeButton.click();
  const flowStateHandle = await page.waitForFunction(() => {
    const state = window.__oauthDebuggerE2EFlowState;
    return state?.authorizationUrl && state?.state ? state : null;
  });
  const flowState = (await flowStateHandle.jsonValue()) as OAuthE2EFlowState;
  expect(flowState.authorizationUrl).toContain(fakeOAuthOrigin);
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
}

function expectNoFrontendBearerShortcut(record: ConnectRequestRecord) {
  expect(record.headers.authorization).toBeUndefined();
  const serializedBody = JSON.stringify(record.body);
  expect(serializedBody).not.toContain("Bearer e2e-access-token");
  expect(serializedBody).not.toContain("e2e-access-token");
}

test.describe("OAuth Debugger e2e", () => {
  test("covers first connect and reconnect for plain and OAuth MCP servers", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("oauth-debugger-e2e-started")) {
        localStorage.removeItem("oauth-debugger-e2e-servers-v1");
        sessionStorage.setItem("oauth-debugger-e2e-started", "true");
      }
      delete window.__oauthDebuggerE2EEvents;
      delete window.__oauthDebuggerE2EFlowState;
    });

    const fakePlainServer = await startFakePlainMcpServer();
    const fakeOAuthServer = await startFakeOAuthMcpServer();
    const importRequests: unknown[] = [];
    const connectRequests: ConnectRequestRecord[] = [];
    const storedCredentials = new Map<string, string>();
    const backendCredentialUses: BackendCredentialUseRecord[] = [];

    await page.route("**/api/**/oauth/debug/proxy", fulfillDebugProxy);
    await page.route("**/api/web/oauth/import-tokens", async (route) => {
      const request = JSON.parse(route.request().postData() ?? "{}");
      importRequests.push(request);
      if (
        typeof request.serverId === "string" &&
        typeof request.tokens?.access_token === "string"
      ) {
        storedCredentials.set(request.serverId, request.tokens.access_token);
      }
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
    await page.route("**/__e2e/servers/connect", async (route) => {
      const body = JSON.parse(
        route.request().postData() ?? "{}"
      ) as ConnectRequestRecord["body"];
      connectRequests.push({
        headers: route.request().headers(),
        body,
      });
      await fulfillBackendConnect(
        route,
        storedCredentials,
        backendCredentialUses
      );
    });

    try {
      await page.goto("/__e2e/oauth-debugger");

      await page.getByLabel("Plain server name").fill("plain-e2e-target");
      await page.getByLabel("Plain server URL").fill(fakePlainServer.serverUrl);
      await page.getByRole("button", { name: "Add plain HTTP server" }).click();
      await expect(
        page.getByTestId("server-row-plain-e2e-target")
      ).toHaveAttribute("data-status", "disconnected");

      await page
        .getByRole("button", { name: "Connect plain-e2e-target" })
        .click();
      await expect(
        page.getByTestId("server-row-plain-e2e-target")
      ).toHaveAttribute("data-status", "connected");
      const plainRequestsBeforeReconnect = fakePlainServer.requests.filter(
        (request) => request.path === "/mcp"
      ).length;
      expect(
        fakePlainServer.requests.some(
          (request) => request.path === "/mcp" && !request.authorization
        )
      ).toBe(true);

      await page
        .getByRole("button", { name: "Add OAuth server through debugger" })
        .click();
      const activeConfigDialog = page.getByRole("dialog", {
        name: "Configure Server to Test",
      });
      await expect(
        page.getByRole("heading", { name: "Configure Server to Test" })
      ).toBeVisible();
      await activeConfigDialog
        .getByRole("textbox", { name: "Server Name" })
        .fill("oauth-e2e-target");
      await activeConfigDialog
        .getByRole("textbox", { name: "Server URL" })
        .fill(fakeOAuthServer.serverUrl);
      await activeConfigDialog
        .getByRole("button", { name: "Save configuration" })
        .click();
      await page.keyboard.press("Escape");
      await expect(activeConfigDialog).toBeHidden({ timeout: 10_000 });

      await completeOAuthDebuggerFlow(page, fakeOAuthServer.origin);
      await expect(
        page.getByTestId("server-row-oauth-e2e-target")
      ).toHaveAttribute("data-status", "connected");

      expect(importRequests).toHaveLength(1);
      expect(importRequests[0]).toMatchObject({
        projectId: "oauth-debugger-e2e-project",
        serverId: "oauth-debugger-e2e-server",
        serverUrl: fakeOAuthServer.serverUrl,
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
      expect(storedCredentials.get("oauth-debugger-e2e-server")).toBe(
        "e2e-access-token"
      );
      const oauthFirstConnect = connectRequests.find(
        (request) =>
          request.body.serverName === "oauth-e2e-target" &&
          request.body.intent === "oauth-debugger"
      );
      expect(oauthFirstConnect).toBeTruthy();
      expectNoFrontendBearerShortcut(oauthFirstConnect!);
      expect(backendCredentialUses).toContainEqual({
        serverName: "oauth-e2e-target",
        serverUrl: fakeOAuthServer.serverUrl,
        authorization: "Bearer e2e-access-token",
      });
      expect(
        await page.evaluate(() =>
          JSON.stringify(
            Object.fromEntries(
              Array.from({ length: localStorage.length }, (_, index) => {
                const key = localStorage.key(index);
                return [key, key ? localStorage.getItem(key) : null];
              })
            )
          )
        )
      ).not.toContain("e2e-access-token");

      await page.evaluate(() => {
        delete window.__oauthDebuggerE2EEvents;
        delete window.__oauthDebuggerE2EFlowState;
      });
      await page.reload();

      await expect(
        page.getByTestId("server-row-plain-e2e-target")
      ).toHaveAttribute("data-status", "disconnected");
      await expect(
        page.getByTestId("server-row-oauth-e2e-target")
      ).toHaveAttribute("data-status", "disconnected");

      await page
        .getByRole("button", { name: "Reconnect plain-e2e-target" })
        .click();
      await expect(
        page.getByTestId("server-row-plain-e2e-target")
      ).toHaveAttribute("data-status", "connected");
      expect(
        fakePlainServer.requests.filter((request) => request.path === "/mcp")
      ).toHaveLength(plainRequestsBeforeReconnect + 1);

      const oauthCredentialUsesBeforeReconnect = backendCredentialUses.length;
      await page
        .getByRole("button", { name: "Reconnect oauth-e2e-target" })
        .click();
      await expect(
        page.getByTestId("server-row-oauth-e2e-target")
      ).toHaveAttribute("data-status", "connected");

      const oauthReconnect = connectRequests.find(
        (request) =>
          request.body.serverName === "oauth-e2e-target" &&
          request.body.intent === "reconnect"
      );
      expect(oauthReconnect).toBeTruthy();
      expectNoFrontendBearerShortcut(oauthReconnect!);
      expect(backendCredentialUses.length).toBe(
        oauthCredentialUsesBeforeReconnect + 1
      );
      expect(backendCredentialUses.at(-1)).toEqual({
        serverName: "oauth-e2e-target",
        serverUrl: fakeOAuthServer.serverUrl,
        authorization: "Bearer e2e-access-token",
      });
    } finally {
      await fakePlainServer.close();
      await fakeOAuthServer.close();
    }
  });
});
