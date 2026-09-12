import { beforeAll } from "vitest";
beforeAll(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
});
/**
 * The shared pane surface.
 *
 * Most of what this component does is already pinned end to end by
 * `LocalBrowserBody.test.tsx` — a right-click arrives as a right-click, a drag
 * is released with the button it started with, nothing is sent without the
 * lease. Those are not repeated here. What IS here is the behaviour that only
 * became reachable once the surface was shared: the sentence it puts in the
 * header for each way a browser can be driven, the one placeholder it owns
 * itself, and what it forgets when a hold ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  BrowserPaneSurface,
  type BrowserPaneSurfaceProps,
} from "../BrowserPaneSurface";
import {
  BROWSER_PANE_STATS_FLAG,
  paneFrameStats,
} from "@/lib/browser-pane/frame-stats";

/** A stand-in for a decoded picture, which records being released. */
function fakeBitmap() {
  const bitmap = {
    width: 1024,
    height: 768,
    closed: false,
    close() {
      bitmap.closed = true;
    },
  };
  return bitmap as unknown as ImageBitmap & { closed: boolean };
}

const FRAME = {
  data: "Zm9v",
  deviceWidth: 1024,
  deviceHeight: 768,
  scale: 1,
  ts: 1,
  seq: 1,
};

function renderSurface(over: Partial<BrowserPaneSurfaceProps> = {}) {
  const onInput = vi.fn();
  const props: BrowserPaneSurfaceProps = {
    frame: FRAME,
    authority: { kind: "lease", holding: true },
    control: "you",
    onInput,
    ...over,
  };
  const view = render(<BrowserPaneSurface {...props} />);
  return { onInput, view };
}

/** The rendered picture, sized so a click maps 1:1 onto the page. */
function image() {
  const el = screen.getByTestId("rail-browser-frame");
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1024, height: 768 }) as DOMRect;
  return el;
}

describe("the pane surface — saying who is driving", () => {
  it("names each way the browser can be held", () => {
    for (const [control, said] of [
      ["agent", "The agent is driving"],
      ["you", "You have control"],
      ["script", "A script has control"],
      ["other", "Someone else has control"],
    ] as const) {
      const { view } = renderSurface({ control });
      expect(screen.getByText(said)).toBeTruthy();
      view.unmount();
    }
  });

  it("offers a hand-back over a take, never both", () => {
    // A pane that showed both would be offering to take a browser it already
    // has, and the two buttons post opposite lease actions.
    renderSurface({
      onTakeControl: () => {},
      onHandBack: () => {},
    });
    expect(screen.queryByText("Take control")).toBeNull();
    expect(screen.getByText("Hand back")).toBeTruthy();
  });

  it("offers nothing when the engine offers nothing", () => {
    // There may be no browser to take at all — the surface does not invent a
    // button for one.
    renderSurface({
      control: "agent",
      authority: { kind: "lease", holding: false },
    });
    expect(screen.queryByText("Take control")).toBeNull();
    expect(screen.queryByText("Hand back")).toBeNull();
  });
});

describe("the pane surface — before the first frame", () => {
  it("says it is waiting when the engine has nothing else to say", () => {
    renderSurface({ frame: null });
    expect(screen.getByText(/Waiting for the first frame/)).toBeTruthy();
    expect(screen.queryByTestId("rail-browser-frame")).toBeNull();
  });

  it("shows the engine's own state instead when there is one", () => {
    // "This machine isn't authorized" must not be replaced by a spinner that
    // implies a frame is coming.
    renderSurface({
      frame: null,
      placeholder: <span data-testid="engine-says">no browser here</span>,
    });
    expect(screen.getByTestId("engine-says")).toBeTruthy();
    expect(screen.queryByText(/Waiting for the first frame/)).toBeNull();
  });
});

