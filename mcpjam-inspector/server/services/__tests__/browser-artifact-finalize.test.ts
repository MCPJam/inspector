/**
 * The terminal step that decides which video an iteration ends up with.
 *
 * There are two recorders now — the local widget harness's Playwright `.webm`
 * and a hosted daemon's MP4, collected off a per-run box before it was
 * released — and `videoBlobId` is FIRST-WRITE-WINS on the backend. Two videos
 * racing for one iteration would land on whichever call arrived first, a coin
 * toss decided by network timing. There is no conflict today (a hosted
 * iteration has no local Chromium to record), and these pin the order so there
 * is none tomorrow either.
 */
import { describe, expect, it, vi } from "vitest";

const finalizeEvalIterationMock = vi.fn();
vi.mock("../evals/finalize-iteration.js", () => ({
  finalizeEvalIteration: (...args: unknown[]) =>
    finalizeEvalIterationMock(...args),
}));

const { finalizeWithBrowserArtifacts } = await import(
  "../browser-artifact-finalize.js"
);

/** A browser context that recorded `video`, or nothing. */
function fakeBrowser(video: Buffer | null) {
  return { collectVideo: vi.fn(async () => video) } as never;
}

const SINK = {
  kind: "eval" as const,
  recorder: null,
  convexClient: {} as never,
  finishParams: { passed: true, status: "completed" } as never,
};

const HOSTED = {
  bytes: Buffer.from("mp4-bytes"),
  mime: "video/mp4",
  meta: {
    source: "hosted" as const,
    fps: 15,
    durationMs: 9_000,
    distinctFrames: 42,
    truncated: true,
  },
};

function finishParams(): Record<string, unknown> {
  const call = finalizeEvalIterationMock.mock.calls.at(-1);
  if (!call) throw new Error("nothing was finalized");
  return call[0] as Record<string, unknown>;
}

describe("finalizeWithBrowserArtifacts — which video the iteration keeps", () => {
  it("uses the hosted recording when the local harness recorded nothing", async () => {
    // The ordinary hosted iteration: there is no local Chromium on that path,
    // so `collectVideo()` is null and the box's file is the only account.
    finalizeEvalIterationMock.mockClear();

    await finalizeWithBrowserArtifacts({
      browser: fakeBrowser(null),
      logScope: "test",
      fallbackVideo: HOSTED,
      sink: SINK,
    });

    expect(finishParams()).toMatchObject({
      videoBytes: HOSTED.bytes,
      // Explicit: Convex serves back exactly the type the bytes were posted
      // with, and an mp4 announced as webm plays nowhere.
      videoMime: "video/mp4",
      videoMeta: HOSTED.meta,
    });
  });

  it("prefers the local harness's own recording when it has one", async () => {
    finalizeEvalIterationMock.mockClear();
    const local = Buffer.from("webm-bytes");

    await finalizeWithBrowserArtifacts({
      browser: fakeBrowser(local),
      logScope: "test",
      fallbackVideo: HOSTED,
      sink: SINK,
    });

    expect(finishParams()).toMatchObject({
      videoBytes: local,
      videoMime: "video/webm",
      // Only the source: Playwright writes the `.webm` itself and tells us
      // nothing about it, so claiming a duration or a frame count would be
      // inventing them.
      videoMeta: { source: "widget" },
    });
  });

  it("treats a zero-byte local recording as no recording", async () => {
    // `collectVideo()` can return an empty buffer for a context that opened
    // and closed without painting. Preferring it would drop a real hosted take
    // in favour of a file with nothing in it.
    finalizeEvalIterationMock.mockClear();

    await finalizeWithBrowserArtifacts({
      browser: fakeBrowser(Buffer.alloc(0)),
      logScope: "test",
      fallbackVideo: HOSTED,
      sink: SINK,
    });

    expect(finishParams()).toMatchObject({ videoBytes: HOSTED.bytes });
  });

  it("sends no video fields at all when neither recorder produced one", async () => {
    finalizeEvalIterationMock.mockClear();

    await finalizeWithBrowserArtifacts({
      browser: fakeBrowser(null),
      logScope: "test",
      sink: SINK,
    });

    const params = finishParams();
    expect(params.videoBytes).toBeUndefined();
    expect(params.videoMime).toBeUndefined();
    expect(params.videoMeta).toBeUndefined();
  });

  it("still finalizes when collecting the local video throws", async () => {
    // This runs on a terminal path where the result is already decided;
    // nothing here may change it.
    finalizeEvalIterationMock.mockClear();

    await finalizeWithBrowserArtifacts({
      browser: {
        collectVideo: async () => {
          throw new Error("context already closed");
        },
      } as never,
      logScope: "test",
      fallbackVideo: HOSTED,
      sink: SINK,
    });

    expect(finishParams()).toMatchObject({ videoBytes: HOSTED.bytes });
  });

  it("hands the session sink bytes alone, as it always has", async () => {
    // A synthetic session runs the local harness and has no hosted path; the
    // sink takes no mime, so the fallback is not offered rather than
    // half-offered.
    const persist = vi.fn(async () => {});
    const local = Buffer.from("webm-bytes");

    await finalizeWithBrowserArtifacts({
      browser: fakeBrowser(local),
      logScope: "test",
      sink: { kind: "session", persist },
    });

    expect(persist).toHaveBeenCalledWith(local);
  });
});
