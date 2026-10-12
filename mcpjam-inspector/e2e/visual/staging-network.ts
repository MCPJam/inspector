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
            url.pathname.startsWith("/cdn-cgi/challenge-platform/") ||
            (url.pathname === "/api/web/swarm/funding-preview" &&
              isSponsorshipAllowanceRead(request.postData())))
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
      const frame = raw.toString();
      const refusal = refuseWithheldWrite(frame);
      if (refusal) socket.send(refusal);
      else if (!permitsConvexFrame(frame)) {
        rejected.push(`Convex ${describeConvexFrame(frame)}`);
        socket.close();
      } else server.send(raw);
    });
  });
}

export const SYNTHETIC_ROLE = "Automated visual regression testing";

/**
 * The sidebar credits row reads the user's sponsored swarm allowance on every
 * signed-in load (hooks/use-swarm-sponsorship-allowance.ts) as a funding
 * preview with no runs. The backend resolves the caller (the same idempotent
 * user upsert as users:ensureUser) and answers with one query: it spends and
 * reserves nothing. Only that exact empty body passes; a preview that names
 * runs comes from the swarm wizard, which this check never opens.
 */
export function isSponsorshipAllowanceRead(body: string | null): boolean {
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    return (
      !!parsed &&
      typeof parsed === "object" &&
      Object.keys(parsed).sort().join() === "projectId,runs" &&
      "projectId" in parsed &&
      typeof parsed.projectId === "string" &&
      "runs" in parsed &&
      Array.isArray(parsed.runs) &&
      parsed.runs.length === 0
    );
  } catch {
    return false;
  }
}

// The synthetic user is a bot, so it declines analytics the way posthog-js
// stores a declined consent. The app honors that for PostHog and for its own
// launch beacon (lib/launch-analytics.ts), which otherwise POSTs
// /tlm/launch-engagement when the launch card renders. The token is the public
// project key in client/src/lib/PosthogUtils.ts.
export const ANALYTICS_CONSENT_KEY =
  "__ph_opt_in_out_phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";

export async function declineStagingAnalytics(context: BrowserContext) {
  await context.addInitScript(
    ({ origin, key }) => {
      if (window.location.origin !== origin) return;
      try {
        window.localStorage.setItem(key, "0");
      } catch {
        // Storage can be unavailable; the network guard still blocks the beacon.
      }
    },
    { origin: "https://staging.mcpjam.com", key: ANALYTICS_CONSENT_KEY },
  );
}

/**
 * The home page's "What's new" row stamps when the user first saw it
 * (productUpdates:initializeIfNeeded, components/home/ProductUpdatesRow.tsx) on
 * every signed-in mount. That is a write, so the policy never allows it. The
 * guard withholds it instead: it answers the page with a failed mutation and
 * never forwards the frame, so staging is not written and no write is left in
 * flight to hold up the reload. The app already treats that failure as
 * non-fatal. Only the exact no-argument call is withheld.
 */
export function refuseWithheldWrite(raw: string): string | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "Mutation" ||
    !("udfPath" in message) ||
    message.udfPath !== "productUpdates:initializeIfNeeded" ||
    !("requestId" in message) ||
    typeof message.requestId !== "number" ||
    !("args" in message) ||
    JSON.stringify(message.args) !== "[{}]" ||
    "componentPath" in message
  )
    return null;
  return JSON.stringify({
    type: "MutationResponse",
    requestId: message.requestId,
    success: false,
    result: "Withheld by the staging visual check",
    logLines: [],
  });
}

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
