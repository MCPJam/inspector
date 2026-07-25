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
    readMock.mockResolvedValueOnce({
      entries: [
        entry("a", "srv-1", 10, { message: { m: "from-B" } }),
        entry("b", "srv-1", 10, {
          direction: "receive",
          message: { m: "from-B-2" },
        }),
      ],
      cursors: [{ serverId: "srv-1", sinceMs: 10 }],
    });
    const collector = createHostedRpcLogCollector({});
    const stop = startCrossInstanceRpcLogPoll(["srv-1"], collector);

    await vi.advanceTimersByTimeAsync(1000);
    stop();

    expect(collector.logs.map((l) => (l.message as { m: string }).m)).toEqual([
      "from-B",
      "from-B-2",
    ]);
    // The first poll uses a per-server turn-start cursor.
    expect(readMock).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: [{ serverId: "srv-1", sinceMs: expect.any(Number) }],
      })
    );
  });

  it("dedups on sink row id across overlapping polls (same-ms batch can't double-deliver)", async () => {
    // A batch write stamps one createdAt; the cursor advances by createdAt with
    // `>=`, so the next poll re-sees id "a" — it must NOT be delivered twice.
    readMock
      .mockResolvedValueOnce({
        entries: [entry("a", "srv-1", 10)],
        cursors: [{ serverId: "srv-1", sinceMs: 10 }],
      })
      .mockResolvedValueOnce({
        entries: [entry("a", "srv-1", 10), entry("c", "srv-1", 10)],
        cursors: [{ serverId: "srv-1", sinceMs: 10 }],
      });
    const collector = createHostedRpcLogCollector({});
    const stop = startCrossInstanceRpcLogPoll(["srv-1"], collector);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    stop();

    expect(collector.logs.map((l) => (l.message as { id: string }).id)).toEqual(
      ["a", "c"]
    );
  });

  it("adopts the sink's per-server cursors instead of deriving them from delivered frames", async () => {
    // The starvation case: a server whose scan window is full of OUR OWN
    // instance's rows delivers nothing, but the sink still advanced its cursor.
    // If the poller derived the cursor from delivered frames it would re-ask
    // from the turn-start cursor forever and never reach the frame behind them.
    readMock
      .mockResolvedValueOnce({
        entries: [],
        cursors: [{ serverId: "srv-1", sinceMs: 5000 }],
      })
      .mockResolvedValueOnce({
        entries: [entry("late", "srv-1", 6000, { message: { m: "from-B" } })],
        cursors: [{ serverId: "srv-1", sinceMs: 6000 }],
      });
    const collector = createHostedRpcLogCollector({});
    const stop = startCrossInstanceRpcLogPoll(["srv-1"], collector);

    await vi.advanceTimersByTimeAsync(1000);
    // The second poll must carry the ADVANCED cursor, not the turn-start one.
    await vi.advanceTimersByTimeAsync(1000);
    stop();

    expect(readMock).toHaveBeenNthCalledWith(2, {
      servers: [{ serverId: "srv-1", sinceMs: 5000 }],
    });
    expect(collector.logs.map((l) => (l.message as { m: string }).m)).toEqual([
      "from-B",
    ]);
  });

  it("holds cursors when a poll fails, so frames are re-read rather than skipped", async () => {
    readMock
      .mockResolvedValueOnce({
        entries: [],
        cursors: [{ serverId: "srv-1", sinceMs: 5000 }],
      })
      .mockRejectedValueOnce(new Error("convex down"))
      .mockResolvedValueOnce({ entries: [], cursors: [] });
    const collector = createHostedRpcLogCollector({});
    const stop = startCrossInstanceRpcLogPoll(["srv-1"], collector);

    await vi.advanceTimersByTimeAsync(3000);
    stop();

    // The poll after the failure re-asks from the last GOOD cursor.
    expect(readMock).toHaveBeenNthCalledWith(3, {
      servers: [{ serverId: "srv-1", sinceMs: 5000 }],
    });
  });

  it("stops polling after teardown", async () => {
    readMock.mockResolvedValue({ entries: [], cursors: [] });
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
