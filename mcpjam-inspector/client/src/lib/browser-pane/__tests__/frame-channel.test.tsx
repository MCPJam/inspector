/**
 * The narrow subscription frames ride instead of a product store.
 *
 * Two properties, and both are bugs when missing. `latest()` must be STABLE
 * between publishes, which is a `useSyncExternalStore` requirement rather than
 * an optimisation — a getter that allocated per call makes React see a change
 * on every render and loop forever. And a publish must reach a subscriber
 * without going through a store, which is the whole reason this exists: thirty
 * frames a second must not re-render a workspace of panels that do not draw
 * them.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createFrameChannel, useFrameChannel } from "../frame-channel";
import type { PaneFrame } from "../input";

function frame(seq: number): PaneFrame {
  return {
    data: "paint",
    deviceWidth: 1280,
    deviceHeight: 800,
    scale: 1,
    ts: seq,
    seq,
  };
}

describe("frame channel", () => {
  it("holds the newest frame and returns the same object between publishes", () => {
    const channel = createFrameChannel();
    expect(channel.latest()).toBeNull();

    const first = frame(1);
    channel.publish(first);
    expect(channel.latest()).toBe(first);
    // The SAME reference, twice: `useSyncExternalStore` compares snapshots by
    // identity and re-renders forever if this allocates.
    expect(channel.latest()).toBe(channel.latest());

    const second = frame(2);
    channel.publish(second);
    expect(channel.latest()).toBe(second);
  });

  it("notifies subscribers, and stops once they unsubscribe", () => {
    const channel = createFrameChannel();
    const listener = vi.fn();
    const unsubscribe = channel.subscribe(listener);

    channel.publish(frame(1));
    expect(listener).toHaveBeenCalledTimes(1);

    // Publishing the SAME frame again is not news. A pane that re-rendered on
    // it would be doing work for a picture that has not changed.
    const same = channel.latest()!;
    channel.publish(same);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    channel.publish(frame(2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tells the rest of the subscribers even when one throws", () => {
    const channel = createFrameChannel();
    const after = vi.fn();
    channel.subscribe(() => {
      throw new Error("a render that blew up");
    });
    channel.subscribe(after);

    // This runs inside a socket's `message` handler. A throw escaping here
    // would take the connection down over one bad subscriber.
    expect(() => channel.publish(frame(1))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("renders the current frame and re-renders only on a new one", () => {
    const channel = createFrameChannel();
    const renders = vi.fn();
    function Pane() {
      const current = useFrameChannel(channel);
      renders();
      return <span data-testid="seq">{current ? current.seq : "none"}</span>;
    }

    render(<Pane />);
    expect(screen.getByTestId("seq")).toHaveTextContent("none");
    const mounted = renders.mock.calls.length;

    act(() => channel.publish(frame(7)));
    expect(screen.getByTestId("seq")).toHaveTextContent("7");
    expect(renders.mock.calls.length).toBeGreaterThan(mounted);

    const settled = renders.mock.calls.length;
    act(() => channel.publish(channel.latest()!));
    expect(renders.mock.calls.length).toBe(settled);
  });

  it("clears to null, which is how a pane is told there is nothing to draw", () => {
    const channel = createFrameChannel();
    channel.publish(frame(1));
    channel.publish(null);
    // The bitmap inside belongs to the connection that decoded it. This only
    // stops pointing at it — releasing is the connection's job, and doing it
    // here would race the thing that owns it.
    expect(channel.latest()).toBeNull();
  });
});
