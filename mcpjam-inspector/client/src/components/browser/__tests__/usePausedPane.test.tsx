/**
 * The paused pane: only a person wakes the desktop, a paused pane on screen
 * notices when something else woke it, and VNC input is reported at most once
 * a minute.
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
  PausablePane,
  PausedPaneOverlay,
  idleWindowText,
} from "@/components/browser/PausedPaneOverlay";
import {
  PAUSED_CHECK_MS,
  VNC_INPUT_PING_MS,
  usePausedPane,
  useThrottledInputPing,
} from "@/components/browser/usePausedPane";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const FRAME = {
  data: "Zm9v",
  deviceWidth: 1024,
  deviceHeight: 768,
  scale: 1,
  ts: 1,
  seq: 1,
};

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

  it("clears when the desktop serves again, and a late wake answer changes nothing", async () => {
    let finish: (woke: boolean) => void = () => {};
    const wake = vi.fn(
      () => new Promise<boolean>((resolve) => (finish = resolve)),
    );
    const onAwake = vi.fn();
    const { result } = renderHook(() => usePausedPane({ wake, onAwake }));

    act(() => result.current.pause());
    act(() => result.current.clear());
    expect(result.current.state).toBe("awake");

    act(() => result.current.pause());
    act(() => result.current.resume());
    // A frame shows the desktop serving before the wake answers.
    act(() => result.current.clear());
    await act(async () => finish(false));
    expect(result.current.state).toBe("awake");
    expect(onAwake).not.toHaveBeenCalled();
  });

  it("asks whether something else woke the desktop, and reopens without waking it", async () => {
    vi.useFakeTimers();
    let serving = false;
    const isServing = vi.fn(async () => serving);
    const wake = vi.fn(async () => true);
    const onAwake = vi.fn();
    const { result } = renderHook(() =>
      usePausedPane({ wake, onAwake, isServing, visible: true }),
    );

    // Awake, nothing to ask.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSED_CHECK_MS * 3);
    });
    expect(isServing).not.toHaveBeenCalled();

    act(() => result.current.pause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSED_CHECK_MS);
    });
    expect(isServing).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("paused");

    serving = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSED_CHECK_MS);
    });
    expect(result.current.state).toBe("awake");
    expect(onAwake).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
  });

  it("asks nothing while hidden, or while a person's wake is in flight", async () => {
    vi.useFakeTimers();
    const isServing = vi.fn(async () => false);
    const wake = vi.fn(() => new Promise<boolean>(() => {}));
    const { result, rerender } = renderHook(
      ({ visible }) =>
        usePausedPane({ wake, onAwake: () => {}, isServing, visible }),
      { initialProps: { visible: false } },
    );
    act(() => result.current.pause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSED_CHECK_MS * 3);
    });
    expect(isServing).not.toHaveBeenCalled();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    rerender({ visible: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSED_CHECK_MS * 3);
    });
    expect(isServing).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    act(() => result.current.resume());
    expect(result.current.state).toBe("resuming");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSED_CHECK_MS * 3);
    });
    expect(isServing).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledOnce();
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

  it("draws the last picture under the paused state", () => {
    render(
      <PausedPaneOverlay resuming={false} picture={FRAME} onResume={vi.fn()} />,
    );
    expect(
      screen
        .getByTestId("paused-pane-picture")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("data:image/jpeg;base64,Zm9v");
  });
});

describe("PausablePane", () => {
  function renderPane(state: "awake" | "paused" | "resuming") {
    const onResume = vi.fn();
    const onInput = vi.fn();
    const onPaneKey = vi.fn();
    render(
      <PausablePane state={state} onResume={onResume} onInput={onInput}>
        <div data-testid="pane" tabIndex={0} onKeyDown={onPaneKey} />
      </PausablePane>,
    );
    return { onResume, onInput, onPaneKey };
  }

  it("passes input through while awake, and reports it", () => {
    const { onResume, onInput, onPaneKey } = renderPane("awake");
    fireEvent.keyDown(screen.getByTestId("pane"), { key: "a" });
    fireEvent.pointerDown(screen.getByTestId("pane"));
    expect(onPaneKey).toHaveBeenCalledOnce();
    expect(onInput).toHaveBeenCalledTimes(2);
    expect(onResume).not.toHaveBeenCalled();
    expect(screen.queryByText("Browser paused")).toBeNull();
  });

  it("turns a key press into the wake while paused, and keeps it from the pane", () => {
    const { onResume, onInput, onPaneKey } = renderPane("paused");
    expect(screen.getByText("Browser paused")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("pane"), { key: "a" });
    expect(onResume).toHaveBeenCalledOnce();
    expect(onPaneKey).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
  });
});
