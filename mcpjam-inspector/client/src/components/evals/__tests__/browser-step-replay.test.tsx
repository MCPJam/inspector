/**
 * BrowserStepFilmstrip — the synchronized replay surface. Locks the three-way
 * cursor (filmstrip ↔ video ↔ step detail), the `videoOffsetMs` seek that made
 * the field useful, and the explicit degradation states that replace blank
 * frames.
 */
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalTraceBrowserInteractionStepView } from "@/shared/eval-trace";
import {
  BrowserStepFilmstrip,
  browserStepKey,
  stepAtVideoOffset,
} from "../browser-step-replay";

function step(
  overrides: Partial<EvalTraceBrowserInteractionStepView> = {},
): EvalTraceBrowserInteractionStepView {
  return {
    toolCallId: "tc-1",
    stepIndex: 0,
    promptIndex: 0,
    action: "left_click",
    elapsedMs: 12,
    ts: 1_000,
    screenshotUrl: "https://example.test/shot-0.png",
    ...overrides,
  } as EvalTraceBrowserInteractionStepView;
}

/**
 * jsdom has no media pipeline: `currentTime` is inert and no seek ever resolves.
 * Stand in for it so a test can place the playhead and then fire the events a
 * real player would.
 */
function mockPlayhead(video: HTMLVideoElement, initial = 0) {
  let currentTime = initial;
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    },
  });
  return {
    seekTo: (value: number) => {
      currentTime = value;
    },
  };
}

describe("stepAtVideoOffset", () => {
  const steps = [
    step({ stepIndex: 0, videoOffsetMs: 1_000 }),
    step({ stepIndex: 1, videoOffsetMs: 4_000 }),
    step({ stepIndex: 2, videoOffsetMs: 9_000 }),
  ];

  it("returns the last step at or before the playhead", () => {
    expect(stepAtVideoOffset(steps, 4_000)?.stepIndex).toBe(1);
    expect(stepAtVideoOffset(steps, 8_999)?.stepIndex).toBe(1);
    expect(stepAtVideoOffset(steps, 9_000)?.stepIndex).toBe(2);
    expect(stepAtVideoOffset(steps, 60_000)?.stepIndex).toBe(2);
  });

  it("returns null during the pre-interaction lead-in", () => {
    expect(stepAtVideoOffset(steps, 0)).toBeNull();
    expect(stepAtVideoOffset(steps, 999)).toBeNull();
  });

  it("ignores steps with no offset (nothing to seek to)", () => {
    expect(
      stepAtVideoOffset([step({ videoOffsetMs: undefined })], 5_000),
    ).toBeNull();
  });
});

