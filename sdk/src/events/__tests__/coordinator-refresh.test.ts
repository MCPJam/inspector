import { describe, expect, it } from "vitest";
import { EventsCoordinator } from "../coordinator.js";
import { computeRetryAt } from "../coordinator-policy.js";
import { MemoryEventInbox } from "../memory-inbox.js";
import { DRAFT_PROFILE_ID } from "../profiles.js";
import type { EventsRpcPort, SubscriptionRecord } from "../types.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Drives the coordinator the way the runtimes do: apply the patch, wait until
 * `nextActionAt`, step again for two grant lengths. Every grant lasts
 * `grantMs`, the server is unreachable for `outageMs` from the first refresh
 * attempt, and each successful response takes `responseDelayMs` to arrive.
 */
async function driveWebhook(
  outageMs: number,
  grantMs = HOUR,
  responseDelayMs = 0
) {
  let now = 0;
  let outageStart: number | undefined;
  const attempts: Array<{ at: number; ok: boolean }> = [];
  const rpc = {
    subscribe: async () => {
      if (attempts.length > 0 && outageStart === undefined) outageStart = now;
      const down = outageStart !== undefined && now < outageStart + outageMs;
      attempts.push({ at: now, ok: !down });
      if (down) throw new Error("fetch failed: ECONNRESET");
      const refreshBefore = new Date(now + grantMs).toISOString();
      now += responseDelayMs;
      return { id: "srv_sub", refreshBefore, cursor: null };
    },
  } as unknown as EventsRpcPort;
  const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
  const coordinator = new EventsCoordinator({
    rpc: async () => rpc,
    inbox: async () => inbox,
    clock: { now: () => now },
  });
  let record: SubscriptionRecord = {
    id: "esub_refresh",
    projectId: "p",
    environmentId: null,
    bindingKey: "b",
    serverId: "srv_1",
    profile: DRAFT_PROFILE_ID,
    eventName: "thing.happened",
    arguments: {},
    mode: "webhook",
    desiredState: "active",
    observedState: "pending",
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
  };
  let grantedUntil = 0;
  let lapsed = false;
  while (now < 2 * grantMs) {
    const outcome = await coordinator.step(record);
    record = {
      ...record,
      ...outcome.patch,
      nextActionAt: outcome.nextActionAt,
    };
    if (attempts[attempts.length - 1]!.ok) grantedUntil = record.refreshBefore!;
    if (outcome.nextActionAt >= grantedUntil) lapsed = true;
    now = Math.max(now, outcome.nextActionAt);
  }
  return { attempts, lapsed };
}

describe("webhook refresh before refreshBefore", () => {
  it("refreshes ahead of every grant while the server is healthy", async () => {
    const { attempts, lapsed } = await driveWebhook(0);
    expect(lapsed).toBe(false);
    expect(attempts.every((attempt) => attempt.ok)).toBe(true);
  });

  it("refreshes a grant shorter than the 1 s floor before it expires", async () => {
    const { attempts, lapsed } = await driveWebhook(0, 500);
    expect(lapsed).toBe(false);
    expect(attempts.length).toBeGreaterThan(2);
    expect(attempts.every((attempt) => attempt.ok)).toBe(true);
  });

  it("refreshes a 60 s grant twice per grant, even when responses take 2 s", async () => {
    // Before the fix the 60 s lead covered the whole grant, so each refresh
    // was due 1 s after its step started. A 2 s response made the next one
    // due on arrival: 60 subscribe calls in two grants.
    const { attempts, lapsed } = await driveWebhook(0, MINUTE, 2_000);
    expect(lapsed).toBe(false);
    expect(attempts.every((attempt) => attempt.ok)).toBe(true);
    expect(attempts.map((attempt) => attempt.at)).toEqual([
      0, 30_000, 60_000, 90_000,
    ]);
  });

  it("keeps retrying before refreshBefore through an outage that ends in time", async () => {
    // The first refresh is due at 54 min. Before the fix the backoff jumped
    // from 59.25 to 64.58 min and the 1 h grant lapsed.
    const { attempts, lapsed } = await driveWebhook(5.5 * MINUTE);
    expect(lapsed).toBe(false);
    const recovered = attempts.find((attempt, i) => i > 0 && attempt.ok)!;
    expect(recovered.at).toBeGreaterThanOrEqual(54 * MINUTE + 5.5 * MINUTE);
    expect(recovered.at).toBeLessThan(HOUR);
  });
});

describe("computeRetryAt", () => {
  it("cuts a backoff that would pass refreshBefore to half the remaining grant", () => {
    expect(
      computeRetryAt({
        now: 0,
        backoffMs: 10 * MINUTE,
        refreshBefore: 4 * MINUTE,
      })
    ).toBe(2 * MINUTE);
  });

  it("keeps the backoff when it already lands before refreshBefore", () => {
    expect(
      computeRetryAt({ now: 0, backoffMs: 5_000, refreshBefore: HOUR })
    ).toBe(5_000);
  });

  it("keeps the backoff past the deadline or for a grant with no expiry", () => {
    expect(
      computeRetryAt({ now: HOUR, backoffMs: 5_000, refreshBefore: HOUR })
    ).toBe(HOUR + 5_000);
    expect(
      computeRetryAt({ now: 0, backoffMs: 5_000, refreshBefore: null })
    ).toBe(5_000);
    expect(computeRetryAt({ now: 0, backoffMs: 5_000 })).toBe(5_000);
  });

  it("keeps every retry before refreshBefore as the deadline nears", () => {
    const refreshBefore = 4_000;
    const retries: number[] = [];
    let now = 0;
    for (;;) {
      const next = computeRetryAt({ now, backoffMs: 60_000, refreshBefore });
      if (next >= refreshBefore) break;
      retries.push(next);
      now = next;
    }
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.length).toBeLessThanOrEqual(Math.ceil(Math.log2(4_000)));
    expect(retries.every((at) => at < refreshBefore)).toBe(true);
  });

  it("keeps the backoff once under 2 ms of the grant remain", () => {
    expect(computeRetryAt({ now: 0, backoffMs: 5_000, refreshBefore: 1 })).toBe(
      5_000
    );
  });
});
