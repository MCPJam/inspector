/**
 * Unit tests for the `mcpjam events` plumbing that the end-to-end suite
 * (`events-commands.test.ts`) cannot reach deterministically: the watch
 * session's stop reasons and teardown failure, secret redaction, the draft
 * error-code mapping, and flag parsing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  generateWebhookSecret,
  IDLE_NEXT_ACTION_AT,
  type JournalEntry,
  type StepOutcome,
  type SubscriptionRecord,
} from "@mcpjam/sdk/events";
import {
  parseListenAddress,
  redactSecrets,
  toEventsCliError,
} from "../src/lib/events-cli.js";
import { EventsWatchSession, type EventsWatchLine } from "../src/lib/events-watch.js";
import { CliError } from "../src/lib/output.js";

function record(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: "esub_test",
    projectId: "local",
    environmentId: null,
    bindingKey: "binding",
    serverId: "__cli__",
    profile: "draft@28ec35e",
    eventName: "comment.created",
    arguments: {},
    mode: "poll",
    desiredState: "active",
    observedState: "pending",
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function entry(seq: number, overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    seq,
    kind: "event",
    origin: "poll",
    namespace: "live",
    logicalSubscriptionId: "esub_test",
    eventId: `evt_${seq}`,
    name: "comment.created",
    timestamp: "2026-09-30T00:00:00.000Z",
    data: { n: seq },
    cursor: null,
    receivedAt: 0,
    deliveryKey: `k${seq}`,
    dispatch: "pending",
    ...overrides,
  };
}

/** A fake coordinator + inbox: each active step delivers the next scripted entry. */
function harness(options: {
  script: JournalEntry[];
  removal?: (record: SubscriptionRecord) => StepOutcome;
}) {
  let listener: ((entry: JournalEntry) => void) | undefined;
  const acked: number[] = [];
  const lines: EventsWatchLine[] = [];
  const statuses: string[] = [];
  const removals: SubscriptionRecord[] = [];
  const script = [...options.script];
  const deps = {
    inbox: {
      subscribe(_after: number, next: (entry: JournalEntry) => void) {
        listener = next;
        return { backlog: [], unsubscribe: () => (listener = undefined) };
      },
      ackDispatch: (seq: number) => acked.push(seq),
    },
    coordinator: {
      async step(current: SubscriptionRecord): Promise<StepOutcome> {
        if (current.desiredState === "removed") {
          removals.push(current);
          return (
            options.removal?.(current) ?? {
              patch: { observedState: "removed", settledRemovalAt: 1 },
              nextActionAt: IDLE_NEXT_ACTION_AT,
              appended: 0,
              action: "removal_settled",
            }
          );
        }
        const next = script.shift();
        if (next) listener?.(next);
        return {
          patch: { observedState: "active" },
          nextActionAt: Date.now() + 5,
          appended: next ? 1 : 0,
          action: "polled",
        };
      },
    },
    emit: (line: EventsWatchLine) => lines.push(line),
    status: (message: string) => statuses.push(message),
  };
  return { deps, acked, lines, statuses, removals };
}

test("watch session stops at --max-events, prints the envelope shape, and removes", async () => {
  const h = harness({ script: [entry(1), entry(2), entry(3)] });
  const session = new EventsWatchSession(record(), { maxEvents: 2 }, h.deps);
  const result = await session.run();
  assert.equal(result.stopReason, "max-events");
  assert.equal(result.exitCode, 0);
  assert.equal(result.events, 2);
  assert.equal(result.removed, true);
  assert.deepEqual(h.lines[0], {
    seq: 1,
    kind: "event",
    origin: "poll",
    eventId: "evt_1",
    name: "comment.created",
    timestamp: "2026-09-30T00:00:00.000Z",
    data: { n: 1 },
    cursor: null,
  });
  assert.equal(h.lines.length, 2);
  assert.deepEqual(h.acked, [1, 2], "every journal entry is acknowledged");
  assert.equal(h.removals.length, 1);
  assert.equal(h.removals[0]!.desiredState, "removed");
});

