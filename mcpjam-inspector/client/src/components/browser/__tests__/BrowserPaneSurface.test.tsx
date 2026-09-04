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
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  BrowserPaneSurface,
  type BrowserPaneSurfaceProps,
} from "../BrowserPaneSurface";

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
    holding: true,
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
    renderSurface({ control: "agent", holding: false });
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

describe("the pane surface — a hold that ends", () => {
  it("FORGETS a drag when the lease goes, so the next press is not its tail", () => {
    // A revoked hold cannot send the release — the server would refuse it —
    // so the drag is only forgotten. What that stops: the next pointer move
    // after taking control again being CLAMPED onto the page as though the
    // person were still dragging, which lands input on a letterbox bar the
    // page has nothing at.
    const { onInput, view } = renderSurface({ holding: true });
    fireEvent.mouseDown(image(), { clientX: 10, clientY: 10, button: 0 });
    expect(onInput).toHaveBeenCalledTimes(1);

    view.rerender(
      <BrowserPaneSurface
        frame={FRAME}
        holding={false}
        control="other"
        onInput={onInput}
      />,
    );
    view.rerender(
      <BrowserPaneSurface
        frame={FRAME}
        holding
        control="you"
        onInput={onInput}
      />,
    );

    onInput.mockClear();
    // Off the page entirely. Mid-drag this would be clamped and delivered;
    // with the drag forgotten it is dropped, which is what a click nobody
    // aimed deserves.
    fireEvent.mouseMove(image(), { clientX: 5_000, clientY: 5_000 });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("sends nothing at all once the hold is gone", () => {
    const { onInput } = renderSurface({ holding: false, control: "other" });
    fireEvent.mouseMove(image(), { clientX: 100, clientY: 100 });
    fireEvent.mouseDown(image(), { clientX: 100, clientY: 100 });
    fireEvent.wheel(image(), { clientX: 100, clientY: 100, deltaY: 20 });
    expect(onInput).not.toHaveBeenCalled();
  });
});
