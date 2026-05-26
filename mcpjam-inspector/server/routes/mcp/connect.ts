import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import {
  executeLocalServerConnect,
  parseLocalConnectRequestBody,
  respondWithLocalRouteError,
} from "../../utils/local-server-resolver.js";

const connect = new Hono();

connect.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    return c.json(
      {
        success: false,
        error: "Failed to parse request body",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      400,
    );
  }

  const parsed = parseLocalConnectRequestBody(c, body);
  if (!parsed.ok) {
    return respondWithLocalRouteError(c, parsed.error);
  }

  // First-time connects: clean up the manager entry on failure so a doomed
  // entry doesn't shadow subsequent connects under the same display name.
  return executeLocalServerConnect(c, parsed.params, { removeOnFailure: true });
});

export default connect;
