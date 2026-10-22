/**
 * Gives an empty project its default client before the client list answers.
 *
 * A project nobody has opened in the browser can hold no client a member can
 * pick, and CLI / MCP `list_clients` would answer an empty list with no way
 * for a non-admin to fix it. `projectClients:ensureProjectClient` is open to
 * every project role and idempotent, so the `/clients` list calls it with the
 * caller's own credentials when the visible list is empty. `hosts:listHosts`
 * stays a read-only query.
 */
import { ConvexError } from "convex/values";
import { ensureProjectClientMutation } from "../../../shared/ensure-project-client.js";
import { createConvexClient } from "./convex-client.js";
import {
  classifyConvexReadError,
  isMissingConvexFunction,
} from "./convex-read-errors.js";
import { redactForLog } from "./redact-log-message.js";
import { logger } from "../../utils/logger.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

/**
 * The backend declined the repair: the caller's role, a project that cannot
 * hold clients, the write budget, or a backend that predates the function.
 * Production masks a role refusal to "Server Error", so that shape counts too.
 */
function cannotRepair(error: unknown): boolean {
  if (isMissingConvexFunction(error)) return true;
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data !== "object" || data === null) return false;
    const { code, kind } = data as { code?: unknown; kind?: unknown };
    return (
      code === "FORBIDDEN" ||
      code === "VALIDATION" ||
      code === "rate_limited" ||
      kind === "forbidden"
    );
  }
  const { kind } = classifyConvexReadError(error);
  return kind === "membership" || kind === "redacted";
}

/**
 * True when it ran, so the caller reads the list again: even when this call
 * created nothing, a concurrent caller did. Runs only after the caller's list
 * read succeeded, so the project is already authorized. Any failure leaves the
 * list as it was read: that read is a correct answer, and the next one retries.
 */
export async function repairEmptyClientList(
  convexAuthToken: string,
  projectId: string,
  visibleRowCount: number,
): Promise<boolean> {
  if (visibleRowCount > 0) return false;
  try {
    await createConvexClient(convexAuthToken).mutation(
      ensureProjectClientMutation,
      { projectId },
    );
  } catch (error) {
    if (cannotRepair(error)) {
      // Axiom-only, so deploy skew or a masked crash stays visible.
      logger.warn("[v1.clients] empty client list left unrepaired", {
        detail: redactForLog(error),
      });
    } else {
      reportRouteFailure(
        "[v1.clients] empty client list repair failed",
        error,
        {
          source: "v1.clients.repairEmptyClientList",
          hop: "mcpjam_internal",
        },
      );
    }
    return false;
  }
  return true;
}