test("a terminated envelope ends the watch with exit 1 after printing it", async () => {
  const h = harness({
    script: [
      entry(1),
      entry(2, {
        kind: "terminated",
        eventId: undefined,
        name: undefined,
        timestamp: undefined,
        data: undefined,
        error: { code: -32012, message: "Forbidden" },
      }),
    ],
  });
  const result = await new EventsWatchSession(record(), {}, h.deps).run();
  assert.equal(result.stopReason, "terminated");
  assert.equal(result.exitCode, 1);
  assert.match(result.failure!.message, /terminated the subscription: Forbidden/);
  assert.deepEqual(
    h.lines.map((line) => line.kind),
    ["event", "terminated"],
  );
  assert.deepEqual(h.lines[1]!.error, { code: -32012, message: "Forbidden" });
  assert.equal(h.lines[1]!.eventId, null);
});

test("an unconfirmed unsubscribe turns a clean stop into exit 1", async () => {
  const h = harness({
    script: [entry(1)],
    removal: () => ({
      patch: { lastError: { kind: "Forbidden", message: "no", at: 0, retryable: false } },
      nextActionAt: IDLE_NEXT_ACTION_AT,
      appended: 0,
      action: "failed",
      failure: { kind: "Forbidden", message: "no", at: 0, retryable: false },
    }),
  });
  const result = await new EventsWatchSession(
    record({ mode: "webhook", callbackUrl: "https://x.test/i/a/s/b" }),
    { maxEvents: 1 },
    h.deps,
  ).run();
  assert.equal(result.stopReason, "max-events");
  assert.equal(result.removed, false);
  assert.equal(result.exitCode, 1);
  assert.ok(h.statuses.some((line) => /may remain until its TTL/.test(line)));
});

test("stop() interrupts a long wait for the next action", async () => {
  const h = harness({ script: [] });
  h.deps.coordinator.step = async (current) =>
    current.desiredState === "removed"
      ? {
          patch: { observedState: "removed", settledRemovalAt: 1 },
          nextActionAt: IDLE_NEXT_ACTION_AT,
          appended: 0,
          action: "removal_settled",
        }
      : {
          patch: { observedState: "active" },
          nextActionAt: Date.now() + 3_600_000,
          appended: 0,
          action: "polled",
        };
  const session = new EventsWatchSession(record(), {}, h.deps);
  const running = session.run();
  setTimeout(() => session.stop("signal"), 20);
  const result = await running;
  assert.equal(result.stopReason, "signal");
  assert.equal(result.exitCode, 0);
});

test("redactSecrets scrubs a secret quoted inside prose", () => {
  const secret = generateWebhookSecret();
  const scrubbed = redactSecrets(`refusing delivery.secret ${secret} (bad)`);
  assert.equal(scrubbed.includes(secret), false);
  assert.doesNotMatch(scrubbed, /whsec_/);
  assert.equal(redactSecrets("Invalid whsec_ secrets are rejected"), "Invalid whsec_ secrets are rejected");
});

test("toEventsCliError maps the draft's codes and never carries a secret", () => {
  const secret = generateWebhookSecret();
  const mapped = toEventsCliError(
    "events/subscribe",
    Object.assign(new Error(`bad secret ${secret}`), {
      code: -32015,
      data: { reason: "challenge_failed", echoed: secret },
    }),
  );
  assert.ok(mapped instanceof CliError);
  assert.equal(mapped.code, "EVENTS_CALLBACK_ENDPOINT_ERROR");
  assert.equal(mapped.exitCode, 1);
  assert.equal(JSON.stringify({ m: mapped.message, d: mapped.details }).includes(secret), false);

  const notFound = toEventsCliError(
    "events/poll",
    Object.assign(new Error("NotFound"), { code: -32011 }),
  ) as CliError;
  assert.equal(notFound.code, "EVENTS_NOT_FOUND");

  const other = new Error("socket hang up");
  assert.equal(toEventsCliError("events/poll", other), other);
});

test("parseListenAddress accepts host:port, :port and bracketed IPv6", () => {
  assert.deepEqual(parseListenAddress(undefined), { host: "127.0.0.1", port: 0 });
  assert.deepEqual(parseListenAddress("0.0.0.0:8787"), { host: "0.0.0.0", port: 8787 });
  assert.deepEqual(parseListenAddress(":9000"), { host: "127.0.0.1", port: 9000 });
  assert.deepEqual(parseListenAddress("[::1]:9000"), { host: "::1", port: 9000 });
  assert.throws(() => parseListenAddress("8787"), /host:port/);
  assert.throws(() => parseListenAddress("h:70000"), /0–65535/);
});
