import type {
  EventsFeedEntryView,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { renderPlaygroundEventTurn } from "@/shared/event-turn-parts";
import {
  eventAtTurnFromFeedEntry,
  type EventAtTurn,
} from "@/shared/event-at-turn";
import { renderUserContextText } from "@/shared/user-context-message";

export interface EventBinding {
  id: string;
  subscriptionId: string;
  logicalId: string;
  serverName: string;
  eventName: string;
  instructions: string;
  enabled: boolean;
  afterSeq: number;
  agentScope: string;
  /** `mode` gives a test event the subscription's delivery mode. */
  subscription?: Pick<EventsSubscriptionView, "desiredState" | "observedState"> &
    Partial<Pick<EventsSubscriptionView, "mode">>;
}

function acceptsEvents(binding: EventBinding): boolean {
  const subscription = binding.subscription;
  return (
    !subscription ||
    (subscription.desiredState === "active" &&
      !["removing", "removed", "terminated"].includes(
        subscription.observedState,
      ))
  );
}

export interface EventAgent {
  scope: string;
  blockedReason: string | null;
  /** `event` is what the turn records about the occurrence that started it. */
  send: (
    text: string,
    isCurrent: () => boolean,
    event?: EventAtTurn,
  ) => Promise<boolean>;
}

/** What became of one occurrence. A skipped one never reached the agent. */
export interface EventOutcome {
  status: "sent" | "skipped" | "failed";
  message: string;
}

/**
 * User-authored instructions and received data have distinct, visible roles.
 * The event context header makes the chat show the turn as an event card, not
 * as a message the user typed, both live and after the chat is reopened.
 */
export function eventTurn(
  binding: EventBinding,
  entry: EventsFeedEntryView,
): string {
  return renderUserContextText({
    kind: "event",
    subject: binding.eventName,
    body: renderPlaygroundEventTurn({
      eventName: binding.eventName,
      serverName: binding.serverName,
      instructions: binding.instructions,
      event: entry,
    }),
  });
}

/** One open Playground owns this dispatcher. It never creates hosted agent jobs. */
export function createEventDispatcher(options: {
  binding: (id: string) => EventBinding | undefined;
  agent: () => EventAgent | null;
  connected: (binding: EventBinding) => boolean;
  /** A new occurrence reached this binding, before it is sent or skipped. */
  received: (id: string, entry: EventsFeedEntryView) => void;
  /** What became of that occurrence. */
  result: (
    id: string,
    entry: EventsFeedEntryView,
    outcome: EventOutcome,
  ) => void;
}) {
  let disposed = false;
  let lifecycle = 0;
  let inFlight = false;
  const seen = new Set<string>();
  const revisions = new Map<string, number>();
  return {
    activate() {
      disposed = false;
    },
    invalidate(id: string) {
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
    },
    dispose() {
      disposed = true;
      lifecycle += 1;
    },
    async dispatch(
      id: string,
      entry: EventsFeedEntryView,
      localTest = false,
    ): Promise<boolean> {
      const binding = options.binding(id);
      if (
        disposed ||
        !binding?.enabled ||
        !acceptsEvents(binding) ||
        entry.kind !== "event" ||
        entry.quarantined ||
        entry.idConflict ||
        entry.afterRemoval ||
        entry.logicalSubscriptionId !== binding.logicalId ||
        entry.name !== binding.eventName ||
        (!localTest && entry.seq <= binding.afterSeq)
      )
        return false;
      const key = JSON.stringify([
        id,
        entry.namespace,
        entry.eventId ?? entry.seq,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      // Bounded replay guard. The feed separately deduplicates sequence numbers.
      if (seen.size > 5000) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      options.received(id, entry);
      const agent = options.agent();
      const blocked =
        agent && agent.scope !== binding.agentScope
          ? "Agent or conversation changed. Resume this event to connect it here."
          : !options.connected(binding)
            ? "Occurrence skipped. Reconnect the server, then use Trigger event to test with new event data."
            : inFlight || agent?.blockedReason
              ? (agent?.blockedReason ??
                "Occurrence skipped while the agent was busy. When the turn finishes, use Trigger event to test with new event data.")
              : !agent
                ? "Occurrence skipped. Open an agent conversation, then use Trigger event to test with new event data."
                : null;
      if (blocked || !agent) {
        options.result(id, entry, {
          status: "skipped",
          message: blocked ?? "Open an agent conversation to run this event.",
        });
        return false;
      }
      const revision = revisions.get(id) ?? 0;
      const generation = lifecycle;
      const isCurrent = () => {
        const latest = options.binding(id);
        return (
          !disposed &&
          lifecycle === generation &&
          latest?.enabled === true &&
          acceptsEvents(latest) &&
          (revisions.get(id) ?? 0) === revision &&
          options.connected(binding) &&
          options.agent()?.scope === agent.scope
        );
      };
      inFlight = true;
      try {
        const sent = await agent.send(
          eventTurn(binding, entry),
          isCurrent,
          eventAtTurnFromFeedEntry(entry, binding.subscription?.mode),
        );
        if (!disposed)
          options.result(
            id,
            entry,
            sent
              ? { status: "sent", message: "Event sent to agent" }
              : {
                  status: "failed",
                  message:
                    "Event data was not sent. Check the conversation, then use Trigger event to start a new test.",
                },
          );
        return sent;
      } catch (error) {
        if (!disposed)
          options.result(id, entry, {
            status: "failed",
            message:
              error instanceof Error
                ? error.message
                : "Couldn't send event data to the agent. Try again.",
          });
        return false;
      } finally {
        inFlight = false;
      }
    },
  };
}
