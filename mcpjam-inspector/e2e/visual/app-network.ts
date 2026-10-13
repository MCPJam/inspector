import { renderSandboxProxyHtml } from "../../server/routes/apps/mcp-apps/sandbox-proxy-html";
import type { BrowserContext, Route, WebSocketRoute } from "@playwright/test";
import { FIXED_TIME, queries, responses } from "./app-data";

const ORIGIN = "http://127.0.0.1:6289";
type Message = {
  type: string;
  baseVersion: number;
  newVersion: number;
  requestId: number;
  udfPath: string;
  modifications: { type: string; queryId: number; udfPath: string }[];
};

export type AppFixture = {
  queries: Record<string, unknown>;
  responses: Record<string, unknown>;
  mutations?: Record<string, unknown>;
  signedIn?: boolean;
  statuses?: Record<string, number>;
  convexOrigin?: string;
  localAccessToken?: string;
  seedOnboarding?: boolean;
};

function serveConvex(
  socket: WebSocketRoute,
  failures: string[],
  fixture: AppFixture,
) {
  let version = { querySet: 0, identity: 0, ts: "AAAAAAAAAAA=" };
  function transition(next: typeof version, modifications: unknown[] = []) {
    socket.send(
      JSON.stringify({
        type: "Transition",
        startVersion: version,
        endVersion: next,
        modifications,
      }),
    );
    version = next;
  }
  socket.onMessage((raw) => {
    const message: Message = JSON.parse(raw.toString());
    if (message.type === "Connect" || message.type === "Event") return;
    if (message.type === "Authenticate") {
      transition({ ...version, identity: message.baseVersion + 1 });
    } else if (message.type === "ModifyQuerySet") {
      const modifications = message.modifications.map((query) => {
        if (query.type === "Remove")
          return { type: "QueryRemoved", queryId: query.queryId };
        if (!Object.hasOwn(fixture.queries, query.udfPath))
          failures.push(`Query: ${query.udfPath}`);
        return {
          type: "QueryUpdated",
          queryId: query.queryId,
          value: fixture.queries[query.udfPath] ?? null,
          logLines: [],
          journal: null,
        };
      });
      transition({ ...version, querySet: message.newVersion }, modifications);
    } else if (
      message.type === "Mutation" &&
      (message.udfPath === "users:ensureUser" ||
        Object.hasOwn(fixture.mutations ?? {}, message.udfPath))
    ) {
      socket.send(
        JSON.stringify({
          type: "MutationResponse",
          requestId: message.requestId,
          success: true,
          result: fixture.mutations?.[message.udfPath] ?? null,
          ts: version.ts,
          logLines: [],
        }),
      );
      transition({ ...version });
    } else {
      failures.push(`${message.type}: ${message.udfPath}`);
      socket.close();
    }
  });
}

async function serveHttp(
  route: Route,
  failures: string[],
  fixture: AppFixture,
  origin: string,
) {
  const url = new URL(route.request().url());
  if (
    url.hostname === "o4510109778378752.ingest.us.sentry.io" &&
    /^\/api\/\d+\/envelope\/$/.test(url.pathname)
  )
    return route.fulfill({ status: 204 });
  if (
    url.origin === "http://127.0.0.1:11434" &&
    route.request().method() === "GET" &&
    ["/api/version", "/api/tags"].includes(url.pathname)
  )
    return route.fulfill({
      json: url.pathname.endsWith("tags")
        ? { models: [] }
        : { version: "0.0.0" },
    });
  if (
    url.hostname === "sandbox.visual.invalid" &&
    url.pathname.endsWith("/sandbox-proxy")
  )
    return route.fulfill({
      contentType: "text/html",
      body: renderSandboxProxyHtml(),
    });
  if (url.origin === origin) {
    if (
      !fixture.signedIn &&
      url.pathname === "/user_management/authenticate" &&
      route.request().method() === "POST"
    )
      return route.fulfill({
        status: 401,
        json: {
          error: "invalid_grant",
          error_description: "Synthetic guest has no WorkOS session",
        },
      });
    if (Object.hasOwn(fixture.responses, url.pathname))
      return route.fulfill({
        status: fixture.statuses?.[url.pathname] ?? 200,
        json: fixture.responses[url.pathname],
      });
    if (
      url.pathname === "/api/mcp/subscribe" ||
      url.pathname === "/api/mcp/servers/rpc/stream"
    ) {
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": synthetic workspace\n\n",
      });
    }
    if (url.pathname.startsWith("/tlm/"))
      return route.fulfill({
        contentType: "application/javascript",
        body: "",
      });
    if (/^\/api\/\d+\/envelope\/$/.test(url.pathname))
      return route.fulfill({ status: 204 });
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/user_management/")
    )
      return route.continue();
  }
  if (
    url.origin === "https://api.github.com" &&
    url.pathname === "/repos/MCPJam/inspector"
  )
    return route.fulfill({ json: { stargazers_count: 2500 } });
  if (
    ["https://fonts.googleapis.com", "https://fonts.gstatic.com"].includes(
      url.origin,
    ) &&
    route.request().method() === "GET"
  )
    return route.continue();
  failures.push(`HTTP: ${url.origin}${url.pathname}`);
  await route.abort("blockedbyclient");
}

export async function prepareApp(
  context: BrowserContext,
  theme: string,
  overrides: Partial<AppFixture> = {},
  origin = ORIGIN,
) {
  const fixture = {
    ...overrides,
    queries: { ...queries, ...overrides.queries },
    responses: { ...responses, ...overrides.responses },
  };
  if (fixture.signedIn)
    await context.addCookies([
      { name: "workos-has-session", value: "1", url: origin },
    ]);
  const failures: string[] = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => failures.push(error.message)),
  );
  await context.addInitScript(
    ({ theme, time, localAccessToken, seedOnboarding, origin }) => {
      if (window.location.origin !== origin) return;
      localStorage.setItem("themeMode", theme);
      // Match a returning visitor; the promotional sprites animate independently
      // of the navigation and screens covered by these snapshots.
      localStorage.setItem(
        "mcpjam:platform-launch-2026-09:status",
        "dismissed",
      );
      localStorage.setItem("mcpjam.local-access", localAccessToken);
      if (!seedOnboarding) return;
      for (const key of [
        "mcp-onboarding-state",
        "mcp-first-run-server-choice-state",
      ]) {
        localStorage.setItem(
          key,
          JSON.stringify({
            status: "completed",
            completedAt: time,
            shownAt: time,
          }),
        );
      }
    },
    {
      theme,
      origin,
      time: FIXED_TIME,
      localAccessToken:
        fixture.localAccessToken ?? "visual-local-access-credential",
      seedOnboarding: fixture.seedOnboarding ?? true,
    },
  );
  await context.route("**/*", (route) =>
    serveHttp(route, failures, fixture, origin),
  );
  await context.routeWebSocket("**/*", (socket) => {
    if (
      new URL(socket.url()).origin ===
      (fixture.convexOrigin ?? "wss://visual.invalid")
    )
      return serveConvex(socket, failures, fixture);
    failures.push(`WebSocket: ${socket.url()}`);
    socket.close();
  });
  return failures;
}