describe("BrowserStepFilmstrip", () => {
  it("seeks the video and shows the step detail when a frame is picked", async () => {
    render(
      <BrowserStepFilmstrip
        videoUrl="https://example.test/replay.webm"
        steps={[
          step({ stepIndex: 0, videoOffsetMs: 1_500 }),
          step({
            stepIndex: 1,
            videoOffsetMs: 6_250,
            locatorLabel: 'role=button[name="Add to cart"]',
          }),
        ]}
      />,
    );

    const video = screen.getByTestId(
      "browser-replay-video",
    ) as HTMLVideoElement;
    // jsdom has no media pipeline; observe the assignment directly.
    const seeks: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => seeks.at(-1) ?? 0,
      set: (value: number) => seeks.push(value),
    });

    const frames = screen.getAllByTestId("browser-filmstrip-frame");
    expect(frames).toHaveLength(2);
    await userEvent.click(frames[1]!);

    // videoOffsetMs → seconds. This is the whole point of the field.
    expect(seeks).toEqual([6.25]);
    expect(frames[1]).toHaveAttribute("data-active", "true");
    expect(frames[0]).toHaveAttribute("data-active", "false");
    // ...and the third view of the same cursor: the step's own record.
    expect(screen.getByTestId("browser-step-detail")).toHaveTextContent(
      'Click role=button[name="Add to cart"]',
    );
  });

  it("orders frames by video offset, not by arrival", async () => {
    render(
      <BrowserStepFilmstrip
        videoUrl="https://example.test/replay.webm"
        steps={[
          step({ toolCallId: "tc-b", stepIndex: 0, videoOffsetMs: 9_000 }),
          step({ toolCallId: "tc-a", stepIndex: 0, videoOffsetMs: 2_000 }),
        ]}
      />,
    );
    expect(
      screen
        .getAllByTestId("browser-filmstrip-frame")
        .map((el) => el.getAttribute("data-step-key")),
    ).toEqual(["tc-a:0", "tc-b:0"]);
  });

  it("renders screenshots with an explicit reason when the video is missing", () => {
    render(
      <BrowserStepFilmstrip
        videoUrl={null}
        steps={[step({ stepIndex: 0, videoOffsetMs: 1_000 })]}
      />,
    );

    expect(screen.queryByTestId("browser-replay-video")).toBeNull();
    // Not a blank frame — say what happened and what survived.
    expect(
      screen.getByTestId("browser-replay-video-unavailable"),
    ).toHaveTextContent("Video unavailable — screenshots preserved.");
    expect(screen.getAllByTestId("browser-filmstrip-frame")).toHaveLength(1);
  });

  it("says the replay is still finalizing while the run is live", () => {
    render(<BrowserStepFilmstrip videoUrl={null} steps={[step()]} isRunning />);
    expect(
      screen.getByTestId("browser-replay-video-unavailable"),
    ).toHaveTextContent(/Finalizing replay/);
  });

  it("plays the video even when no interaction steps were recorded", () => {
    render(
      <BrowserStepFilmstrip
        videoUrl="https://example.test/replay.webm"
        steps={[]}
      />,
    );
    // A video with no steps still plays; the filmstrip track is simply absent.
    expect(screen.getByTestId("browser-replay-video")).toBeTruthy();
    expect(screen.queryByTestId("browser-filmstrip-track")).toBeNull();
  });

  it("keeps the manual pin through the echo of its own seek", async () => {
    render(
      <BrowserStepFilmstrip
        videoUrl="https://example.test/replay.webm"
        steps={[
          step({ stepIndex: 0, videoOffsetMs: 1_000 }),
          step({ stepIndex: 1, videoOffsetMs: 6_000 }),
        ]}
      />,
    );
    const video = screen.getByTestId(
      "browser-replay-video",
    ) as HTMLVideoElement;
    const playhead = mockPlayhead(video);

    const frames = screen.getAllByTestId("browser-filmstrip-frame");
    await userEvent.click(frames[1]!);

    // Browsers resolve a seek to the nearest decodable frame, which can land
    // just BEFORE the requested offset. If that echo released the pin, the
    // selection would slide back to step 0 the instant the user clicked step 1.
    playhead.seekTo(5.9);
    await act(async () => {
      video.dispatchEvent(new Event("seeked"));
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getAllByTestId("browser-filmstrip-frame")[1]).toHaveAttribute(
      "data-active",
      "true",
    );

    // Playback moving away from the pinned step IS the pin going stale — release
    // it so the filmstrip follows the video again.
    playhead.seekTo(1.2);
    await act(async () => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getAllByTestId("browser-filmstrip-frame")[0]).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("releases the pin as soon as playback passes the pinned step", async () => {
    render(
      <BrowserStepFilmstrip
        videoUrl="https://example.test/replay.webm"
        steps={[
          step({ stepIndex: 0, videoOffsetMs: 1_000 }),
          step({ stepIndex: 1, videoOffsetMs: 6_000 }),
          // Inside a symmetric 500ms window around step 1 — the case that window
          // used to swallow.
          step({ stepIndex: 2, videoOffsetMs: 6_300 }),
        ]}
      />,
    );
    const video = screen.getByTestId(
      "browser-replay-video",
    ) as HTMLVideoElement;
    const playhead = mockPlayhead(video);

    await userEvent.click(screen.getAllByTestId("browser-filmstrip-frame")[1]!);
    playhead.seekTo(5.95);
    await act(async () => {
      video.dispatchEvent(new Event("seeked"));
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getAllByTestId("browser-filmstrip-frame")[1]).toHaveAttribute(
      "data-active",
      "true",
    );

    // Playback continues into the NEXT step, which is only 300ms later. The
    // undershoot slack is one-sided precisely so this frame isn't hidden: a
    // symmetric window would have held the pin on step 1 and made the filmstrip
    // skip step 2 entirely.
    playhead.seekTo(6.35);
    await act(async () => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getAllByTestId("browser-filmstrip-frame")[2]).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("keeps the pin when a playback tick beats the seek to the handler", async () => {
    render(
      <BrowserStepFilmstrip
        videoUrl="https://example.test/replay.webm"
        steps={[
          step({ stepIndex: 0, videoOffsetMs: 1_000 }),
          step({ stepIndex: 1, videoOffsetMs: 6_000 }),
        ]}
      />,
    );
    const video = screen.getByTestId(
      "browser-replay-video",
    ) as HTMLVideoElement;
    const playhead = mockPlayhead(video, 1.1);

    await userEvent.click(screen.getAllByTestId("browser-filmstrip-frame")[1]!);
    // The seek was requested but hasn't landed; a `timeupdate` from the playback
    // that was already running reports the OLD position. Identifying the echo by
    // "first timeupdate after a seek" would spend the guard here and drop the
    // click the user just made.
    playhead.seekTo(1.15);
    await act(async () => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getAllByTestId("browser-filmstrip-frame")[1]).toHaveAttribute(
      "data-active",
      "true",
    );

    // The seek then lands just shy of the offset, and the pin is still the user's.
    playhead.seekTo(5.98);
    await act(async () => {
      video.dispatchEvent(new Event("seeked"));
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getAllByTestId("browser-filmstrip-frame")[1]).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("does not claim screenshots survived when none did", () => {
    render(
      <BrowserStepFilmstrip
        videoUrl={null}
        steps={[step({ screenshotUrl: undefined })]}
      />,
    );
    expect(
      screen.getByTestId("browser-replay-video-unavailable"),
    ).toHaveTextContent("no screenshots survived");
  });

  it("says the recording failed to LOAD when the player errored", async () => {
    render(
      <BrowserStepFilmstrip
        videoUrl="https://example.test/gone.webm"
        steps={[step()]}
      />,
    );
    screen.getByTestId("browser-replay-video").dispatchEvent(new Event("error"));
    // Distinct from "never uploaded" — the run DID record one.
    expect(
      await screen.findByTestId("browser-replay-video-unavailable"),
    ).toHaveTextContent("Recording failed to load — screenshots preserved.");
  });

  it("treats an empty-string videoUrl as no video", () => {
    render(<BrowserStepFilmstrip videoUrl="" steps={[step()]} />);
    expect(screen.queryByTestId("browser-replay-video")).toBeNull();
    expect(
      screen.getByTestId("browser-replay-video-unavailable"),
    ).toHaveTextContent("Video unavailable — screenshots preserved.");
  });

  it("shows an empty state rather than a broken player with nothing at all", () => {
    render(<BrowserStepFilmstrip videoUrl={null} steps={[]} />);
    expect(screen.getByTestId("browser-filmstrip-empty")).toHaveTextContent(
      "No app interactions were recorded.",
    );
  });

  it("falls back to a frame-less placeholder for a step with no screenshot", () => {
    render(
      <BrowserStepFilmstrip
        videoUrl={null}
        steps={[step({ screenshotUrl: undefined })]}
      />,
    );
    expect(screen.getByText("No frame")).toBeTruthy();
  });

  it("labels an offset-less step by its turn instead of a bogus timestamp", () => {
    render(
      <BrowserStepFilmstrip
        videoUrl={null}
        steps={[step({ promptIndex: 2, videoOffsetMs: undefined })]}
      />,
    );
    expect(screen.getByText("turn 3")).toBeTruthy();
  });

  it("degrades to a screenshots-only state when the video fails to load", async () => {
    render(
      <BrowserStepFilmstrip
        videoUrl="https://example.test/gone.webm"
        steps={[step()]}
      />,
    );
    const video = screen.getByTestId("browser-replay-video");
    // A blob URL that 404s must not leave a dead player on screen.
    video.dispatchEvent(new Event("error"));
    expect(
      await screen.findByTestId("browser-replay-video-unavailable"),
    ).toHaveTextContent("Recording failed to load — screenshots preserved.");
  });
});

describe("browserStepKey", () => {
  it("is stable across the video, the filmstrip, and the trace", () => {
    expect(browserStepKey(step({ toolCallId: "tc-9", stepIndex: 3 }))).toBe(
      "tc-9:3",
    );
  });
});
