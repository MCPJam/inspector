/**
 * The refusal of a round whose change no client of the climb reads (product
 * decision 19). A round that changes only a field every environment's client
 * ignores would run and measure nothing, so it is refused before any run, with
 * the reason and which client would read it. Only a fact the table of what each
 * client reads marks as ignored counts; an unconfirmed row never refuses.
 */
import type { ConvexHttpClient } from "convex/browser";
import { refuseUnreadChange } from "@mcpjam/sdk/climbs";
import { diffMockDefinitions } from "@mcpjam/sdk/mocks";
import type { PlatformClimb } from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { clientsOfClimb } from "./clients.js";
import { definitionOf } from "./round-changes.js";

export async function refuseIfNoClientReads(
  convex: ConvexHttpClient,
  climb: PlatformClimb,
  serverId: string,
  serverVersion: string | undefined,
): Promise<void> {
  const candidate = await definitionOf(convex, serverId, serverVersion);
  // A server that is not a mock has no definition to read: it runs as it is.
  if (!candidate) return;
  const best = climb.best ? await definitionOf(convex, climb.best.serverId, climb.best.serverVersion) : undefined;
  const changes = diffMockDefinitions(best ?? {}, candidate);
  const refusal = refuseUnreadChange(changes, await clientsOfClimb(convex, climb));
  if (!refusal) return;
  throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, refusal.message, {
    code: "CLIMB_CHANGE_NOT_READ",
    unread: refusal.unread,
  });
}
