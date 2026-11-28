import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserStream } from "../BrowserStream";

const { connections } = vi.hoisted(() => ({ connections: [] as EventTarget[] }));
vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    constructor() {
      super();
      connections.push(this);
    }
    disconnect() {}
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  connections.length = 0;
});

it("reports the visible pane only during private control, without reconnecting", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", EventTarget);
  let resized: ((entries: { contentRect: { width: number; height: number } }[]) => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: typeof resized) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const props = {
    bootId: "boot",
    mintToken: vi.fn(async () => "test-token"),
    onSessionGone: vi.fn(),
    onInput: vi.fn(),
    onViewport: vi.fn(async () => {}),
  };
  const view = render(<BrowserStream {...props} viewOnly />);
  await act(async () => {});
  act(() => { connections[0]!.dispatchEvent(new Event("connect")); });
  expect(resized).toBeUndefined();
  view.rerender(<BrowserStream {...props} viewOnly={false} />);
  act(() => {
    resized?.([{ contentRect: { width: 0, height: 0 } }]);
    resized?.([{ contentRect: { width: 720, height: 600 } }]);
    resized?.([{ contentRect: { width: 1100, height: 700 } }]);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(props.onViewport.mock.calls).toEqual([[{ width: 1100, height: 700 }]]);
  act(() => { resized?.([{ contentRect: { width: 1000, height: 700 } }]); });
  view.rerender(<BrowserStream {...props} viewOnly />);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(disconnect).toHaveBeenCalledOnce();
  expect(props.onViewport).toHaveBeenCalledTimes(1);
  expect(connections).toHaveLength(1);
});
