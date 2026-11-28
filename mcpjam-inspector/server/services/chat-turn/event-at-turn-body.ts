import { readEventAtTurn, type EventAtTurn } from "@/shared/event-at-turn";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The MCP event a Playground turn says it was started by (`body.eventAtTurn`),
 * checked at the route boundary like `body.eventTools`: a malformed one is a
 * 400 before the turn runs. A valid one comes back as a fresh record with its
 * strings clipped and any field the record does not have left behind.
 */
export function eventAtTurnFromBody(input: unknown): EventAtTurn | undefined {
  if (input === undefined || input === null) return undefined;
  const event = readEventAtTurn(input);
  if (!event) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "eventAtTurn needs a name, a receivedAt in epoch milliseconds from 0 to 8.64e15 and an origin of server, simulation or replay.",
    );
  }
  return event;
}
