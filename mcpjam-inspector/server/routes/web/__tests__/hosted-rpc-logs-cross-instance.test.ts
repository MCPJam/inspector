import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// COMP-21: the cross-instance poller reads the shared sink; drive it with a
// controlled `readCrossInstanceRpcLogs` and assert the frames another instance
// produced reach the turn's collector (with dedup on the sink row id).
const readMock = vi.fn();
vi.mock("../../../utils/harness/harness-rpc-log-sink", () => ({
  isRpcLogSinkConfigured: () => true,
  readCrossInstanceRpcLogs: (...args: unknown[]) => readMock(...args),
}));

import {
  createHostedRpcLogCollector,
  startCrossInstanceRpcLogPoll,
} from "../hosted-rpc-logs";

beforeEach(() => {
  vi.useFakeTimers();
  readMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function entry(
  id: string,
  serverId: string,
  createdAt: number,
  extra?: Partial<{ direction: "send" | "receive"; message: unknown }>
) {
  return {
    id,
    serverId,
    direction: extra?.direction ?? ("send" as const),
    loggedAt: "t",
    message: extra?.message ?? { id },
    createdAt,
  };
}

describe("startCrossInstanceRpcLogPoll", () => {
  it("delivers frames another instance produced into the collector", async () => {
    readMock.mockResolvedValueOnce([
      entry("a", "srv-1", 10, { message: { m: "from-B" } }),
      entry("b", "srv-1", 10, {
        direction: "receive",
        message: { m: "from-B-2" },
      }),
    ]);
    const collector = createHostedRpcLogCollector({});
    const stop = startCrossInstanceRpcLogPoll(["srv-1"], collector);

    await vi.advanceTimersByTimeAsync(1000);
    stop();

    expect(collector.logs.map((l) => (l.message as { m: string }).m)).toEqual([
      "from-B",
      "from-B-2",
    ]);
    // The first poll uses the turn-start cursor; it asks for our servers.
    expect(readMock).toHaveBeenCalledWith(
      expect.objectContaining({ serverIds: ["srv-1"] })
    );
  });

  it("dedups on sink row id across overlapping polls (same-ms batch can't double-deliver)", async () => {
    // A batch write stamps one createdAt; the cursor advances by createdAt with
    // `>=`, so the next poll re-sees id "a" — it must NOT be delivered twice.
    readMock
      .mockResolvedValueOnce([entry("a", "srv-1", 10)])
      .mockResolvedValueOnce([
        entry("a", "srv-1", 10),
        entry("c", "srv-1", 10),
      ]);
    const collector = createHostedRpcLogCollector({});
    const stop = startCrossInstanceRpcLogPoll(["srv-1"], collector);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    stop();

    expect(collector.logs.map((l) => (l.message as { id: string }).id)).toEqual(
      ["a", "c"]
    );
  });

  it("stops polling after teardown", async () => {
    readMock.mockResolvedValue([]);
    const collector = createHostedRpcLogCollector({});
    const stop = startCrossInstanceRpcLogPoll(["srv-1"], collector);
    await vi.advanceTimersByTimeAsync(1000);
    const callsBefore = readMock.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(readMock.mock.calls.length).toBe(callsBefore);
  });

  it("no-ops with no servers (nothing to fan in)", async () => {
    const collector = createHostedRpcLogCollector({});
    const stop = startCrossInstanceRpcLogPoll([], collector);
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    expect(readMock).not.toHaveBeenCalled();
  });
});
