/**
 * The `events-list` probe: `events/list` on the existing connection with the
 * shared read-only helper, graded the way the Events runner grades its two
 * read-only checks. Like the UI and skill reads, it does not run on a local
 * 2025-era connection (`input-guard.ts`): an `elicitation/create` the server
 * sent while answering it would reach the user.
 */
import {
  assertBackgroundSafeCheck,
  readServerEventTypes,
  type CheckStatus,
  type ConformanceCheckRef,
  type MCPClientManager,
  type ProbeSummary,
} from "@mcpjam/sdk";
import { serverAnswered } from "./connection-reads.js";
import { probeSummary, unranProbe } from "./shared.js";

export const LOCAL_LEGACY_EVENTS_SKIPPED =
  "MCPJam does not list events in the background on this connection, since the server could ask you for input. Run checks to list them.";

export interface EventsProbeDependencies {
  readEventTypes?: typeof readServerEventTypes;
}

/**
 * `events/list` on the connection when the server declared events. The two
 * read-only Events checks are graded the way the Events runner grades them.
 */
export async function runEventsProbe(
  input: {
    manager: Pick<MCPClientManager, "getEventsSupport" | "listServerEvents">;
    managerKey: string;
    /** `ProbeInputGuard.readsAllowed`: false on a local 2025-era connection. */
    readsAllowed: boolean;
    signal: AbortSignal;
    now: () => number;
  },
  dependencies: EventsProbeDependencies = {},
): Promise<ProbeSummary<"events-list">> {
  let support: ReturnType<MCPClientManager["getEventsSupport"]> | undefined;
  try {
    support = input.manager.getEventsSupport(input.managerKey);
  } catch {
    // A manager that cannot report support has not observed the handshake.
    support = undefined;
  }
  if (!support?.handshakeObserved) {
    return unranProbe(
      "events-list",
      "skipped",
      input.now(),
      "The connection's handshake was not observed, so events support is unknown.",
    );
  }
  if (!support.declared) {
    return unranProbe(
      "events-list",
      "not-applicable",
      input.now(),
      "The server does not declare events.",
    );
  }
  const checks: Partial<Record<ConformanceCheckRef, CheckStatus>> = {};
  const grade = (ref: ConformanceCheckRef, status: CheckStatus) => {
    assertBackgroundSafeCheck(ref);
    checks[ref] = status;
  };
  grade("events:events-capability-declared", "passed");
  if (!input.readsAllowed) {
    return probeSummary("events-list", {
      status: "skipped",
      coverage: "not-captured",
      at: input.now(),
      detail: LOCAL_LEGACY_EVENTS_SKIPPED,
      checks,
    });
  }
  // The signal stops the page walk at the budget, so no later page runs on
  // (or reconnects) a connection the runner has let go.
  const read = await (dependencies.readEventTypes ?? readServerEventTypes)(
    input.manager,
    input.managerKey,
    { signal: input.signal },
  );
  const at = input.now();
  if (read.status === "failed") {
    // Only an error answer or an invalid result fails the shape check. A
    // timeout, a closed connection or the budget says nothing about the
    // server.
    const answered = !input.signal.aborted && serverAnswered(read.error);
    if (answered) grade("events:events-list-shape", "failed");
    return probeSummary("events-list", {
      status: answered ? "failed" : "abandoned",
      coverage: "not-captured",
      at,
      detail: answered
        ? "events/list answered with an error."
        : "events/list did not answer.",
      values: { listed: false },
      checks,
    });
  }
  grade("events:events-list-shape", "passed");
  return probeSummary("events-list", {
    status: "ok",
    coverage: read.truncated ? "partial" : "complete",
    at,
    values: {
      listed: true,
      eventCount: read.summary.eventCount,
      deliveryModes: read.summary.deliveryModes,
    },
    checks,
  });
}
