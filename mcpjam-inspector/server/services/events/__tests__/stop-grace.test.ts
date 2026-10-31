/**
 * Stopping the events workers is bounded: server shutdown force-exits after
 * 5s, and an in-flight keeper step or trigger run is lease-recoverable.
 */
import { describe, expect, it } from "vitest";
import type { EventsBackendClient } from "../backend-client.js";
import { startEventsExecutor } from "../executor.js";
import { startEventsKeeper } from "../keeper.js";
import { settleWithin } from "../stop-grace.js";

const never = () => new Promise<never>(() => {});

describe("events worker stop", () => {
  it("settleWithin returns when the work settles, or when the grace runs out", async () => {
    await expect(
      settleWithin(Promise.reject(new Error("x")), 10_000),
    ).resolves.toBeUndefined();
    const started = Date.now();
    await settleWithin(never(), 20);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the keeper stops within the grace while a tick is in flight", async () => {
    const backend = {
      claimSubscriptions: never,
    } as unknown as EventsBackendClient;
    const keeper = startEventsKeeper({
      force: true,
      claimedBy: "test",
      deps: { backend },
    });
    const started = Date.now();
    await keeper.stop(20);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the executor stops within the grace while a run is in flight", async () => {
    const backend = { claimRun: never } as unknown as EventsBackendClient;
    const executor = startEventsExecutor({
      force: true,
      claimedBy: "test",
      deps: { backend },
    });
    const started = Date.now();
    await executor.stop(20);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
