import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_FLUSH_INTERVAL_MS,
  BRIDGE_RETRY_DELAY_MS,
  createAppsBridgeObserver,
  flushWhenPageHides,
  ObservationWriteRefused,
  type BridgeDelivery,
  type BridgeLogEvent,
  type BridgeObservationBatch,
} from "../apps-bridge-observer";

const TARGET = { projectId: "prj_1", serverId: "srv_1" };

function viewRequest(
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): BridgeLogEvent {
  return {
    widgetId: "call-1",
    serverId: "My Server",
    direction: "ui-to-host",
    method,
    message: { jsonrpc: "2.0", id, method, params },
  };
}

function setup(
  overrides: Partial<Parameters<typeof createAppsBridgeObserver>[0]> = {},
) {
  const batches: BridgeObservationBatch[] = [];
  let flushIds = 0;
  const observer = createAppsBridgeObserver({
    resolveServer: (key) => (key === "My Server" ? TARGET : null),
    send: async (batch) => {
      batches.push(batch);
    },
    now: () => 100,
    newFlushId: () => `flush-${++flushIds}`,
    ...overrides,
  });
  return { observer, batches };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createAppsBridgeObserver", () => {
  it("posts tallied feature ids per project server after the interval", async () => {
    const { observer, batches } = setup();
    observer.observe(viewRequest("tools/call", { name: "private" }, 1));
    observer.observe(viewRequest("tools/call", { name: "private" }, 2));
    expect(batches).toEqual([]);

    await vi.advanceTimersByTimeAsync(BRIDGE_FLUSH_INTERVAL_MS);
    expect(batches).toEqual([
      {
        ...TARGET,
        flushId: "flush-1",
        observations: [
          {
            featureId: "apps.app-tools-call",
            count: 2,
            firstSeenAt: 100,
            lastSeenAt: 100,
          },
        ],
      },
    ]);
    expect(JSON.stringify(batches)).not.toContain("private");
  });

  it("classifies a host answer by the view request it answers", async () => {
    const { observer, batches } = setup();
    observer.observe(viewRequest("ui/update-model-context", {}, 7));
    observer.observe({
      widgetId: "call-1",
      serverId: "My Server",
      direction: "host-to-ui",
      method: "result",
      message: {
        jsonrpc: "2.0",
        id: 7,
        result: { _meta: { "openai/modelContext": { updateId: "u1" } } },
      },
    });
    await observer.flush();
    expect(
      batches[0].observations.map((entry) => entry.featureId).sort(),
    ).toEqual(["apps.view-requests", "openai.model-context"]);
  });

  it("drops traffic for servers outside the current project", async () => {
    const { observer, batches } = setup();
    observer.observe({ ...viewRequest("tools/call"), serverId: "Elsewhere" });
    await observer.flush();
    expect(batches).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed post once, after a pause, with the same flushId", async () => {
    const send = vi
      .fn<(batch: BridgeObservationBatch) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const { observer } = setup({ send });
    observer.observe(viewRequest("tools/call"));
    const flushed = observer.flush();
    await vi.advanceTimersByTimeAsync(BRIDGE_RETRY_DELAY_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushed;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].flushId).toBe(send.mock.calls[1][0].flushId);
  });

  it("gives up after the retry without throwing", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const { observer } = setup({ send });
    observer.observe(viewRequest("tools/call"));
    const flushed = observer.flush();
    await vi.advanceTimersByTimeAsync(BRIDGE_RETRY_DELAY_MS);
    await expect(flushed).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx refusal once", async () => {
    const send = vi
      .fn<(batch: BridgeObservationBatch) => Promise<void>>()
      .mockRejectedValueOnce(new ObservationWriteRefused(503))
      .mockResolvedValueOnce(undefined);
    const { observer } = setup({ send });
    observer.observe(viewRequest("tools/call"));
    const flushed = observer.flush();
    await vi.advanceTimersByTimeAsync(BRIDGE_RETRY_DELAY_MS);
    await flushed;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403])(
    "drops a batch refused with %i without a retry",
    async (status) => {
      const send = vi
        .fn()
        .mockRejectedValue(new ObservationWriteRefused(status));
      const { observer } = setup({ send });
      observer.observe(viewRequest("tools/call"));
      await expect(observer.flush()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(BRIDGE_RETRY_DELAY_MS);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("flushes with keepalive when the page hides, never resending a batch", async () => {
    const send = vi
      .fn<
        (
          batch: BridgeObservationBatch,
          delivery: BridgeDelivery,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    const { observer } = setup({ send });
    const stop = flushWhenPageHides(
      () => void observer.flush({ keepalive: true }),
    );
    const hidden = vi.spyOn(document, "visibilityState", "get");
    try {
      observer.observe(viewRequest("tools/call", {}, 1));
      await vi.advanceTimersByTimeAsync(BRIDGE_FLUSH_INTERVAL_MS);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toEqual({ keepalive: false });
      // The timer already sent those tallies.
      window.dispatchEvent(new Event("pagehide"));
      expect(send).toHaveBeenCalledTimes(1);

      observer.observe(viewRequest("tools/call", {}, 2));
      hidden.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(BRIDGE_FLUSH_INTERVAL_MS);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][1]).toEqual({ keepalive: true });
      expect(send.mock.calls[1][0].flushId).not.toBe(
        send.mock.calls[0][0].flushId,
      );
    } finally {
      stop();
      hidden.mockRestore();
    }
  });

  it("ignores traffic that shows no feature", async () => {
    const { observer, batches } = setup();
    observer.observe(viewRequest("vendor/private"));
    await observer.flush();
    expect(batches).toEqual([]);
  });
});
