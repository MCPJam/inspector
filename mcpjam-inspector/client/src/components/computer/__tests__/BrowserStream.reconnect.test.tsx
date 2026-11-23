/**
 * How the browser stream ends and starts again: a gone browser goes to the
 * panel, "Reconnect browser" restarts the retry budget, and a person's input
 * reaches `onInput` only while they have control.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserStream } from "../BrowserStream";

const { sockets } = vi.hoisted(() => ({ sockets: [] as EventTarget[] }));
vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    disconnect() {}
  },
}));

class FakeSocket extends EventTarget {
  static CLOSED = 3;
  readyState = 1;
  binaryType = "blob";
  constructor() {
    super();
    sockets.push(this);
  }
  close() {}
}

function closeLatest(code: number) {
  act(() => {
    sockets.at(-1)!.dispatchEvent(
      Object.assign(new Event("close"), { code, reason: "" }),
    );
  });
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function props() {
  return {
    bootId: "boot",
    mintToken: vi.fn(async () => "test-token"),
    onSessionGone: vi.fn(),
    onInput: vi.fn(),
    onViewport: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sockets.length = 0;
});

it("hands a gone browser (4404) to the panel instead of retrying", async () => {
  const p = props();
  render(<BrowserStream {...p} viewOnly={false} />);
  await settle();
  expect(sockets).toHaveLength(1);

  closeLatest(4404);
  await settle(20_000);

  expect(p.onSessionGone).toHaveBeenCalledOnce();
  expect(sockets).toHaveLength(1);
  expect(p.mintToken).toHaveBeenCalledOnce();
});

it("restarts the retry budget when a person presses Reconnect browser", async () => {
  const p = props();
  render(<BrowserStream {...p} viewOnly={false} />);
  await settle();

  // Five drops in a row are retried; the sixth gives up and offers the button.
  for (let drop = 1; drop <= 5; drop++) {
    closeLatest(1006);
    await settle(10_000);
    expect(sockets).toHaveLength(drop + 1);
  }
  closeLatest(1006);
  await settle(10_000);
  expect(sockets).toHaveLength(6);
  expect(screen.getByText("The connection to the browser dropped.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Reconnect browser" }));
  await settle();
  expect(sockets).toHaveLength(7);

  // The next drop is retried again rather than ending the stream at once.
  closeLatest(1006);
  await settle(10_000);
  expect(sockets).toHaveLength(8);
  expect(screen.queryByRole("button", { name: "Reconnect browser" })).toBeNull();
  expect(p.onSessionGone).not.toHaveBeenCalled();
});

it("reports keyboard, pointer and wheel input while in control, not while watching", async () => {
  const p = props();
  const view = render(<BrowserStream {...p} viewOnly={false} />);
  await settle();
  const pane = view.container.firstElementChild!.firstElementChild!;

  fireEvent.keyDown(pane, { key: "a" });
  fireEvent.pointerDown(pane);
  fireEvent.wheel(pane, { deltaY: 120 });
  expect(p.onInput).toHaveBeenCalledTimes(3);

  view.rerender(<BrowserStream {...p} viewOnly />);
  fireEvent.keyDown(pane, { key: "a" });
  fireEvent.pointerDown(pane);
  fireEvent.wheel(pane, { deltaY: 120 });
  expect(p.onInput).toHaveBeenCalledTimes(3);
});
