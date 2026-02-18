import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StreamingPlaybackBar } from "../streaming-playback-bar";
import type { PartialHistoryEntry } from "../useToolInputStreaming";

// Mock the widget debug store
vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: vi.fn((selector: (s: any) => any) =>
    selector({
      setStreamingPlaybackActive: vi.fn(),
    }),
  ),
}));

function createHistory(count: number): PartialHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1000 + i * 100,
    elapsedFromStart: i * 100,
    input: { code: "x".repeat(i + 1) },
    isFinal: i === count - 1,
  }));
}

describe("StreamingPlaybackBar", () => {
  const defaultProps = {
    replayToPosition: vi.fn(),
    exitReplay: vi.fn(),
    isReplayActive: false,
    toolCallId: "call-1",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders all transport control buttons", () => {
    const history = createHistory(4);
    render(
      <StreamingPlaybackBar {...defaultProps} partialHistory={history} />,
    );

    expect(screen.getByLabelText("First")).toBeInTheDocument();
    expect(screen.getByLabelText("Previous")).toBeInTheDocument();
    expect(screen.getByLabelText("Play")).toBeInTheDocument();
    expect(screen.getByLabelText("Next")).toBeInTheDocument();
    expect(screen.getByLabelText("Last")).toBeInTheDocument();
    expect(screen.getByLabelText("Close playback")).toBeInTheDocument();
  });

  it("displays position label", () => {
    const history = createHistory(4);
    render(
      <StreamingPlaybackBar {...defaultProps} partialHistory={history} />,
    );

    // Initially at last position: "4/4"
    expect(screen.getByText(/4\/4/)).toBeInTheDocument();
  });

  it("Previous button calls replayToPosition with correct index", () => {
    const history = createHistory(4);
    const replayToPosition = vi.fn();
    render(
      <StreamingPlaybackBar
        {...defaultProps}
        partialHistory={history}
        replayToPosition={replayToPosition}
      />,
    );

    // First click Previous to move from position 3 to 2
    fireEvent.click(screen.getByLabelText("Previous"));

    expect(replayToPosition).toHaveBeenCalledWith(2);
  });

  it("Next button is disabled at last position", () => {
    const history = createHistory(4);
    render(
      <StreamingPlaybackBar {...defaultProps} partialHistory={history} />,
    );

    const nextButton = screen.getByLabelText("Next");
    expect(nextButton).toBeDisabled();
  });

  it("First button calls replayToPosition with 0", () => {
    const history = createHistory(4);
    const replayToPosition = vi.fn();
    render(
      <StreamingPlaybackBar
        {...defaultProps}
        partialHistory={history}
        replayToPosition={replayToPosition}
      />,
    );

    fireEvent.click(screen.getByLabelText("First"));

    expect(replayToPosition).toHaveBeenCalledWith(0);
  });

  it("First button is disabled at position 0", () => {
    const history = createHistory(4);
    const replayToPosition = vi.fn();
    render(
      <StreamingPlaybackBar
        {...defaultProps}
        partialHistory={history}
        replayToPosition={replayToPosition}
      />,
    );

    // Navigate to first position
    fireEvent.click(screen.getByLabelText("First"));

    // Now First and Previous should be disabled
    expect(screen.getByLabelText("First")).toBeDisabled();
    expect(screen.getByLabelText("Previous")).toBeDisabled();
  });

  it("Close button calls exitReplay", () => {
    const history = createHistory(4);
    const exitReplay = vi.fn();
    render(
      <StreamingPlaybackBar
        {...defaultProps}
        partialHistory={history}
        exitReplay={exitReplay}
      />,
    );

    fireEvent.click(screen.getByLabelText("Close playback"));

    expect(exitReplay).toHaveBeenCalledTimes(1);
  });

  it("renders speed selector with default value", () => {
    const history = createHistory(4);
    render(
      <StreamingPlaybackBar {...defaultProps} partialHistory={history} />,
    );

    expect(screen.getByLabelText("Playback speed")).toBeInTheDocument();
  });

  it("renders Raw JSON collapsible trigger", () => {
    const history = createHistory(4);
    render(
      <StreamingPlaybackBar {...defaultProps} partialHistory={history} />,
    );

    expect(screen.getByText("Raw JSON")).toBeInTheDocument();
  });
});
