import { MemoryEventInbox } from "../src/events/memory-inbox.js";
import {
  runEventsLifecycleSuite,
  withInjectedBackpressure,
} from "./support/events-lifecycle-suite.js";

runEventsLifecycleSuite({
  name: "local adapter (MemoryEventInbox)",
  async makeInbox(clock) {
    const memory = new MemoryEventInbox({
      publicOrigin: "https://hooks.test",
      clock,
    });
    const wrapped = withInjectedBackpressure(memory);
    return {
      inbox: wrapped.inbox,
      applyBackpressure: wrapped.applyBackpressure,
      async entries(logicalSubscriptionId) {
        return memory
          .read(0, 1000)
          .entries.filter((entry) => entry.logicalSubscriptionId === logicalSubscriptionId)
          .map((entry) => ({
            kind: entry.kind,
            ...(entry.eventId !== undefined ? { eventId: entry.eventId } : {}),
            cursor: entry.cursor,
          }));
      },
    };
  },
});
