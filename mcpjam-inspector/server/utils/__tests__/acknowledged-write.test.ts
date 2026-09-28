/**
 * The shared "did it land?" primitive.
 *
 * Its one rule is that state is released only on a CONFIRMED acknowledgement.
 * The tests below are mostly about the distinction an exception cannot carry:
 * a failure worth repeating versus one that will fail identically forever. On
 * the evidence path the retry budget is a real agent waiting for its tool
 * result, so spending it on a permanent failure is not merely wasteful.
 */
import { describe, expect, test, vi } from "vitest";
import { writeUntilAcknowledged } from "../acknowledged-write";

const noSleep = async () => {};

describe("acknowledgement", () => {
  test("returns the value and the attempt count on first success", async () => {
    const result = await writeUntilAcknowledged(async () => ({
      status: "acknowledged" as const,
      value: { id: 7 },
    }));

    expect(result).toEqual({
      acknowledged: true,
      value: { id: 7 },
      attempts: 1,
    });
  });

  test("retries until acknowledged, and reports how many it took", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ status: "retryable", reason: "503" })
      .mockResolvedValueOnce({ status: "retryable", reason: "503" })
      .mockResolvedValue({ status: "acknowledged", value: "ok" });

    const result = await writeUntilAcknowledged(attempt, { sleep: noSleep });

    expect(result).toMatchObject({
      acknowledged: true,
      value: "ok",
      attempts: 3,
    });
  });
});

describe("giving up", () => {
  test("exhausts the budget on a retryable failure and says it gave up", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValue({ status: "retryable", reason: "still 503" });

    const result = await writeUntilAcknowledged(attempt, {
      maxAttempts: 4,
      sleep: noSleep,
    });

    expect(attempt).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      acknowledged: false,
      reason: "still 503",
      attempts: 4,
      gaveUp: true,
    });
  });

  test("stops at once on a permanent failure, and did NOT give up", async () => {
    // The distinction matters to a caller deciding whether the failure is
    // worth alerting on: there was nothing here to give up on.
    const attempt = vi
      .fn()
      .mockResolvedValue({ status: "permanent", reason: "payload_too_large" });

    const result = await writeUntilAcknowledged(attempt, {
      maxAttempts: 5,
      sleep: noSleep,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      acknowledged: false,
      reason: "payload_too_large",
      attempts: 1,
      gaveUp: false,
    });
  });
});

describe("failures that carry no verdict", () => {
  test("a thrown attempt is retryable, and never propagates", async () => {
    // An exception carries no decision about retryability — the statuses above
    // are things a caller DECIDED. And it must not propagate: on both callers
    // a throw here would be indistinguishable from the thing this write was
    // protecting also having failed.
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue({ status: "acknowledged", value: 1 });

    const result = await writeUntilAcknowledged(attempt, { sleep: noSleep });

    expect(result).toMatchObject({ acknowledged: true, attempts: 2 });
  });

  test("a persistently throwing attempt reports the last message", async () => {
    const result = await writeUntilAcknowledged(
      async () => {
        throw new Error("socket hang up");
      },
      { maxAttempts: 2, sleep: noSleep },
    );

    expect(result).toMatchObject({
      acknowledged: false,
      reason: "socket hang up",
      gaveUp: true,
    });
  });
});

describe("bounds", () => {
  test("maxAttempts of 1 means try once and report", async () => {
    // This is the browser outbox's shape: its retry cadence is the NEXT flush,
    // so a stalled backend must never hold a terminal path open.
    const attempt = vi
      .fn()
      .mockResolvedValue({ status: "retryable", reason: "not ready" });

    const result = await writeUntilAcknowledged(attempt, { maxAttempts: 1 });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ acknowledged: false, gaveUp: true });
  });

  test("waits between attempts, and not after the last one", async () => {
    const sleep = vi.fn(async () => {});
    await writeUntilAcknowledged(
      async () => ({ status: "retryable", reason: "x" }),
      { maxAttempts: 3, sleep, delayMsForAttempt: (n) => n * 100 },
    );

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });

  test("an abort stops the loop without another attempt", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort();
      return { status: "retryable" as const, reason: "x" };
    });

    const result = await writeUntilAcknowledged(attempt, {
      maxAttempts: 5,
      sleep: noSleep,
      signal: controller.signal,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ acknowledged: false, reason: "aborted" });
  });

  test("an already-aborted signal makes no attempt at all", async () => {
    const attempt = vi.fn();
    const result = await writeUntilAcknowledged(attempt, {
      signal: AbortSignal.abort(),
    });

    expect(attempt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ acknowledged: false, attempts: 0 });
  });
});
