/**
 * What a hosted event run's turn records about how it started and what it ran
 * with: the event (`eventAtTurn`), the environment and the skills, the same
 * per-turn fields a Playground turn writes.
 *
 * Built from the run's FROZEN input, never from the live subscription: the
 * snapshot is what the run was scheduled with. A hosted run runs no skills
 * (C6), so its skill list is always the empty one, which records "ran with
 * none" rather than "unknown".
 */

import { buildEventAtTurn } from "@/shared/event-at-turn";
import type { PersistedTurnTrace } from "../../utils/chat-ingestion.js";
import type { EventRunInput } from "./backend-client.js";
import type { EventRunScope } from "./executor-deps.js";

export type EventRunTurnRecord = Pick<
  PersistedTurnTrace,
  "eventAtTurn" | "environmentAtTurn" | "skillsAtTurn"
>;

export function eventRunTurnRecord(args: {
  input: EventRunInput;
  triggerId: string;
  environmentRef?: EventRunScope["environmentRef"];
}): EventRunTurnRecord {
  const { event, subscription } = args.input;
  const eventAtTurn =
    typeof event.receivedAt === "number"
      ? buildEventAtTurn({
          name: event.name,
          eventId: event.eventId,
          timestamp: event.timestamp,
          receivedAt: event.receivedAt,
          origin: event.origin,
          subscriptionMode: subscription.mode,
          // The logical id, as the Events feed and the Playground name the
          // subscription; the document id only when the snapshot has no other.
          subscriptionId: subscription.logicalId ?? subscription.id,
          triggerId: args.triggerId,
        })
      : undefined;
  // An environment with an empty name is not recorded: an exported trace would
  // show it as a real environment called nothing.
  const environment = args.environmentRef;
  const environmentAtTurn =
    environment && environment.name.length > 0
      ? {
          environmentId: environment.environmentId,
          name: environment.name,
          revision: environment.revision,
        }
      : undefined;
  return {
    ...(eventAtTurn ? { eventAtTurn } : {}),
    ...(environmentAtTurn ? { environmentAtTurn } : {}),
    skillsAtTurn: [],
  };
}
