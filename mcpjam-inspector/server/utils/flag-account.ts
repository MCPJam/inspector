import { createConvexClient } from "../routes/v1/convex-client.js";
import { telemetryRecord } from "@mcpjam/sdk/internal/telemetry";
import { logger } from "./logger.js";

/** A verified bearer may supply its own account email to flag targeting only. */
export async function flagAccountEmail(token: string, subject: string): Promise<string | undefined> {
  if (!process.env.CONVEX_URL) return undefined;
  try {
    const user = telemetryRecord(await createConvexClient(token).query("users:getCurrentUser" as never, {}));
    return user.externalId === subject && typeof user.email === "string" ? user.email : undefined;
  } catch {
    // Flags remain usable by stable ID when the authenticated account service is unavailable.
    logger.debug("flags.account.unavailable");
    return undefined;
  }
}
