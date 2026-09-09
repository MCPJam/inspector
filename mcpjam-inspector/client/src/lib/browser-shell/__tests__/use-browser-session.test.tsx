import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useBrowserSession,
  type BrowserSessionTransport,
} from "../use-browser-session";
import type { BrowserStateSnapshot } from "../../../../../shared/browser-session-state";

function snapshot(over: Partial<BrowserStateSnapshot> = {}): BrowserStateSnapshot {
  return {
    seq: 1,
    tabs: [{ id: "t1", url: "https://example.com/", title: "Example", loading: false }],
    activeTabId: "t1",
    canGoBack: false,
    canGoForward: false,
    control: { kind: "agent" },
    viewport: { width: 1024, height: 768, revision: 0 },
    policy: "followPane",
    ...over,
  };
}

function harness(over: Partial<BrowserSessionTransport> = {}) {
  const sizes: Array<{ width: number; height: number }> = [];
  const transport: BrowserSessionTransport = {
    readState: async () => snapshot(),
    sendCommand: async () => ({ ok: true }),
    reportViewport: async (size) => {
      sizes.push(size);
      return { ...size, revision: sizes.length };
    },
    ...over,
  };
  return { transport, sizes };
}

function mount(transport: BrowserSessionTransport) {
  return renderHook(() =>
    useBrowserSession({ transport, holderId: "pane-1", active: true }),
  );
}

describe("reporting a panel measurement", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the LAST size of a drag, not sixty of them", async () => {
    // A `ResizeObserver` fires once per animation frame while somebody drags a
    // divider. The barrier on the far side coalesces, but only requests that
    // have already been sent — each of which is an authorized fetch and, on
    // the hosted engine, a round trip against a metered box.
    const { transport, sizes } = harness();
    const { result } = mount(transport);
    for (let width = 800; width <= 860; width += 4) {
      act(() => result.current.reportViewport({ width, height: 700 }));
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // The earlier widths are places the divider passed through, not places
    // anybody left it.
    expect(sizes).toEqual([{ width: 860, height: 700 }]);
  });

  it("ignores a sub-pixel wobble", async () => {
    // CSS layout is fractional; the server rounds too, and agreeing here is
    // what makes "the size did not change" mean the same on both sides.
    const { transport, sizes } = harness();
    const { result } = mount(transport);
    act(() => result.current.reportViewport({ width: 900, height: 600 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => result.current.reportViewport({ width: 900.4, height: 599.8 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(sizes).toEqual([{ width: 900, height: 600 }]);
  });

  it("does not freeze at a stale size when a report fails", async () => {
    // A failed report that stuck would leave the session laid out for a panel
    // width nobody is looking at, with no measurement able to correct it.
    let fail = true;
    const sizes: Array<{ width: number; height: number }> = [];
    const { transport } = harness({
      reportViewport: async (size) => {
        if (fail) throw new Error("offline");
        sizes.push(size);
        return { ...size, revision: 1 };
      },
    });
    const { result } = mount(transport);
    act(() => result.current.reportViewport({ width: 900, height: 600 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fail = false;
    // The SAME size again — which the de-duplication would otherwise swallow.
    act(() => result.current.reportViewport({ width: 900, height: 600 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(sizes).toEqual([{ width: 900, height: 600 }]);
  });

  it("sends nothing after the pane goes away", async () => {
    // A timer that fired into an unmounted pane would post a measurement of a
    // panel that no longer exists.
    const { transport, sizes } = harness();
    const { result, unmount } = mount(transport);
    act(() => result.current.reportViewport({ width: 900, height: 600 }));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(sizes).toEqual([]);
  });

  it("is inert on an engine that cannot resize", async () => {
    const { transport } = harness();
    delete (transport as { reportViewport?: unknown }).reportViewport;
    const { result } = mount(transport);
    expect(() =>
      act(() => result.current.reportViewport({ width: 900, height: 600 })),
    ).not.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  });
});

describe("the session's own state", () => {
  it("reads the browser and reports itself live", async () => {
    const { transport } = harness();
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.state.connection).toBe("live"));
    expect(result.current.state.tabs).toHaveLength(1);
  });

  it("says reconnecting, not closed, when a read fails", async () => {
    // A read that lost a race is not a dead browser, and a shell that
    // announced one every time would spend its life flickering.
    const { transport } = harness({ readState: async () => null });
    const { result } = mount(transport);
    await waitFor(() =>
      expect(result.current.state.connection).toBe("reconnecting"),
    );
  });

  it("stops entirely when the pane is not on screen", async () => {
    let reads = 0;
    const { transport } = harness({
      readState: async () => {
        reads += 1;
        return snapshot();
      },
    });
    renderHook(() =>
      useBrowserSession({ transport, holderId: "pane-1", active: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(0);
  });

  it("knows when this pane is the one holding the browser", async () => {
    const { transport } = harness({
      readState: async () =>
        snapshot({ control: { kind: "human", holder: "pane-1" } }),
    });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.holding).toBe(true));
  });
});
