/**
 * The paused pane: only a person wakes the desktop, and VNC input is reported
 * at most once a minute.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import {
  PausedPaneOverlay,
  idleWindowText,
} from "@/components/browser/PausedPaneOverlay";
import {
  VNC_INPUT_PING_MS,
  usePausedPane,
  useThrottledInputPing,
} from "@/components/browser/usePausedPane";

afterEach(() => {
  vi.useRealTimers();
});

describe("usePausedPane", () => {
  it("never wakes the desktop on its own, only when resumed", async () => {
    const wake = vi.fn(async () => true);
    const onAwake = vi.fn();
    const { result } = renderHook(() => usePausedPane({ wake, onAwake }));

    act(() => result.current.pause());
    expect(result.current.state).toBe("paused");
    expect(wake).not.toHaveBeenCalled();

    await act(async () => result.current.resume());
    expect(wake).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("awake");
    expect(onAwake).toHaveBeenCalledOnce();
  });

  it("goes back to paused when the wake does not land, and asks once per input", async () => {
    let finish: (woke: boolean) => void = () => {};
    const wake = vi.fn(
      () => new Promise<boolean>((resolve) => (finish = resolve)),
    );
    const onAwake = vi.fn();
    const { result } = renderHook(() => usePausedPane({ wake, onAwake }));
    act(() => result.current.pause());

    act(() => result.current.resume());
    // A second click while the first wake is in flight asks nothing more.
    act(() => result.current.resume());
    expect(result.current.state).toBe("resuming");
    expect(wake).toHaveBeenCalledOnce();

    await act(async () => finish(false));
    expect(result.current.state).toBe("paused");
    expect(onAwake).not.toHaveBeenCalled();
  });

  it("ignores input while the desktop is awake", () => {
    const wake = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePausedPane({ wake, onAwake: () => {} }),
    );
    act(() => result.current.resume());
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("useThrottledInputPing", () => {
  it("reports input at most once a minute", () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => true);
    const { result } = renderHook(() => useThrottledInputPing(send));

    result.current();
    result.current();
    vi.advanceTimersByTime(VNC_INPUT_PING_MS - 1);
    result.current();
    expect(send).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    result.current();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("PausedPaneOverlay", () => {
  it("says how long the desktop went unused when the backend says so", () => {
    expect(idleWindowText(300_000)).toBe("5 minutes");
    expect(idleWindowText(60_000)).toBe("1 minute");
    expect(idleWindowText(undefined)).toBeNull();
    expect(idleWindowText(10)).toBeNull();

    const onResume = vi.fn();
    const { rerender } = render(
      <PausedPaneOverlay
        resuming={false}
        idleMs={300_000}
        onResume={onResume}
      />,
    );
    expect(screen.getByText("Browser paused")).toBeTruthy();
    expect(
      screen.getByText(
        "No input for 5 minutes. Click or press any key to resume.",
      ),
    ).toBeTruthy();

    rerender(<PausedPaneOverlay resuming={false} onResume={onResume} />);
    expect(screen.getByText("Click or press any key to resume.")).toBeTruthy();
  });

  it("resumes on Resume or any click on the picture, and shows the wake in flight", () => {
    const onResume = vi.fn();
    const { rerender } = render(
      <PausedPaneOverlay resuming={false} onResume={onResume} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    fireEvent.pointerDown(screen.getByRole("status").parentElement!);
    expect(onResume).toHaveBeenCalled();

    onResume.mockClear();
    rerender(<PausedPaneOverlay resuming={true} onResume={onResume} />);
    expect(screen.getByText("Resuming…")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("status").parentElement!);
    expect(onResume).not.toHaveBeenCalled();
  });
});
