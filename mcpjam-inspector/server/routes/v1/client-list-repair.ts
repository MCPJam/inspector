/**
 * Gives an empty project its default client before the client list answers.
 *
 * A project nobody has opened in the browser can hold no client a member can
 * pick, and CLI / MCP `list_clients` would answer an empty list with no way
 * for a non-admin to fix it. `projectClients:ensureProjectClient` is open to
 * every project role and idempotent, so the list route calls it with the
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
import type { WebRouteError } from "../web/errors.js";

/**
 * The caller can read the project but not repair it, or the backend predates
 * the function. Production masks a role refusal to "Server Error", so that
 * shape counts too.
 */
function cannotRepair(error: unknown): boolean {
  if (isMissingConvexFunction(error)) return true;
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data !== "object" || data === null) return false;
    const { code, kind } = data as { code?: unknown; kind?: unknown };
    return code === "FORBIDDEN" || kind === "forbidden";
  }
  const { kind } = classifyConvexReadError(error);
  return kind === "membership" || kind === "redacted";
}

/**
 * True when it ran, so the caller reads the list again: even when this call
 * created nothing, a concurrent caller did. Runs only after the caller's list
 * read succeeded, so the project is already authorized. A refusal or a
 * missing function leaves the list as it was read.
 */
export async function repairEmptyClientList(
  convexAuthToken: string,
  projectId: string,
  visibleRowCount: number,
  translateError: (error: unknown) => WebRouteError,
): Promise<boolean> {
  if (visibleRowCount > 0) return false;
  try {
    await createConvexClient(convexAuthToken).mutation(
      ensureProjectClientMutation,
      { projectId },
    );
  } catch (error) {
    if (!cannotRepair(error)) throw translateError(error);
    // Axiom-only, so deploy skew or a masked crash stays visible.
    logger.warn("[v1.clients] empty client list left unrepaired", {
      detail: redactForLog(error),
    });
    return false;
  }
  return true;
}
