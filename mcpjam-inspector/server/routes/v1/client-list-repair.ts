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
import { makeFunctionReference } from "convex/server";
import { createConvexClient } from "./convex-client.js";
import type { WebRouteError } from "../web/errors.js";

const ensureProjectClient = makeFunctionReference<
  "mutation",
  { projectId: string },
  { hostId: string; created: boolean }
>("projectClients:ensureProjectClient");

/**
 * True when it ran, so the caller reads the list again: even when this call
 * created nothing, a concurrent caller did. Runs only after the caller's list
 * read succeeded, so the project is already authorized.
 */
export async function repairEmptyClientList(
  convexAuthToken: string,
  projectId: string,
  visibleRowCount: number,
  translateError: (error: unknown) => WebRouteError,
): Promise<boolean> {
  if (visibleRowCount > 0) return false;
  try {
    await createConvexClient(convexAuthToken).mutation(ensureProjectClient, {
      projectId,
    });
  } catch (error) {
    throw translateError(error);
  }
  return true;
}
