import { createRef, useRef, useState, startTransition, Suspense } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFullscreenDismissal } from "../use-fullscreen-dismissal";

afterEach(cleanup);

it("dismisses only the focused owner and waits for every input before reopening", () => {
  const tickets = new Map<
    string,
    ReturnType<ReturnType<typeof useFullscreenDismissal>["trackInput"]>
  >();
  const starters = new Map<
    string,
    () => ReturnType<ReturnType<typeof useFullscreenDismissal>["trackInput"]>
  >();
  const exits = vi.fn();
  const opens = vi.fn();
  const unchangedGuest = createRef<HTMLInputElement>();
  function Pane({ name }: { name: string }) {
    const element = useRef<HTMLDivElement>(null);
    const [owned, setOwned] = useState(true);
    const presentation = useFullscreenDismissal({
      fullscreen: true,
      enabled: true,
      canInline: false,
      unowned: !owned,
      hostInputPending: false,
      element: () => element.current,
      inline: () => {
        throw new Error("unsupported mode");
      },
      exit: () => {
        exits(name);
        setOwned(false);
      },
      open: () => {
        opens(name);
        setOwned(true);
      },
    });
    starters.set(name, () => presentation.trackInput());
    return (
      <>
        {presentation.collapsed && (
          <button disabled={presentation.pending} onClick={presentation.open}>
            Open {name}
          </button>
        )}
        <div ref={element} hidden={presentation.collapsed}>
          <input
            aria-label={name}
            ref={name === "left" ? unchangedGuest : undefined}
            defaultValue="guest draft"
          />
          <button onClick={presentation.dismiss}>Close {name}</button>
          <button
            onClick={() => {
              const ticket = presentation.trackInput();
              tickets.set(name, ticket);
              ticket.update(true);
            }}
          >
            Wait {name}
          </button>
        </div>
      </>
    );
  }
  render(
    <>
      <Pane name="left" />
      <Pane name="right" />
    </>,
  );
  const guest = unchangedGuest.current;
  screen.getByRole("button", { name: "Close left" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(exits.mock.calls).toEqual([["left"]]);
  expect(screen.getByRole("button", { name: "Close right" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open left" }));
  expect(unchangedGuest.current).toBe(guest);
  expect(guest?.value).toBe("guest draft");
  fireEvent.click(screen.getByRole("button", { name: "Wait left" }));
  expect(
    screen.getByRole("button", { name: "Open left" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("button", { name: "Close right" })).toBeTruthy();
  const second = starters.get("left")!();
  act(() => second.update(true));
  act(() => tickets.get("left")?.finish());
  expect(
    screen.getByRole("button", { name: "Open left" }).hasAttribute("disabled"),
  ).toBe(true);
  act(() => second.finish());
  // A finished ticket cannot re-arm the wait or disable reopening.
  act(() => second.update(true));
  expect(screen.getByRole("button", { name: "Open left" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Open left" }));
  expect(opens.mock.calls).toEqual([["left"], ["left"]]);
  expect(unchangedGuest.current).toBe(guest);
});

it("keeps the committed owner's callbacks when a concurrent render suspends", async () => {
  const exit = vi.fn();
  const pending = new Promise<void>(() => {});
  function Pane({ version }: { version: string }) {
    const presentation = useFullscreenDismissal({
      fullscreen: true, enabled: true, canInline: false, unowned: false,
      hostInputPending: false, element: () => null, inline: () => {},
      exit: () => exit(version), open: () => {},
    });
    if (version === "suspended") throw pending;
    return <button onClick={presentation.dismiss}>Dismiss committed App</button>;
  }
  const view = render(<Suspense fallback="loading"><Pane version="committed" /></Suspense>);
  await act(async () => { startTransition(() => {
    view.rerender(<Suspense fallback="loading"><Pane version="suspended" /></Suspense>);
  }); });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss committed App" }));
  expect(exit).toHaveBeenCalledExactlyOnceWith("committed");
});
