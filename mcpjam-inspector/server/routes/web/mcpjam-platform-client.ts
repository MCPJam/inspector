/**
 * Route-layer factory for the workspace built-in tools' PlatformApiClient.
 *
 * The platform operation catalog (`@mcpjam/sdk/platform`) executes over the
 * public `/api/v1` — which is THIS server. The client built here
 * self-dispatches into the app's own Hono `fetch` (registered at startup,
 * see utils/self-app.ts), so an in-app tool call runs the identical
 * authorize→connect→run pipeline as an external API caller — full
 * middleware chain, v1 guest rejection, same envelopes — without a network
 * hop or a forked handler.
 *
 * The bearer is captured from the chat request and replayed per platform
 * call. Reading from the captured token after the chat route has returned
 * its streaming Response is safe — the closures hold the string, not the
 * live request.
 */
import type { Context } from "hono";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import { assertBearerToken } from "./errors.js";
import { getSelfFetch } from "../../utils/self-app.js";

// Host is never resolved (self-dispatch routes on path); the path prefix
// must match the /api/v1 mount in server/app.ts + server/index.ts.
const SELF_BASE_URL = "http://self.mcpjam.internal/api/v1";

const selfDispatchFetch: typeof fetch = async (input, init) => {
  const dispatch = getSelfFetch();
  if (!dispatch) {
    throw new Error(
      "In-process /api/v1 dispatch is not registered; workspace tools are unavailable."
    );
  }
  return dispatch(new Request(input, init));
};

export function buildMcpjamPlatformClient(c: Context): PlatformApiClient {
  const token = assertBearerToken(c);
  return new PlatformApiClient({
    baseUrl: SELF_BASE_URL,
    getAuth: () => token,
    fetch: selfDispatchFetch,
  });
}
