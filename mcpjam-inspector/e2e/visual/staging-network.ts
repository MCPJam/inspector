import type { BrowserContext, Route } from "@playwright/test";

export async function guardStagingNetwork(
  context: BrowserContext,
  rejected: string[],
) {
  const origin = "https://staging.mcpjam.com";
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) {
      if (/^\/api\/(mcp|chat|sandbox|eval)(?:\/|$)/.test(url.pathname)) {
        rejected.push(url.pathname);
        return route.abort();
      }
      const headers = { ...request.headers() };
      if (
        process.env.CF_ACCESS_CLIENT_ID &&
        process.env.CF_ACCESS_CLIENT_SECRET
      ) {
        headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
        headers["CF-Access-Client-Secret"] =
          process.env.CF_ACCESS_CLIENT_SECRET;
      }
      if (
        !["GET", "HEAD"].includes(request.method()) &&
        !(
          request.method() === "POST" &&
          (url.pathname === "/user_management/authenticate" ||
            url.pathname === "/api/web/guest-session" ||
            url.pathname.startsWith("/cdn-cgi/challenge-platform/"))
        )
      ) {
        rejected.push(url.pathname);
        return route.abort();
      }
      return fulfillWithoutForwardingCredentials(route, headers);
    }
    if (
      url.hostname === "api.workos.com" ||
      url.hostname === "deep-vanilla-68-test.authkit.app"
    )
      return route.continue();
    if (
      request.method() === "GET" &&
      url.hostname === "proper-clownfish-150.convex.cloud"
    )
      return route.continue();
    return route.abort();
  });
  await context.routeWebSocket("**/*", (socket) => {
    if (
      new URL(socket.url()).hostname !== "proper-clownfish-150.convex.cloud"
    ) {
      rejected.push(`Socket origin: ${new URL(socket.url()).origin}`);
      return socket.close();
    }
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      if (!permitsConvexFrame(raw.toString())) {
        rejected.push(`Convex ${describeConvexFrame(raw.toString())}`);
        socket.close();
      } else server.send(raw);
    });
  });
}

export const SYNTHETIC_ROLE = "Automated visual regression testing";

export function permitsConvexFrame(raw: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    // Unknown wire formats must not bypass the mutation guard.
    return false;
  }
  if (!message || typeof message !== "object" || !("type" in message))
    return false;
  if (message.type === "Mutation") {
    return (
      "udfPath" in message &&
      (message.udfPath === "users:ensureUser" ||
        (message.udfPath === "users:updateOccupation" &&
          "args" in message &&
          JSON.stringify(message.args) ===
            JSON.stringify([{ occupation: SYNTHETIC_ROLE }]))) &&
      !("componentPath" in message)
    );
  }
  if (message.type === "Authenticate") {
    return (
      "tokenType" in message &&
      ["User", "None"].includes(String(message.tokenType))
    );
  }
  return ["Connect", "ModifyQuerySet", "Event"].includes(String(message.type));
}

// Names the rejected function without echoing its arguments, which can hold
// account data.
export function describeConvexFrame(raw: string): string {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return "unparseable frame";
  }
  if (!message || typeof message !== "object") return "unparseable frame";
  const type = "type" in message ? String(message.type) : "unknown";
  const udfPath = "udfPath" in message ? ` ${String(message.udfPath)}` : "";
  return `${type}${udfPath}`;
}

export async function fulfillWithoutForwardingCredentials(
  route: Route,
  headers: Record<string, string>,
) {
  // Header overrides on continue() follow redirects. Fulfill one hop so the
  // browser creates the next request without the Cloudflare credentials.
  const response = await route.fetch({ headers, maxRedirects: 0 });
  await route.fulfill({ response });
}
