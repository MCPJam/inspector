/**
 * The hosted feed's reconnect policy: viewer-token failures back off, but only
 * streams that never open push the feed onto polling (which has no way back to
 * the live stream). A backlog burst is committed as one batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const mockFetchToken = vi.fn();
const mockFetchHostedFeed = vi.fn();

vi.mock("@/lib/apis/mcp-events-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchEventsViewerToken: (...args: unknown[]) => mockFetchToken(...args),
  fetchHostedEventsFeed: (...args: unknown[]) => mockFetchHostedFeed(...args),
}));

import { useEventsFeed } from "../use-events-feed";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  listeners = new Map<string, (ev: { data: string }) => void>();
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (ev: { data: string }) => void) {
    this.listeners.set(name, listener);
  }
  close() {}
}

const token = () => ({
  inboxId: "inbox1",
  token: "v1.payload.sig",
  expiresAt: Date.now() + 10 * 60_000,
  feedUrl: "https://hooks.test/i/inbox1/deliveries",
  streamUrl: "https://hooks.test/i/inbox1/stream",
});

const feedEntry = (seq: number) =>
  JSON.stringify({
    seq,
    kind: "event",
    origin: "webhook",
    namespace: "live",
    logicalSubscriptionId: "esub_1",
    slotId: null,
    eventId: `evt_${seq}`,
    name: "issue.created",
    receivedAt: 1_700_000_000_000 + seq,
    dispatchState: "acked",
    data: { seq },
  });

async function openStream(onNewEntries?: (entries: unknown[]) => void) {
  mockFetchToken.mockResolvedValue(token());
  const hook = renderHook(() =>
    useEventsFeed({ hosted: true, projectId: "p1", enabled: true, onNewEntries }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return { ...hook, stream: FakeEventSource.instances[0]! };
}

describe("useEventsFeed (hosted)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    Object.assign(globalThis, { EventSource: FakeEventSource });
    mockFetchToken.mockReset();
    mockFetchHostedFeed
      .mockReset()
      .mockResolvedValue({ entries: [], nextAfter: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the live stream after a token outage instead of falling back to polling", async () => {
    mockFetchToken
      .mockRejectedValueOnce(new Error("backend down"))
      .mockRejectedValueOnce(new Error("backend down"))
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue(token());

    const { result } = renderHook(() =>
      useEventsFeed({ hosted: true, projectId: "p1", enabled: true }),
    );

    // Three failed token fetches, each retried after its backoff.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    }

    expect(mockFetchToken).toHaveBeenCalledTimes(4);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(mockFetchHostedFeed).not.toHaveBeenCalled();
    expect(result.current.status).not.toBe("polling");
  });

  it("commits a replayed backlog as one batch, not one update per message", async () => {
    const onNewEntries = vi.fn();
    const { result, stream } = await openStream(onNewEntries);

    // The inbox replays its backlog as a burst of messages in one task.
    act(() => {
      for (let seq = 1; seq <= 120; seq += 1) {
        stream.onmessage?.({ data: feedEntry(seq) });
      }
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onNewEntries).toHaveBeenCalledTimes(1);
    expect(onNewEntries.mock.calls[0]![0]).toHaveLength(120);
    expect(result.current.entries.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    );
  });

  it("applies a dispatch update to an entry from the same burst", async () => {
    const { result, stream } = await openStream();

    act(() => {
      stream.onmessage?.({ data: feedEntry(7) });
      stream.listeners.get("dispatch")?.({
        data: JSON.stringify({ seq: 7, dispatchState: "done" }),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]!.dispatch).toBe("done");
  });
});
