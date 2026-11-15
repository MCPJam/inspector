/**
 * The hosted feed's reconnect policy: viewer-token failures back off, but only
 * streams that never open push the feed onto polling (which has no way back to
 * the live stream).
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
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {}
}

const token = () => ({
  inboxId: "inbox1",
  token: "v1.payload.sig",
  expiresAt: Date.now() + 10 * 60_000,
  feedUrl: "https://hooks.test/i/inbox1/deliveries",
  streamUrl: "https://hooks.test/i/inbox1/stream",
});

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
});