describe("the pane surface — text that has no keystrokes", () => {
  /** The keyboard wrapper, which is what carries these handlers. */
  const pane = () => image().parentElement as HTMLElement;

  it("carries a PASTE as text, since the sandbox shares no clipboard", () => {
    // `Ctrl+V` forwarded as a key pair asks the PAGE to paste from a clipboard
    // it cannot see, so nothing arrived at all.
    const { onInput } = renderSurface();
    fireEvent.paste(pane(), {
      clipboardData: { getData: () => "hunter2" },
    });
    expect(onInput).toHaveBeenCalledWith([{ type: "text", text: "hunter2" }]);
  });

  it("carries a composed character, and not the keys that built it", () => {
    // Between compositionstart and compositionend the keydowns are building a
    // character rather than typing one. Forwarding them puts the raw Latin
    // keystrokes of a Japanese entry into the page and the composed text on
    // top of them.
    const { onInput } = renderSurface();
    fireEvent.compositionStart(pane());
    fireEvent.keyDown(pane(), { key: "n" });
    fireEvent.keyDown(pane(), { key: "i" });
    expect(onInput).not.toHaveBeenCalled();

    fireEvent.compositionEnd(pane(), { data: "に" });
    expect(onInput).toHaveBeenCalledWith([{ type: "text", text: "に" }]);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("pastes nothing into a browser it does not hold", () => {
    const { onInput } = renderSurface({
      authority: { kind: "lease", holding: false },
      control: "other",
    });
    fireEvent.paste(pane(), { clipboardData: { getData: () => "secret" } });
    fireEvent.compositionEnd(pane(), { data: "に" });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("leaves a keyboard user a way back to Hand back", () => {
    // Taking control moves focus into the pane and every key then goes to the
    // page — Tab included, which the page legitimately wants. Without an
    // escape a keyboard user could not reach the button that hands it back.
    renderSurface({ onHandBack: () => {} });
    const el = pane();
    el.focus();
    expect(document.activeElement).toBe(el);
    fireEvent.keyDown(el, { key: "Escape", shiftKey: true });
    expect(document.activeElement).not.toBe(el);
  });
});

describe("the pane surface — a hold that ends", () => {
  it("FORGETS a drag when the lease goes, so the next press is not its tail", () => {
    // A revoked hold cannot send the release — the server would refuse it —
    // so the drag is only forgotten. What that stops: the next pointer move
    // after taking control again being CLAMPED onto the page as though the
    // person were still dragging, which lands input on a letterbox bar the
    // page has nothing at.
    const { onInput, view } = renderSurface({
      authority: { kind: "lease", holding: true },
    });
    mouseDown(image(), { clientX: 10, clientY: 10, button: 0 });
    expect(onInput).toHaveBeenCalledTimes(1);

    view.rerender(
      <BrowserPaneSurface
        frame={FRAME}
        authority={{ kind: "lease", holding: false }}
        control="other"
        onInput={onInput}
      />,
    );
    view.rerender(
      <BrowserPaneSurface
        frame={FRAME}
        authority={{ kind: "lease", holding: true }}
        control="you"
        onInput={onInput}
      />,
    );

    onInput.mockClear();
    // Off the page entirely. Mid-drag this would be clamped and delivered;
    // with the drag forgotten it is dropped, which is what a click nobody
    // aimed deserves.
    fireEvent.pointerMove(image(), { clientX: 5_000, clientY: 5_000 });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("does not SEED a drag from a press it refused to send", () => {
    // A press while the agent is driving sends nothing either way. Recording
    // the button anyway left this pane believing a drag was in progress, so
    // the first move after taking control was clamped onto the page as the
    // continuation of a drag whose press the page never saw — a click landing
    // somewhere nobody aimed.
    const onInput = vi.fn();
    const view = render(
      <BrowserPaneSurface
        frame={FRAME}
        authority={{ kind: "lease", holding: false }}
        control="agent"
        onInput={onInput}
      />,
    );
    mouseDown(image(), { clientX: 10, clientY: 10, button: 0 });

    view.rerender(
      <BrowserPaneSurface
        frame={FRAME}
        authority={{ kind: "lease", holding: true }}
        control="you"
        onInput={onInput}
      />,
    );
    onInput.mockClear();
    // Off the picture entirely: dropped unless a drag is in flight.
    fireEvent.pointerMove(image(), { clientX: 5_000, clientY: 5_000 });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("sends nothing at all once the hold is gone", () => {
    const { onInput } = renderSurface({
      authority: { kind: "lease", holding: false },
      control: "other",
    });
    fireEvent.pointerMove(image(), { clientX: 100, clientY: 100 });
    mouseDown(image(), { clientX: 100, clientY: 100 });
    fireEvent.wheel(image(), { clientX: 100, clientY: 100, deltaY: 20 });
    expect(onInput).not.toHaveBeenCalled();
  });
});

describe("the pane surface — stats for nerds", () => {
  beforeEach(() => {
    localStorage.clear();
    paneFrameStats.resetFlagForTests();
  });
  afterEach(() => {
    localStorage.clear();
    paneFrameStats.resetFlagForTests();
  });

  it("hides the overlay by default", () => {
    renderSurface();
    expect(screen.queryByTestId("pane-stats-overlay")).toBeNull();
  });

  it("shows it when the flag is already set", () => {
    localStorage.setItem(BROWSER_PANE_STATS_FLAG, "1");
    paneFrameStats.resetFlagForTests();
    renderSurface();
    expect(screen.getByTestId("pane-stats-overlay")).toBeTruthy();
  });

  it("turning it on from the menu persists the choice", async () => {
    renderSurface();
    mouseDown(
      screen.getByTestId("pane-settings"),
      new MouseEvent("pointerdown", { bubbles: true }) as never,
    );
    fireEvent.click(screen.getByTestId("pane-settings"));
    const toggle = await screen.findByTestId("pane-stats-toggle");
    fireEvent.click(toggle);
    expect(localStorage.getItem(BROWSER_PANE_STATS_FLAG)).toBe("1");
    expect(screen.getByTestId("pane-stats-overlay")).toBeTruthy();
  });

  it("records a paint against the relay stamp, not the sandbox clock", () => {
    localStorage.setItem(BROWSER_PANE_STATS_FLAG, "1");
    paneFrameStats.resetFlagForTests();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      // The binary wire: the picture arrived decoded, so the draw — and the
      // moment it is honest to call it painted — is synchronous.
      renderSurface({
        frame: {
          ...FRAME,
          data: undefined,
          bitmap: fakeBitmap(),
          ts: 1,
          relayTs: 999_980,
          seq: 4,
        },
      });
      // The sandbox's `ts` is a million milliseconds out; a pane that used it
      // would report sixteen minutes of latency on a healthy stream.
      expect(paneFrameStats.report().captureToPaint).toMatchObject({
        n: 1,
        p50: 20,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("borrows bitmaps and leaves disposal to their producing connection", () => {
    // An `ImageBitmap` holds a decoded surface the garbage collector cannot
    // see the cost of. At 30 fps a pane that never closed them would hold a
    // second of decoded video at all times.
    const first = fakeBitmap();
    const second = fakeBitmap();
    const { view } = renderSurface({
      frame: { ...FRAME, data: undefined, bitmap: first, seq: 1 },
    });
    expect(first.closed).toBe(false);
    view.rerender(
      <BrowserPaneSurface
        frame={{ ...FRAME, data: undefined, bitmap: second, seq: 2 }}
        authority={{ kind: "lease", holding: true }}
        control="you"
        onInput={() => {}}
      />,
    );
    expect(first.closed).toBe(false);
    // The one on screen is NOT closed — the body that owns the socket closes
    // the last one, because it is the thing that knows the stream is over.
    expect(second.closed).toBe(false);
  });
});

describe("shared inspection behavior", () => {
  it("permits shared input without inventing a lease or takeover bar", () => {
    const { onInput } = renderSurface({
      authority: { kind: "shared" },
      control: "agent",
      onTakeControl: vi.fn(),
    });
    expect(screen.queryByText("Take control")).toBeNull();
    mouseDown(image(), { clientX: 10, clientY: 20, button: 0 });
    expect(onInput).toHaveBeenCalledWith([
      expect.objectContaining({ type: "mouse_down", x: 10, y: 20 }),
    ]);
  });

  it("captures a drag beyond the pane, releases on cancellation, and consumes wheel", () => {
    const { onInput } = renderSurface({ authority: { kind: "shared" } });
    const canvas = image();
    const capture = vi.fn();
    Object.defineProperty(canvas, "setPointerCapture", { value: capture });
    mouseDown(canvas, { clientX: 10, clientY: 20, button: 0 });
    expect(capture).toHaveBeenCalled();
    onInput.mockClear();
    fireEvent.pointerLeave(canvas);
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.pointerMove(canvas, { clientX: 1500, clientY: 20 });
    expect(onInput).toHaveBeenLastCalledWith([
      expect.objectContaining({ type: "mouse_move", x: 1024 }),
    ]);
    fireEvent.pointerCancel(canvas);
    expect(onInput).toHaveBeenLastCalledWith([
      expect.objectContaining({ type: "mouse_up", button: "left" }),
    ]);
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
      deltaY: 10,
    });
    canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("lets the host generate paste, sends the text once, and releases a chord on blur", () => {
    const { onInput } = renderSurface({ authority: { kind: "shared" } });
    const pane = image().parentElement!;
    pane.focus();
    fireEvent.keyDown(pane, { key: "Control", ctrlKey: true });
    const shortcut = new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    pane.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    fireEvent.paste(pane, { clipboardData: { getData: () => "hello" } });
    fireEvent.blur(pane);
    expect(onInput.mock.calls.flat(2)).toEqual([
      expect.objectContaining({ type: "key_down", key: "Control" }),
      { type: "text", text: "hello" },
      expect.objectContaining({ type: "key_up", key: "Control" }),
    ]);
  });

  it("records only the image actually drawn and ignores retired decodes", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
      frames.push(fn),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const tick = () => frames.splice(0).forEach((fn) => fn(0));
    const images: Array<{ onload: (() => void) | null; src: string }> = [];
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        src = "";
        constructor() {
          images.push(this);
        }
      },
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const onPainted = vi.fn();
    const props = {
      authority: { kind: "shared" } as const,
      control: "you" as const,
      onInput: vi.fn(),
      onPainted,
    };
    const view = render(<BrowserPaneSurface {...props} frame={FRAME} />);
    const stale = images[0].onload!;
    view.rerender(
      <BrowserPaneSurface
        {...props}
        frame={{ ...FRAME, data: "new", seq: 2 }}
      />,
    );
    stale();
    expect(drawImage).not.toHaveBeenCalled();
    tick();
    // A slow active decode still paints, then the latest pending image starts.
    expect(drawImage).toHaveBeenCalledTimes(1);
    const late = images[1].onload!;
    late();
    tick();
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(onPainted).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 2 }),
      expect.any(Number),
    );
    view.unmount();
    late();
    expect(onPainted).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

// jsdom does not generate the compatibility mouse event after a pointer event.
function mouseDown(element: Element, init?: MouseEventInit) {
  fireEvent.pointerDown(element, init);
  fireEvent.mouseDown(element, init);
}
function mouseUp(element: Element, init?: MouseEventInit) {
  fireEvent.pointerUp(element, init);
  fireEvent.mouseUp(element, init);
}

it.each([
  { down: "ƒ", up: "f", code: "KeyF", altKey: true },
  { down: "A", up: "a", code: "KeyA", ctrlKey: true, shiftKey: true },
])(
  "releases the original $down when the physical key reports $up on release",
  ({ down, up, code, ...modifiers }) => {
    const { onInput } = renderSurface({ authority: { kind: "shared" } });
    const pane = image().parentElement!;
    fireEvent.keyDown(pane, { key: down, code, ...modifiers });
    fireEvent.keyUp(pane, { key: up, code });
    fireEvent.blur(pane);
    expect(onInput.mock.calls.flat(2)).toEqual([
      expect.objectContaining({ type: "key_down", key: down, code }),
      expect.objectContaining({ type: "key_up", key: down, code }),
    ]);
  },
);
