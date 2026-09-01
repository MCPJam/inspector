/**
 * The screencast path, driven with a fake CDP session.
 *
 * The Chromium-gated integration suite proves the real browser answers
 * `Page.startScreencast`; this proves the ORDERING and the drop policy around
 * it, neither of which is observable from outside the session — and both of
 * which fail in ways that look like "the pane is just stuck".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import {
  PlaywrightWebMcpSession,
  STILL_TIMEOUT_MS,
} from "../playwright-provider";
import {
  WEBMCP_FRAME_MAX_BYTES,
  WEBMCP_HOUSEKEEPING_INTERVAL_MS,
  WEBMCP_QUALITY_PRESSURE_DROPS,
  WEBMCP_QUALITY_RECOVER_QUIET_MS,
  WEBMCP_QUALITY_STEP_HOLD_MS,
  WEBMCP_SETTLE_QUIET_MS,
  WEBMCP_SETTLE_STILL_QUALITIES,
  WEBMCP_STREAM_QUALITY_LADDER,
  WEBMCP_SUBSTITUTE_QUALITY_LADDER,
  WEBMCP_VIEWPORT,
  type WebMcpFrame,
} from "@/shared/webmcp-inspector-protocol";
import type { WebMcpSessionCallbacks, WebMcpViewportMode } from "../provider";
import { SCREENSHOT_MAX_BYTES } from "../provider-shared";

class FakeCdp {
  readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
  readonly sent: Array<{ method: string; params?: unknown }> = [];

  on(event: string, handler: (payload: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    return {};
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  methods(): string[] {
    return this.sent.map((call) => call.method);
  }
}

/**
 * A base64 JPEG whose FRAME HEADER declares `width` x `height`.
 *
 * Built by hand rather than encoded, because what the provider reads is the
 * SOF marker and nothing else: SOI, a short APP0, then a baseline SOF0.
 */
function jpegBase64(width: number, height: number): string {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
  ]).toString("base64");
}

/**
 * Base64 of `bytes` raw bytes, for exercising the oversize cap.
 *
 * `fill` distinguishes one oversized frame from the next: consecutive frames
 * with identical bytes are dropped as redundant, so a burst built from one
 * payload would be a burst of exactly one frame.
 */
function base64OfSize(bytes: number, fill = 0x41): string {
  return Buffer.alloc(bytes, fill).toString("base64");
}

/** What `Page.captureScreenshot` answers with, unless a test says otherwise. */
const SMALL_STILL = Buffer.from("tiny-still").toString("base64");

/** Answer `Page.captureScreenshot` with a different payload per quality. */
function stillAnswer(byQuality: Record<number, string | undefined>) {
  return ({ quality }: { quality: number }) => byQuality[quality];
}

/**
 * A capture pinned open until the test releases it.
 *
 * Pinned rather than made slow, for the reason the overtake tests give: the
 * race only exists WHILE the capture is in flight, and a sleep long enough to
 * make that window likely is also long enough to close early on a loaded
 * machine and pass without testing anything.
 */
function heldStill(data = SMALL_STILL) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    still: async () => {
      await gate;
      return data;
    },
    release: () => release(),
  };
}

function harness(
  options: {
    viewportMode?: WebMcpViewportMode;
    onSend?: (method: string, params?: unknown) => unknown;
    screenshot?: (options?: Record<string, unknown>) => Promise<Buffer>;
    /** Answers `Page.captureScreenshot` — the still path's only CDP call. */
    still?: (params: {
      quality: number;
    }) => string | undefined | Promise<string | undefined>;
    /** The context's device scale factor, as `createSession` passes it on. */
    devicePixelRatio?: number;
  } = {},
) {
  const cdp = new FakeCdp();
  /** ONE ordered log, so "ack came first" is a real assertion, not two counts. */
  const log: string[] = [];
  const frames: WebMcpFrame[] = [];
  /** Every quality the session announced, in order. */
  const qualities: number[] = [];
  // Typed with the options argument Playwright's `page.screenshot` takes, so a
  // test can assert on it — the substitute path's geometry is the whole point
  // of one of them.
  const screenshots = vi.fn<
    (options?: Record<string, unknown>) => Promise<Buffer>
  >(options.screenshot ?? (async () => Buffer.from("tiny-screenshot")));
  /**
   * Every still the session asked the browser for.
   *
   * Its own spy rather than a filter over the CDP ledger, because the two
   * things a still test wants to know — how many were taken, and what came
   * back for a given quality — are a call count and a return value.
   */
  const stills = vi.fn<
    (params: {
      quality: number;
    }) => string | undefined | Promise<string | undefined>
  >(options.still ?? (() => SMALL_STILL));

  const originalSend = cdp.send.bind(cdp);
  cdp.send = async (method: string, params?: unknown) => {
    if (method === "Page.screencastFrameAck") log.push("ack");
    await originalSend(method, params);
    const answered = options.onSend?.(method, params);
    if (answered !== undefined) return answered;
    if (method === "Page.captureScreenshot") {
      const quality = Number(
        (params as { quality?: number } | undefined)?.quality ?? 0,
      );
      const data = await stills({ quality });
      // Shaped like Chromium's answer, `data` and all: an undefined payload is
      // a capture that failed, which the session must treat as "keep the
      // picture we have" rather than publishing nothing-shaped-like-a-frame.
      return data === undefined ? {} : { data };
    }
    return {};
  };

  const callbacks: WebMcpSessionCallbacks = {
    onToolsChanged: () => {},
    onNavigated: () => {},
    onPopupOpened: () => {},
    onExternalInvocation: () => {},
    onActivityObserved: () => {},
    onCrashed: () => {},
    onFrame: (frame) => {
      log.push("frame");
      frames.push(frame);
    },
    onStreamQualityChanged: (quality) => qualities.push(quality),
  };

  /** Every mouse/keyboard call Playwright would have made, in order. */
  const driven: string[] = [];
  const record =
    (label: string) =>
    (...args: unknown[]) => {
      driven.push(`${label}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      return Promise.resolve();
    };

  const page = {
    on: () => {},
    goto: async () => {},
    url: () => "https://example.test/",
    evaluate: async () => true,
    screenshot: screenshots,
    mouse: {
      move: record("move"),
      down: record("down"),
      up: record("up"),
      wheel: record("wheel"),
    },
    keyboard: {
      down: record("key.down"),
      up: record("key.up"),
      insertText: record("insertText"),
    },
  } as unknown as Page;

  const session = new PlaywrightWebMcpSession(
    { close: async () => {} } as unknown as Browser,
    { close: async () => {} } as unknown as BrowserContext,
    page,
    cdp as unknown as CDPSession,
    callbacks,
    "https://example.test/",
    true,
    options.viewportMode,
    options.devicePixelRatio,
  );

  sessions.push(session);
  return {
    session,
    cdp,
    log,
    frames,
    qualities,
    screenshots,
    stills,
    driven,
    page,
  };
}

/**
 * Every session a test built, disposed between cases.
 *
 * `setScreencast(true)` now arms a real interval, and a real-timer test that
 * left one running would fire stills into the next case's expectations.
 */
const sessions: PlaywrightWebMcpSession[] = [];

afterEach(async () => {
  const built = sessions.splice(0, sessions.length);
  for (const session of built) await session.dispose();
  // Faked in several suites below, and a clock left faked would freeze the
  // next file's `vi.waitFor`.
  vi.useRealTimers();
});

/**
 * Fake timers BEFORE the session is built, deliberately.
 *
 * `createFrameThrottle` captures `Date.now` at construction, so faking the
 * clock afterwards would leave the throttle reading real time while its timers
 * ran on the fake one — and every timing assertion would be measuring whatever
 * the machine happened to do. The settle timer has the same requirement.
 */
async function startedWithFakeClock(
  options: Parameters<typeof harness>[0] = {},
) {
  vi.useFakeTimers();
  return started(options);
}

/** Wire the CDP listeners the way `start()` does, without a browser. */
async function started(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.session.start("https://example.test/");
  return h;
}

function screencastFrame(data: string, sessionId = 1) {
  return {
    data,
    sessionId,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  };
}

describe("PlaywrightWebMcpSession screencast", () => {
  it("starts the cast with the streaming budget, and is idempotent", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    await h.session.setScreencast(true);

    const starts = h.cdp.sent.filter(
      (call) => call.method === "Page.startScreencast",
    );
    // The client asks on every pane mount and visibility change. A second
    // encoder per ask would be a leak nobody would notice until it was one.
    expect(starts).toHaveLength(1);
    expect(starts[0].params).toEqual({
      format: "jpeg",
      quality: WEBMCP_STREAM_QUALITY_LADDER[0],
      maxWidth: WEBMCP_VIEWPORT.width,
      maxHeight: WEBMCP_VIEWPORT.height,
    });
  });

  it("acknowledges a frame BEFORE doing anything with it", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 7));

    // Chromium sends the next frame only once this one is acknowledged, so an
    // ack that waits on consumption lets a slow consumer starve the stream into
    // stillness — a pane frozen on whatever the page looked like then.
    expect(h.log).toEqual(["ack", "frame"]);
    expect(
      h.cdp.sent.find((call) => call.method === "Page.screencastFrameAck")
        ?.params,
    ).toEqual({ sessionId: 7 });
  });

  it("carries the frame's own device dimensions", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", {
      data: jpegBase64(1280, 800),
      sessionId: 1,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
    expect(h.frames[0]).toMatchObject({
      deviceWidth: 1280,
      deviceHeight: 800,
      scale: 1,
    });
  });

  it("substitutes a budgeted still for an oversized frame", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    const huge = base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1);

    h.cdp.emit("Page.screencastFrame", screencastFrame(huge));
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));

    // The oversized frame itself is never published…
    expect(h.frames[0].data).not.toBe(huge);
    // …but the pane still converges on the current paint, because the
    // trailing-frame guarantee covers throttle drops and NOT this one: a
    // complex static page whose final paint exceeds the cap would otherwise
    // leave the pane stale forever.
    expect(h.frames[0].data).toBe(SMALL_STILL);
    // Taken through the CDP surface path at the substitute ladder's first
    // rung — BELOW the streaming baseline, because the reason this still
    // exists is that the page's own paint did not fit the cap.
    expect(
      h.cdp.sent.filter((call) => call.method === "Page.captureScreenshot"),
    ).toEqual([
      {
        method: "Page.captureScreenshot",
        params: {
          format: "jpeg",
          quality: WEBMCP_SUBSTITUTE_QUALITY_LADDER[0],
          fromSurface: true,
        },
      },
    ]);
    // NOT Playwright's `page.screenshot()`: its default `caret: "hide"` writes
    // an inline style onto every text field and restores it, which paints —
    // and those paints make the still discard itself as overtaken.
    expect(h.screenshots).not.toHaveBeenCalled();
    // Still acknowledged, before the size was even looked at.
    expect(h.log[0]).toBe("ack");
  });

  it("captures a FULL-VIEWPORT still, never the thumbnail's crop", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));

    // The thumbnail path's retry CLIPS to the top-left 640x400 — right for
    // evidence viewed as-is, wrong for a surface the client scales clicks
    // against. A crop published as 1280x800 would stretch a quarter of the page
    // across the pane and put every click at up to twice its true coordinate.
    // A clip is also the emulation path that can relayout and paint, which is
    // the second reason never to send one from here.
    for (const call of h.cdp.sent) {
      if (call.method !== "Page.captureScreenshot") continue;
      expect(call.params).not.toHaveProperty("clip");
    }
    expect(h.frames[0]).toMatchObject({
      deviceWidth: WEBMCP_VIEWPORT.width,
      deviceHeight: WEBMCP_VIEWPORT.height,
    });
  });

  it("drops a still that a newer frame has already overtaken", async () => {
    const late = heldStill("late-shot");
    const h = await started({ still: late.still });
    await h.session.setScreencast(true);
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.waitFor(() => expect(h.stills).toHaveBeenCalledTimes(1));

    // A newer paint arrives while the still is still being taken.
    h.cdp.emit("Page.screencastFrame", screencastFrame("newer"));
    late.release();
    // Everything left in the still's path is microtasks, so one turn of the
    // timer queue runs it to its decision — no wall-clock guess.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The still is now older than what the pane is showing. Publishing it
    // would drag the picture backwards.
    expect(h.frames.map((frame) => frame.data)).toEqual(["newer"]);
  });

  it("drops a still overtaken by a frame still held in the throttle", async () => {
    const late = heldStill("late-shot");
    const h = await started({ still: late.still });
    await h.session.setScreencast(true);
    // Burn the throttle's leading edge, so the next real frame is HELD in the
    // trailing slot rather than published.
    h.cdp.emit("Page.screencastFrame", screencastFrame("first"));
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.waitFor(() => expect(h.stills).toHaveBeenCalledTimes(1));

    h.cdp.emit("Page.screencastFrame", screencastFrame("newer"));
    late.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Nothing new has been PUBLISHED yet — "newer" is inside the throttle,
    // waiting for the window to close. A staleness check counting publications
    // would see no change, let the still through, and the throttle would then
    // coalesce the older picture over the newer one: the pane settles on the
    // stale paint and stays there until the page happens to repaint.
    expect(h.frames.map((frame) => frame.data)).toEqual(["first"]);
    await vi.waitFor(
      () =>
        expect(h.frames.map((frame) => frame.data)).toEqual(["first", "newer"]),
      { timeout: 2_000 },
    );
  });

  it("drops a still whose page navigated while it was in flight", async () => {
    const late = heldStill("stale-page");
    const h = await started({ still: late.still });
    await h.session.setScreencast(true);
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.waitFor(() => expect(h.stills).toHaveBeenCalledTimes(1));

    // The person navigates while the capture is out. A frame count cannot see
    // this — a navigation produces no frame of its own — so the capture would
    // otherwise land and repaint the pane with the page they just left, while
    // their clicks go to the new one.
    h.cdp.emit("Page.frameNavigated", {
      frame: { id: "main", url: "https://example.test/next" },
    });
    late.release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.frames).toHaveLength(0);
  });

  it("drops a still whose stream was stopped while it was in flight", async () => {
    const late = heldStill("stale-stream");
    const h = await started({ still: late.still });
    await h.session.setScreencast(true);
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.waitFor(() => expect(h.stills).toHaveBeenCalledTimes(1));

    await h.session.setScreencast(false);
    await h.session.setScreencast(true);
    late.release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A capture from the previous stream describes a picture this one has not
    // sent yet — and the client cleared its pane when the stream stopped.
    expect(h.frames).toHaveLength(0);
  });

  it("re-captures at most once after a burst of oversized frames", async () => {
    const late = heldStill();
    const h = await started({ still: late.still });
    await h.session.setScreencast(true);
    for (let i = 0; i < 5; i++) {
      // Distinct bytes per paint: five identical ones are five drops, not a
      // burst — see the redundancy check.
      h.cdp.emit(
        "Page.screencastFrame",
        screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1, 0x41 + i), i),
      );
    }
    await vi.waitFor(() => expect(h.stills).toHaveBeenCalledTimes(1));
    // Oversized frames arrive in bursts, and a capture each would queue CDP
    // round trips behind a page that is already expensive to encode.
    expect(h.stills).toHaveBeenCalledTimes(1);

    late.release();
    // ONE trailing re-capture for the whole burst, however many frames were
    // refused while the first was in flight. Without it the pane would settle
    // on the picture that was current when the burst STARTED — the oldest of
    // them — on a page whose every paint exceeds the cap. It arrives on the
    // next housekeeping tick rather than immediately, which is what bounds a
    // page that never stops being oversize — see the pacing test below.
    await vi.waitFor(() => expect(h.stills).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.stills).toHaveBeenCalledTimes(2);
  });

  it("keeps a substitute owed to the stream that is starting", async () => {
    // `Page.startScreencast` held open, so the window this is about — between
    // `screencasting` going true and the start's reply arriving — is a window
    // the test controls rather than one it hopes to hit.
    let releaseStart!: () => void;
    const startHeld = new Promise<unknown>((resolve) => {
      releaseStart = () => resolve({});
    });
    let starts = 0;
    const held = heldStill();
    const h = await startedWithFakeClock({
      still: held.still,
      onSend: (method) => {
        if (method !== "Page.startScreencast") return undefined;
        starts += 1;
        return starts === 2 ? startHeld : undefined;
      },
    });

    // A still from the FIRST stream, pinned open — which is what makes the
    // next oversized frame set the pending flag rather than capture directly.
    await h.session.setScreencast(true);
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1, 0x41), 1),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stills).toHaveBeenCalledTimes(1);

    await h.session.setScreencast(false);
    const enabling = h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(0);

    // The browser is already casting — the start's REPLY is what has not
    // landed — so this frame belongs to the new stream, not the old one.
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1, 0x42), 2),
    );
    await vi.advanceTimersByTimeAsync(0);

    releaseStart();
    await enabling;
    // The first stream's capture can finish now; it discards itself, and frees
    // the latch the pending substitute is waiting on.
    held.release();
    await vi.advanceTimersByTimeAsync(WEBMCP_HOUSEKEEPING_INTERVAL_MS);

    // The substitute the NEW stream asked for is taken and published. Wiped by
    // a reset that ran after the start resolved, this paint would never reach
    // the pane at all — the frame itself was refused for its size, and nothing
    // repaints a page that has gone quiet.
    expect(h.frames.map((frame) => frame.data)).toEqual([SMALL_STILL]);
  });

  it("gives up on a capture the browser never answers", async () => {
    // A CDP session that takes the command and does not reply — a wedged
    // browser, or a target that went away mid-capture. `cdp.send` has no
    // timeout of its own, which is the difference from the `page.screenshot()`
    // this path used to go through.
    const held = heldStill();
    const h = await startedWithFakeClock({ still: held.still });
    await h.session.setScreencast(true);

    const shot = h.session.captureScreenshot();
    await vi.advanceTimersByTimeAsync(STILL_TIMEOUT_MS + 100);
    // The poll recovers on its next tick rather than waiting on a reply that
    // may never come.
    await expect(shot).resolves.toBeUndefined();

    // And when the browser does answer, everything the wedge held is released.
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1), 1),
    );
    await vi.advanceTimersByTimeAsync(10);
    // A capture that never settled would hold `publishStill`'s single-flight
    // latch for the life of the session — the settle still and the oversize
    // substitute both silently disabled, long after the browser recovered.
    expect(h.frames.map((frame) => frame.data)).toEqual([SMALL_STILL]);
  });

  it("does not queue another capture behind one that wedged", async () => {
    const held = heldStill();
    const h = await startedWithFakeClock({ still: held.still });

    const first = h.session.captureScreenshot();
    await vi.advanceTimersByTimeAsync(STILL_TIMEOUT_MS + 100);
    await expect(first).resolves.toBeUndefined();
    expect(h.stills).toHaveBeenCalledTimes(1);

    // The poll asks again a second later. The timeout freed the CALLER, not
    // the command — Playwright keeps a timed-out `send`'s callback registered
    // until the browser replies, and CDP cannot cancel one — so asking again
    // now would add a pending command per tick for as long as the renderer
    // stays wedged, and the pane can stay open for hours.
    const second = h.session.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stills).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBeUndefined();

    // The browser answering at last — with a picture nobody is waiting for any
    // more — is also what says it is worth asking again.
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    await expect(h.session.captureScreenshot()).resolves.toBe(SMALL_STILL);
    expect(h.stills).toHaveBeenCalledTimes(2);
  });

  it("paces substitute captures on a page that never fits", async () => {
    // Fake clock, because the whole claim is about a rate: with a real one,
    // "how many captures happened before the next tick" is whatever the
    // machine managed to run.
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);

    // The page repaints, above the cap again, WHILE the capture is in flight.
    // Not a contrived race — it is simply what a continuously busy page does,
    // and it means every capture ends with another substitute owed.
    let repaints = 0;
    h.stills.mockImplementation(async () => {
      if (repaints < 4) {
        repaints += 1;
        h.cdp.emit(
          "Page.screencastFrame",
          screencastFrame(
            base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1, 0x61 + repaints),
            10 + repaints,
          ),
        );
      }
      return SMALL_STILL;
    });

    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1), 1),
    );
    // Every microtask the capture queues, and NOT ONE timer — because a
    // re-capture started by the capture before it needs neither. A page whose
    // every paint is refused would otherwise drive `Page.captureScreenshot` as
    // fast as the browser answers, on top of an encode already too expensive
    // to carry, and the refused frames never reach a transport that could
    // report the pressure.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stills).toHaveBeenCalledTimes(1);

    // One per housekeeping tick from here, however fast the page repaints.
    await vi.advanceTimersByTimeAsync(WEBMCP_HOUSEKEEPING_INTERVAL_MS);
    expect(h.stills).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(WEBMCP_HOUSEKEEPING_INTERVAL_MS);
    expect(h.stills).toHaveBeenCalledTimes(3);
  });

  it("drops a frame whose bytes repeat the one before it", async () => {
    // Fake clock, because the throttle HOLDS a second frame that arrives
    // inside its window rather than dropping it: a same-tick assertion would
    // pass with the redundancy check deleted and the duplicate merely late.
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);

    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 1));
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 2));
    await vi.advanceTimersByTimeAsync(500);

    // Chromium produces exactly this frame whenever anything asks it for a
    // copy of the surface — a still, most of all — and it is byte-for-byte the
    // frame before it. Published, it would replace a sharp still with the same
    // picture at streaming quality a tenth of a second later; counted, it would
    // restart the settle clock and take another still, and another.
    expect(h.frames.map((frame) => frame.data)).toEqual(["paint"]);
    // Acknowledged all the same: Chromium gates the next frame on the ack, so
    // dropping one without acking wedges the stream.
    expect(
      h.cdp.sent.filter((call) => call.method === "Page.screencastFrameAck"),
    ).toHaveLength(2);
  });

  it("publishes a frame again once the picture actually changes", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 1));
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 2));
    h.cdp.emit("Page.screencastFrame", screencastFrame("changed", 3));

    // The check is bytes, not a time window: a page that really painted
    // something produces different bytes and is treated as the activity it is.
    await vi.waitFor(() =>
      expect(h.frames.map((frame) => frame.data)).toEqual(["paint", "changed"]),
    );
  });

  it("forgets the last frame when the page navigates", async () => {
    // Fake clock, because the throttle HOLDS the second frame rather than
    // dropping it: a same-tick assertion would pass with this fix reverted and
    // the frame merely late.
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 1));

    // A reload of a static page paints identically, and bytes do not know they
    // belong to a different document. Dropped as a duplicate, that frame is
    // gone for good: the runtime CLEARS its retained frame on navigation, so a
    // pane connecting after this would have nothing to show until the page
    // happened to repaint — which for a settled page is never.
    h.cdp.emit("Page.frameNavigated", {
      frame: { id: "main", url: "https://example.test/next" },
    });
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 2));
    await vi.advanceTimersByTimeAsync(500);

    expect(h.frames.map((frame) => frame.data)).toEqual(["paint", "paint"]);
  });

  it("forgets the last frame when the stream stops, so a restart repaints", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 1));
    await h.session.setScreencast(false);

    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint", 2));
    // The first frame of a restarted cast is the one the pane is waiting for.
    // Dropping it as a duplicate of the last frame of the PREVIOUS cast would
    // leave a freshly-mounted pane blank until the page happened to repaint.
    expect(h.frames.map((frame) => frame.data)).toEqual(["paint", "paint"]);
  });

  it("stops the cast and ignores a frame still in flight", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("first"));
    await h.session.setScreencast(false);
    h.cdp.emit("Page.screencastFrame", screencastFrame("late"));

    expect(h.cdp.methods()).toContain("Page.stopScreencast");
    // Still ACKNOWLEDGED — asserted, not just claimed. Chromium gates the next
    // frame on the ack, so a regression that stopped acking late frames would
    // wedge a stream that was about to be restarted.
    expect(
      h.cdp.sent.filter((call) => call.method === "Page.screencastFrameAck"),
    ).toHaveLength(2);
    // But not published: that would repaint a pane the client has just
    // cleared, with nothing left to correct it.
    expect(h.frames.map((frame) => frame.data)).toEqual(["first"]);
  });

  it("reports whether frames are actually flowing", async () => {
    const h = await started();
    // The plain case: the browser took the command.
    expect(await h.session.setScreencast(true)).toBe(true);
    expect(await h.session.setScreencast(false)).toBe(false);

    // And the case the client's fallback depends on.
    const refusing = await started({
      onSend: (method) => {
        if (method === "Page.startScreencast") {
          throw new Error(
            "Protocol error: 'Page.startScreencast' wasn't found",
          );
        }
        return {};
      },
    });
    // Reported, not thrown: the request was fine and this browser simply
    // cannot screencast. A resolved `void` here would tell the client the
    // stream was accepted and leave the pane waiting for frames forever.
    expect(await refusing.session.setScreencast(true)).toBe(false);
    // And it stays off, so a later stop does not send a stray command.
    expect(await refusing.session.setScreencast(false)).toBe(false);
    expect(refusing.cdp.methods()).not.toContain("Page.stopScreencast");
  });

  it("stops the cast on dispose", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    await h.session.dispose();
    expect(h.cdp.methods()).toContain("Page.stopScreencast");
  });

  it("does not stop a cast that was never started", async () => {
    const h = await started();
    await h.session.setScreencast(false);
    expect(h.cdp.methods()).not.toContain("Page.stopScreencast");
  });

  it("lets a stop that lands mid-start win", async () => {
    // Two clients can hold one session, and a pane that unmounts while its own
    // enable is still in flight sends the disable right behind it.
    let releaseStart: (() => void) | undefined;
    const h = await started();
    const originalSend = h.cdp.send.bind(h.cdp);
    // The command goes out immediately and only its REPLY is held. Delaying
    // the send itself would be testing this stub's ordering rather than the
    // session's — CDP writes when asked and answers when it answers.
    h.cdp.send = async (method: string, params?: unknown) => {
      const sent = originalSend(method, params);
      if (method === "Page.startScreencast") {
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
      }
      return sent;
    };

    const starting = h.session.setScreencast(true);
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf("function"));
    const stopping = h.session.setScreencast(false);
    releaseStart!();

    // The start reports FALSE, because by the time it returned the stream had
    // been withdrawn. Answering `true` here would tell its caller to sit and
    // wait for frames that are not coming.
    expect(await starting).toBe(false);
    expect(await stopping).toBe(false);
    // Both commands reached the browser, in the order they were asked for: one
    // CDP session, so Chromium ends stopped rather than in whichever state the
    // promises happened to settle in.
    expect(
      h.cdp
        .methods()
        .filter((method) => method.startsWith("Page.st"))
        .filter(
          (method) =>
            method === "Page.startScreencast" ||
            method === "Page.stopScreencast",
        ),
    ).toEqual(["Page.startScreencast", "Page.stopScreencast"]);

    // And nothing is left believing it is streaming: a later frame is acked
    // (Chromium gates on that) but published nowhere.
    h.cdp.emit("Page.screencastFrame", screencastFrame("after"));
    expect(h.frames).toHaveLength(0);
  });
});

/**
 * The timeline capture, which is ALSO the client's screenshot poll.
 *
 * That double duty is the whole hazard: a picture that is fine as evidence
 * viewed at its own size is not fine as a surface the pane maps clicks across.
 */
describe("PlaywrightWebMcpSession screenshots", () => {
  it("degrades quality, never geometry", async () => {
    const oversize = base64OfSize(SCREENSHOT_MAX_BYTES + 1);
    const h = await started({
      still: ({ quality }) => (quality >= 50 ? oversize : "smaller"),
    });

    expect(await h.session.captureScreenshot()).toBe("smaller");
    // No crop, ever. The pane renders whatever comes back as the whole
    // 1280x800 surface and maps input across it, so a top-left crop presented
    // as a viewport puts every click at up to twice its true coordinate — and
    // a session rendering at a high device pixel ratio hits the retry far more
    // often, because a device-scaled capture is four times the pixels.
    for (const call of h.cdp.sent) {
      if (call.method !== "Page.captureScreenshot") continue;
      expect(call.params).not.toHaveProperty("clip");
    }
    // And never Playwright's own screenshot, whose caret hiding mutates the
    // document it is capturing.
    expect(h.screenshots).not.toHaveBeenCalled();
  });

  it("gives up rather than exceed its budget", async () => {
    const oversize = base64OfSize(SCREENSHOT_MAX_BYTES + 1);
    const h = await started({ still: () => oversize });
    // The timeline can say "no screenshot". It must not carry a multi-megabyte
    // entry into an export, and the pane must not be handed a wrong shape.
    expect(await h.session.captureScreenshot()).toBeUndefined();
  });
});

describe("PlaywrightWebMcpSession input", () => {
  it("drives the page through Playwright's own mouse and keyboard", async () => {
    const h = await started();
    await h.session.dispatchInput([
      { kind: "mouse_move", x: 10, y: 20 },
      { kind: "mouse_down", x: 10, y: 20, button: "left", clickCount: 2 },
      { kind: "mouse_up", x: 10, y: 20, button: "left", clickCount: 2 },
      { kind: "wheel", x: 10, y: 20, deltaX: 0, deltaY: -120 },
      { kind: "key_down", key: "Shift" },
      { kind: "key_up", key: "Shift" },
      { kind: "text", text: "typed" },
    ]);

    // `page.mouse` / `page.keyboard` rather than raw `Input.dispatch*`: those
    // take a modifier bitmask, a text/unmodifiedText pair and a virtual key
    // code per key and per layout, and Playwright already carries that table.
    expect(h.driven).toEqual([
      "move(10,20)",
      "move(10,20)",
      'down({"button":"left","clickCount":2})',
      "move(10,20)",
      'up({"button":"left","clickCount":2})',
      // No move before the wheel: the pointer is already at (10,20). Every
      // other event still moves unconditionally — only the wheel skips, and
      // only when the coordinate is provably unchanged.
      "wheel(0,-120)",
      'key.down("Shift")',
      'key.up("Shift")',
      'insertText("typed")',
    ]);
    // No CDP traffic at all for input — it never reaches the raw domain.
    expect(h.cdp.methods()).not.toContain("Input.dispatchMouseEvent");
  });

  it("keeps going after one event Playwright refuses", async () => {
    const h = await started();
    const keyboard = (h.page as unknown as { keyboard: { down: unknown } })
      .keyboard;
    (keyboard as { down: () => Promise<void> }).down = () =>
      Promise.reject(new Error("Unknown key: 'Nonsense'"));

    await h.session.dispatchInput([
      { kind: "key_down", key: "Nonsense" },
      { kind: "mouse_down", x: 1, y: 2, button: "left" },
    ]);

    // A batch is a person's gesture. One exotic key that cannot be mapped must
    // not swallow the click queued behind it.
    expect(h.driven).toContain('down({"button":"left"})');
  });

  it("presses a modifier the person was already holding before the click", async () => {
    const h = await started();
    // Someone holds Shift, THEN clicks into the pane. No keydown was ever
    // forwarded — the pane had no focus — so Playwright's own modifier state
    // says nothing is held, and the page would get an unmodified click.
    await h.session.dispatchInput([
      {
        kind: "mouse_down",
        x: 5,
        y: 5,
        button: "left",
        modifiers: { shift: true },
      },
      {
        kind: "mouse_up",
        x: 5,
        y: 5,
        button: "left",
        modifiers: { shift: true },
      },
    ]);
    expect(h.driven[0]).toBe('key.down("Shift")');
    expect(h.driven).toContain('down({"button":"left"})');
    // Held across the whole gesture, not pressed and released per event.
    expect(
      h.driven.filter((call) => call === 'key.down("Shift")'),
    ).toHaveLength(1);
  });

  it("releases a modifier once the snapshot stops reporting it", async () => {
    const h = await started();
    await h.session.dispatchInput([
      { kind: "mouse_move", x: 1, y: 1, modifiers: { ctrl: true } },
      { kind: "mouse_move", x: 2, y: 2 },
    ]);
    // Otherwise a server-side "ctrl is down" would outlive the gesture and turn
    // every later click into a ctrl-click, with nothing to correct it.
    expect(h.driven).toEqual([
      'key.down("Control")',
      "move(1,1)",
      'key.up("Control")',
      "move(2,2)",
    ]);
  });

  it("does not re-press a modifier the client forwarded as a key", async () => {
    const h = await started();
    await h.session.dispatchInput([
      { kind: "key_down", key: "Shift" },
      {
        kind: "mouse_down",
        x: 1,
        y: 1,
        button: "left",
        modifiers: { shift: true },
      },
    ]);
    // The key event already put it down; pressing again would be a second
    // keydown the page sees as a repeat.
    expect(
      h.driven.filter((call) => call === 'key.down("Shift")'),
    ).toHaveLength(1);
  });

  it("clamps a coordinate that arrived outside the viewport", async () => {
    const h = await started();
    await h.session.dispatchInput([
      { kind: "mouse_move", x: 99_999, y: 99_999 },
    ]);
    // The client scales against the frame it is looking at, so an out-of-range
    // coordinate means the two disagreed for a moment — a resize, or a frame
    // that landed after the pane had already changed size.
    expect(h.driven).toEqual([
      `move(${WEBMCP_VIEWPORT.width - 1},${WEBMCP_VIEWPORT.height - 1})`,
    ]);
  });

  it("dispatches nothing once disposed", async () => {
    const h = await started();
    await h.session.dispose();
    await h.session.dispatchInput([{ kind: "mouse_move", x: 1, y: 1 }]);
    expect(h.driven).toEqual([]);
  });
});

describe("PlaywrightWebMcpSession embedded mode", () => {
  it("reports frame-stream with the surface's dimensions", async () => {
    const h = await started({ viewportMode: "embedded" });
    // Not `headless`: that would tell the client there is nothing to drive,
    // when the pane is the entire point of an embedded session.
    expect(h.session.viewportTransport()).toEqual({
      kind: "frame-stream",
      width: WEBMCP_VIEWPORT.width,
      height: WEBMCP_VIEWPORT.height,
    });
  });

  it("starts streaming without being asked", async () => {
    const h = await started({ viewportMode: "embedded" });
    // There is no window, so the stream is the only view. Nothing else would
    // ever turn it on for the first paint.
    expect(h.cdp.methods()).toContain("Page.startScreencast");
  });

  it("still reports native-window for a window session", async () => {
    const h = await started();
    expect(h.cdp.methods()).not.toContain("Page.startScreencast");
    expect(h.session.viewportTransport()).toEqual({ kind: "headless" });
  });
});

/**
 * The rate boost, and the wheel's move-skip.
 *
 * Both exist for the same number: the gap between a person doing something and
 * seeing it. The boost is observed through its EFFECT on the throttle rather
 * than by reaching into it, which is also the only way to observe the ordering
 * that matters — whether the boost was applied before or after the first
 * awaited Playwright call.
 */
describe("PlaywrightWebMcpSession input rate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises the frame rate while input is arriving", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);

    h.cdp.emit("Page.screencastFrame", screencastFrame("f0"));
    await h.session.dispatchInput([{ kind: "key_down", key: "a" }]);

    // 40ms apart: past the boosted floor, nowhere near the resting one. At the
    // resting rate the person would watch their own typing at 10fps.
    vi.advanceTimersByTime(40);
    h.cdp.emit("Page.screencastFrame", screencastFrame("f1"));
    vi.advanceTimersByTime(40);
    h.cdp.emit("Page.screencastFrame", screencastFrame("f2"));

    expect(h.frames.map((frame) => frame.data)).toEqual(["f0", "f1", "f2"]);
  });

  it("boosts BEFORE the batch's first Playwright call, not after", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);

    h.cdp.emit("Page.screencastFrame", screencastFrame("f0"));
    // 45ms on: past the boosted floor, short of the resting one. A frame
    // arriving now is published immediately if the boost is already in force,
    // and held if it is not.
    vi.advanceTimersByTime(45);

    let publishedDuringMove = -1;
    (
      h.page as unknown as {
        mouse: { move: (x: number, y: number) => Promise<void> };
      }
    ).mouse.move = async () => {
      // The paint the very first event of the batch causes, arriving while
      // `dispatchInput` is still awaiting this call.
      h.cdp.emit("Page.screencastFrame", screencastFrame("echo"));
      publishedDuringMove = h.frames.length;
    };

    await h.session.dispatchInput([{ kind: "mouse_move", x: 10, y: 20 }]);

    // Asserted INSIDE the call, not after the batch: a boost applied at the
    // end would still rescue the held frame on its way out, so only the state
    // at this instant can tell the two orderings apart. And the instant is
    // what matters — the person is waiting on this paint.
    expect(publishedDuringMove).toBe(2);
  });

  it("does not boost while nothing is streaming", async () => {
    const h = await startedWithFakeClock();
    await h.session.dispatchInput([{ kind: "key_down", key: "a" }]);

    // Frames are not flowing, so there is no rate to raise — and a boost left
    // armed would silently apply to whatever the stream did next.
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("f0"));
    vi.advanceTimersByTime(40);
    h.cdp.emit("Page.screencastFrame", screencastFrame("f1"));
    expect(h.frames.map((frame) => frame.data)).toEqual(["f0"]);

    vi.advanceTimersByTime(100);
    expect(h.frames.map((frame) => frame.data)).toEqual(["f0", "f1"]);
  });

  it("skips the positioning move for a wheel at an unchanged coordinate", async () => {
    const h = await started();
    await h.session.dispatchInput([
      { kind: "wheel", x: 40, y: 50, deltaX: 0, deltaY: -120 },
      { kind: "wheel", x: 40, y: 50, deltaX: 0, deltaY: -120 },
      { kind: "wheel", x: 40, y: 50, deltaX: 0, deltaY: -120 },
    ]);

    // A scroll is a run of wheels at one coordinate, and each wheel costs two
    // awaited CDP round trips. Only the first has to place the pointer.
    expect(h.driven).toEqual([
      "move(40,50)",
      "wheel(0,-120)",
      "wheel(0,-120)",
      "wheel(0,-120)",
    ]);
  });

  it("moves again as soon as the wheel coordinate changes", async () => {
    const h = await started();
    await h.session.dispatchInput([
      { kind: "wheel", x: 40, y: 50, deltaX: 0, deltaY: -120 },
      { kind: "wheel", x: 41, y: 50, deltaX: 0, deltaY: -120 },
    ]);
    expect(h.driven).toEqual([
      "move(40,50)",
      "wheel(0,-120)",
      "move(41,50)",
      "wheel(0,-120)",
    ]);
  });

  it("does not restore a coordinate the page navigated away from mid-move", async () => {
    const h = await started();
    await h.session.dispatchInput([
      { kind: "wheel", x: 40, y: 50, deltaX: 0, deltaY: -120 },
    ]);
    h.driven.length = 0;

    // The navigation lands DURING the awaited move, which is routine: a click
    // that navigates, then a wheel in the same gesture. Clearing `pointerAt`
    // on the event is not enough on its own — the assignment after the await
    // would put the old document's coordinate straight back, and the next
    // same-coordinate wheel would skip the move that first tells the NEW page
    // where the pointer is.
    (
      h.page as unknown as {
        mouse: { move: (x: number, y: number) => Promise<void> };
      }
    ).mouse.move = async (x: number, y: number) => {
      h.driven.push(`move(${x},${y})`);
      h.cdp.emit("Page.frameNavigated", {
        frame: { id: "main", url: "https://example.test/two" },
      });
    };

    await h.session.dispatchInput([
      { kind: "wheel", x: 60, y: 70, deltaX: 0, deltaY: -120 },
    ]);
    await h.session.dispatchInput([
      { kind: "wheel", x: 60, y: 70, deltaX: 0, deltaY: -120 },
    ]);

    expect(h.driven).toEqual([
      "move(60,70)",
      "wheel(0,-120)",
      "move(60,70)",
      "wheel(0,-120)",
    ]);
  });

  it("forgets the remembered coordinate when the page navigates", async () => {
    const h = await started();
    await h.session.dispatchInput([
      { kind: "wheel", x: 40, y: 50, deltaX: 0, deltaY: -120 },
    ]);
    h.cdp.emit("Page.frameNavigated", {
      frame: { id: "main", url: "https://example.test/two" },
    });
    await h.session.dispatchInput([
      { kind: "wheel", x: 40, y: 50, deltaX: 0, deltaY: -120 },
    ]);

    // A new document has no hover state. Skipping the move into it would leave
    // the page never told where the pointer is, so the wheel would scroll
    // whatever the document scrolls by default instead of what is under it.
    expect(h.driven).toEqual([
      "move(40,50)",
      "wheel(0,-120)",
      "move(40,50)",
      "wheel(0,-120)",
    ]);
  });
});

/**
 * The sharp-at-rest still.
 *
 * The stream is tuned for motion — 10fps of moderate-quality JPEG — which is
 * the wrong trade the moment a page stops moving, because the picture a person
 * actually READS is the one still on screen a second after they stopped
 * scrolling. This is the timer that notices the page went quiet and replaces
 * that picture with a well-encoded one.
 *
 * Every case here fakes the clock BEFORE the session is built: the settle
 * window and the frame throttle both capture `Date.now` at construction.
 */
describe("PlaywrightWebMcpSession settle still", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance past the quiet window and let the still's awaits run. */
  async function goQuiet(extraMs = 0) {
    await vi.advanceTimersByTimeAsync(WEBMCP_SETTLE_QUIET_MS + 500 + extraMs);
  }

  it("publishes one sharp still once the page stops painting", async () => {
    const h = await startedWithFakeClock({
      still: stillAnswer({ [WEBMCP_SETTLE_STILL_QUALITIES[0]]: "sharp" }),
    });
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));

    await goQuiet();

    // At the TOP of the still ladder, above the streaming baseline: motion
    // hides compression artefacts and a still page does not.
    expect(
      h.cdp.sent
        .filter((call) => call.method === "Page.captureScreenshot")
        .map((call) => (call.params as { quality: number }).quality),
    ).toEqual([WEBMCP_SETTLE_STILL_QUALITIES[0]]);
    // Published AFTER the real frame, through the same throttle: the pane
    // replaces the streamed picture with the sharp one, it does not race it.
    expect(h.frames.map((frame) => frame.data)).toEqual(["paint", "sharp"]);
  });

  it("takes ONE still per quiet page, not one per tick", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));

    await goQuiet();
    expect(h.stills).toHaveBeenCalledTimes(1);

    // Still quiet, ten seconds later. Without the latch this would be a
    // screenshot loop for as long as the tab is open.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.stills).toHaveBeenCalledTimes(1);
  });

  it("discards a still a paint overtook while it was in flight", async () => {
    const late = heldStill("late-sharp");
    const h = await startedWithFakeClock({ still: late.still });
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));

    await goQuiet();
    expect(h.stills).toHaveBeenCalledTimes(1);

    // The page paints again while the capture is out. The still now describes
    // an older moment than the pane is showing.
    h.cdp.emit("Page.screencastFrame", screencastFrame("newer"));
    late.release();
    await vi.advanceTimersByTimeAsync(200);

    expect(h.frames.map((frame) => frame.data)).toEqual(["paint", "newer"]);
  });

  it("counts an OVERSIZE paint as activity, so the settle keeps working", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));

    await goQuiet();
    expect(h.stills).toHaveBeenCalledTimes(1);

    // A paint too big for the stream never bumps the ACCEPTED-frame counter.
    // A settle latched on that counter would believe this page had gone quiet
    // for good, and a page whose every paint exceeds the cap would get exactly
    // one sharp still for the life of the session.
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.advanceTimersByTimeAsync(10);
    const afterOversize = h.stills.mock.calls.length;

    await goQuiet();
    expect(h.stills.mock.calls.length).toBeGreaterThan(afterOversize);
    expect(h.stills.mock.calls.map(([params]) => params.quality)).toContain(
      WEBMCP_SETTLE_STILL_QUALITIES[0],
    );
  });

  it("counts INPUT as activity, even when the page paints nothing", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));

    // Most of the quiet window passes, then someone types. The keystroke the
    // page swallowed produced no paint of its own, so only the input stamp can
    // hold the window open — and a still taken now is a round trip spent on a
    // picture that is about to be wrong.
    await vi.advanceTimersByTimeAsync(WEBMCP_SETTLE_QUIET_MS - 100);
    await h.session.dispatchInput([{ kind: "key_down", key: "a" }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.stills).not.toHaveBeenCalled();

    await goQuiet();
    expect(h.stills).toHaveBeenCalledTimes(1);
  });

  it("walks down the ladder when the sharp still does not fit", async () => {
    const oversize = base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1);
    const h = await startedWithFakeClock({
      still: stillAnswer({
        [WEBMCP_SETTLE_STILL_QUALITIES[0]]: oversize,
        [WEBMCP_SETTLE_STILL_QUALITIES[1]]: "smaller",
      }),
    });
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));

    await goQuiet();
    expect(h.stills.mock.calls.map(([params]) => params.quality)).toEqual([
      ...WEBMCP_SETTLE_STILL_QUALITIES,
    ]);
    expect(h.frames.map((frame) => frame.data)).toEqual(["paint", "smaller"]);
  });

  it("publishes nothing when no rung fits", async () => {
    const oversize = base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1);
    const h = await startedWithFakeClock({ still: () => oversize });
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));

    await goQuiet();
    // The pane keeps the picture it has. A frame over the cap is exactly what
    // the client's transport is not allowed to carry.
    expect(h.frames.map((frame) => frame.data)).toEqual(["paint"]);
  });

  it("stops capturing — and stops its timer — when the stream stops", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));
    await goQuiet();
    expect(h.stills).toHaveBeenCalledTimes(1);

    await h.session.setScreencast(false);
    // Not just "no more captures": no timer either. A stream nobody is
    // watching must not leave four wakeups a second behind it.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.stills).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer behind on dispose", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));

    await h.session.dispose();
    // Advanced first, because teardown races each browser close against a
    // five-second timeout of its own. Those are one-shots and are gone by now;
    // an interval left armed would still be here — and would be capturing.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.stills).not.toHaveBeenCalled();
  });

  it("never arms the timer when a stop lands mid-start", async () => {
    // The same race the start/stop ordering test covers, from the settle
    // timer's side: arming unconditionally after the start resolves would
    // leave an interval running on a stream that was withdrawn.
    let releaseStart: (() => void) | undefined;
    const h = await startedWithFakeClock();
    const originalSend = h.cdp.send.bind(h.cdp);
    h.cdp.send = async (method: string, params?: unknown) => {
      const sent = originalSend(method, params);
      if (method === "Page.startScreencast") {
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
      }
      return sent;
    };

    const starting = h.session.setScreencast(true);
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf("function"));
    const stopping = h.session.setScreencast(false);
    releaseStart!();
    await starting;
    await stopping;

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.stills).not.toHaveBeenCalled();
  });
});

/**
 * What a frame says about its own geometry.
 *
 * The client scales every pointer coordinate against these numbers, so a frame
 * that misdescribes itself is not a cosmetic bug: it is every click landing
 * somewhere else. The rule is that the PICTURE decides — the JPEG's own frame
 * header — and that everything else is a fallback for when it cannot be read.
 */
describe("PlaywrightWebMcpSession frame geometry", () => {
  it("reports the dimensions the JPEG itself declares", async () => {
    const h = await started({ devicePixelRatio: 2 });
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", {
      // A capture that came out at two device pixels per CSS pixel. Publishing
      // the metadata's numbers instead would describe this 2560-wide picture
      // as 1280 wide and double every coordinate the client sent back.
      data: jpegBase64(2560, 1600),
      sessionId: 1,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });

    expect(h.frames[0]).toMatchObject({
      deviceWidth: 2560,
      deviceHeight: 1600,
      scale: 2,
    });
  });

  it("ignores the screencast metadata, whose units are not portable", async () => {
    const h = await started({ devicePixelRatio: 2 });
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", {
      data: jpegBase64(1280, 800),
      sessionId: 1,
      // CDP calls this DIP; Chromium 141 headless reports 1280 for a 2x
      // session and the build CI runs reports 2560 for the same one. Dividing
      // the picture's width by it gave a scale of 0.5 there — which would have
      // the client compute a 2560-wide CSS surface and halve every click. The
      // CSS side of the ratio is the viewport this session was CREATED at,
      // which is ours and cannot drift.
      metadata: { deviceWidth: 2560, deviceHeight: 1600 },
    });

    expect(h.frames[0]).toMatchObject({
      deviceWidth: 1280,
      deviceHeight: 800,
      scale: 1,
    });
  });

  it("falls back to the session's own viewport when the bytes cannot be read", async () => {
    const h = await started({ devicePixelRatio: 2 });
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", {
      data: Buffer.from("not-a-jpeg").toString("base64"),
      sessionId: 1,
      metadata: { deviceWidth: 2560, deviceHeight: 1600 },
    });

    // Chromium clamps a screencast to the CSS size of the surface, so the
    // stream's fallback scale is 1 even on a 2x session — and the fallback's
    // job is to stay self-consistent, which is the property clicks depend on.
    expect(h.frames[0]).toMatchObject({
      deviceWidth: WEBMCP_VIEWPORT.width,
      deviceHeight: WEBMCP_VIEWPORT.height,
      scale: 1,
    });
  });

  it("describes a still by its own bytes too", async () => {
    const h = await started({
      devicePixelRatio: 2,
      still: () => jpegBase64(2560, 1600),
    });
    await h.session.setScreencast(true);
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));

    // A still is captured from the surface rather than through the screencast's
    // scaling, so it can arrive at a different scale from the frames around it
    // — which is exactly why the scale rides on the FRAME and not the session.
    expect(h.frames[0]).toMatchObject({
      deviceWidth: 2560,
      deviceHeight: 1600,
      scale: 2,
    });
  });

  it("reports scale 1 for an ordinary session", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    h.cdp.emit("Page.screencastFrame", {
      data: jpegBase64(1280, 800),
      sessionId: 1,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
    expect(h.frames[0]).toMatchObject({
      deviceWidth: 1280,
      deviceHeight: 800,
      scale: 1,
    });
  });
});

/**
 * The adaptive governor.
 *
 * The stream's quality is fixed when the encoder starts, so this is the only
 * thing that can answer a link that cannot carry it — and the failure it exists
 * to prevent is not "the picture is grainy" but "the pane stops moving", which
 * is what a viewer on a tunnel or a remote dev box sees today.
 *
 * Fake clock BEFORE the session, as everywhere in this file: the windows are
 * measured off `Date.now`.
 */
describe("PlaywrightWebMcpSession stream governor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The quality of every `Page.startScreencast` the session has sent. */
  function starts(h: Awaited<ReturnType<typeof started>>): number[] {
    return h.cdp.sent
      .filter((call) => call.method === "Page.startScreencast")
      .map((call) => (call.params as { quality: number }).quality);
  }

  async function pressure(
    h: Awaited<ReturnType<typeof started>>,
    times = WEBMCP_QUALITY_PRESSURE_DROPS,
  ) {
    for (let i = 0; i < times; i += 1) h.session.noteFramePressure();
    // The restart is scheduled, not awaited, by the hot path that reports the
    // drop — so let its awaits run before asserting on the ledger.
    await vi.advanceTimersByTimeAsync(10);
  }

  it("starts at the top of the ladder and says so", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);

    expect(starts(h)).toEqual([WEBMCP_STREAM_QUALITY_LADDER[0]]);
    expect(h.qualities).toEqual([WEBMCP_STREAM_QUALITY_LADDER[0]]);
  });

  it("counts a frame refused by the byte cap as pressure", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);

    // Distinct bytes per paint: identical ones are dropped as redundant
    // BEFORE the size check, so a run built from one payload is a run of one.
    for (let i = 0; i < WEBMCP_QUALITY_PRESSURE_DROPS; i += 1) {
      h.cdp.emit(
        "Page.screencastFrame",
        screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1, 0x41 + i), i),
      );
    }
    await vi.advanceTimersByTimeAsync(10);

    // A frame over the cap reached NO viewer, so nothing downstream is in a
    // position to report it — and a smaller encode is precisely what brings it
    // back under the cap. Deaf to these, the governor sits at the baseline
    // while the page publishes nothing but low-quality substitutes.
    expect(starts(h)).toEqual([
      WEBMCP_STREAM_QUALITY_LADDER[0],
      WEBMCP_STREAM_QUALITY_LADDER[1],
    ]);
    expect(h.qualities).toEqual([
      WEBMCP_STREAM_QUALITY_LADDER[0],
      WEBMCP_STREAM_QUALITY_LADDER[1],
    ]);
  });

  it("steps down after a run of drops, and not before", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);

    // One drop is two paints landing inside one round trip, which happens on
    // any link; a run of them inside two seconds is a consumer falling behind.
    await pressure(h, WEBMCP_QUALITY_PRESSURE_DROPS - 1);
    expect(starts(h)).toEqual([WEBMCP_STREAM_QUALITY_LADDER[0]]);

    await pressure(h, 1);
    expect(starts(h)).toEqual([
      WEBMCP_STREAM_QUALITY_LADDER[0],
      WEBMCP_STREAM_QUALITY_LADDER[1],
    ]);
    // Stopped before it was restarted: one encoder, in the order asked for.
    expect(
      h.cdp
        .methods()
        .filter(
          (method) =>
            method === "Page.startScreencast" ||
            method === "Page.stopScreencast",
        ),
    ).toEqual([
      "Page.startScreencast",
      "Page.stopScreencast",
      "Page.startScreencast",
    ]);
    expect(h.qualities).toEqual([
      WEBMCP_STREAM_QUALITY_LADDER[0],
      WEBMCP_STREAM_QUALITY_LADDER[1],
    ]);
  });

  it("holds a rung against the pressure its own step produced", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);
    await pressure(h);
    expect(starts(h)).toHaveLength(2);

    // The frames already in flight when a step lands are still the old size,
    // so without the hold the governor reads its own transition as more
    // pressure and walks to the bottom of the ladder in one burst.
    await pressure(h);
    await pressure(h);
    expect(starts(h)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);
    await pressure(h);
    expect(starts(h)).toEqual([
      WEBMCP_STREAM_QUALITY_LADDER[0],
      WEBMCP_STREAM_QUALITY_LADDER[1],
      WEBMCP_STREAM_QUALITY_LADDER[2],
    ]);
  });

  it("climbs back a rung at a time once the link goes quiet", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);
    await pressure(h);
    expect(starts(h).at(-1)).toBe(WEBMCP_STREAM_QUALITY_LADDER[1]);

    // Not yet: recovery is deliberately far more patient than the way down,
    // because stepping up is an experiment whose failure costs another stall.
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_RECOVER_QUIET_MS - 1_000);
    expect(starts(h)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(starts(h).at(-1)).toBe(WEBMCP_STREAM_QUALITY_LADDER[0]);
    expect(h.qualities.at(-1)).toBe(WEBMCP_STREAM_QUALITY_LADDER[0]);
  });

  it("stops at the bottom of the ladder", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    for (let i = 0; i < WEBMCP_STREAM_QUALITY_LADDER.length + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);
      await pressure(h);
    }
    expect(starts(h).at(-1)).toBe(
      WEBMCP_STREAM_QUALITY_LADDER[WEBMCP_STREAM_QUALITY_LADDER.length - 1],
    );
    // One start per rung and no more: a link that never recovers must not
    // restart the encoder every two seconds for the life of the session.
    expect(starts(h)).toHaveLength(WEBMCP_STREAM_QUALITY_LADDER.length);
  });

  it("keeps its rung across a disable and re-enable", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);
    await pressure(h);
    expect(starts(h).at(-1)).toBe(WEBMCP_STREAM_QUALITY_LADDER[1]);

    // The client withdraws the stream whenever its tab is hidden and asks
    // again on return. Resetting the rung there would make a session on a slow
    // link re-discover the same pressure at full quality every time somebody
    // switched tabs.
    await h.session.setScreencast(false);
    await h.session.setScreencast(true);
    expect(starts(h).at(-1)).toBe(WEBMCP_STREAM_QUALITY_LADDER[1]);
  });

  it("does not step a stream that is not running", async () => {
    const h = await startedWithFakeClock();
    await pressure(h, 10);
    expect(starts(h)).toEqual([]);
    expect(h.cdp.methods()).not.toContain("Page.stopScreencast");
  });

  it("skips the settle still while the link is already struggling", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);
    await pressure(h);

    h.cdp.emit("Page.screencastFrame", screencastFrame("paint"));
    await vi.advanceTimersByTimeAsync(WEBMCP_SETTLE_QUIET_MS + 500);
    // A link dropping frames does not want a big still on top of the stream it
    // cannot carry — and the skip is LATCHED, so it is not retried every tick
    // until the governor recovers.
    expect(h.stills).not.toHaveBeenCalled();

    // Back at the baseline, the sharp still is worth taking again.
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_RECOVER_QUIET_MS + 1_000);
    h.cdp.emit("Page.screencastFrame", screencastFrame("moved"));
    await vi.advanceTimersByTimeAsync(WEBMCP_SETTLE_QUIET_MS + 500);
    expect(h.stills).toHaveBeenCalledTimes(1);
  });

  it("recovers when the restarted encoder refuses to start", async () => {
    // The failure with nobody to report it to: a rung change stops the
    // encoder, the start that should follow is refused, and the client — which
    // asked for a stream once and was told yes — sits watching a pane that
    // will never update again.
    let refuse = false;
    const h = await startedWithFakeClock({
      onSend: (method) => {
        if (method === "Page.startScreencast" && refuse) {
          throw new Error("Protocol error: target closed");
        }
        return undefined;
      },
    });
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);

    refuse = true;
    for (let i = 0; i < WEBMCP_QUALITY_PRESSURE_DROPS; i += 1) {
      h.session.noteFramePressure();
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(starts(h)).toEqual([
      WEBMCP_STREAM_QUALITY_LADDER[0],
      WEBMCP_STREAM_QUALITY_LADDER[1],
    ]);

    // The browser takes it on the retry.
    refuse = false;
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 500);
    // At the rung that WAS working, not the one the browser just refused: that
    // rung is unproven, and the refusal may well have been about it.
    expect(starts(h).at(-1)).toBe(WEBMCP_STREAM_QUALITY_LADDER[0]);
    // And frames flow again — which is the whole point. Without the retry the
    // pane stays frozen until somebody hides the tab and comes back.
    h.cdp.emit("Page.screencastFrame", screencastFrame("after-recovery"));
    expect(h.frames.map((frame) => frame.data)).toContain("after-recovery");
  });

  it("drops a pending retry when the stream is turned off and on again", async () => {
    let refuse = false;
    const h = await startedWithFakeClock({
      onSend: (method) => {
        if (method === "Page.startScreencast" && refuse) {
          throw new Error("Protocol error: target closed");
        }
        return undefined;
      },
    });
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);

    refuse = true;
    for (let i = 0; i < WEBMCP_QUALITY_PRESSURE_DROPS; i += 1) {
      h.session.noteFramePressure();
    }
    await vi.advanceTimersByTimeAsync(50);

    // The pane goes away and comes back — a tab switch, a remount — and the
    // stream that was refused is over. A retry carried across that would stop
    // and start a perfectly healthy encoder as soon as the hold expired.
    refuse = false;
    await h.session.setScreencast(false);
    await h.session.setScreencast(true);
    const afterReenable = h.cdp.methods().length;

    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 1_000);
    expect(h.cdp.methods().slice(afterReenable)).toEqual([]);
  });

  it("lets a disable that lands mid-restart win", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    await vi.advanceTimersByTimeAsync(WEBMCP_QUALITY_STEP_HOLD_MS + 100);

    // Hold the restart's own start command open, then withdraw the stream
    // underneath it — the pane unmounting while the governor was stepping.
    let releaseStart: (() => void) | undefined;
    const originalSend = h.cdp.send.bind(h.cdp);
    h.cdp.send = async (method: string, params?: unknown) => {
      const sent = originalSend(method, params);
      if (
        method === "Page.startScreencast" &&
        h.cdp.sent.filter((c) => c.method === "Page.startScreencast").length > 1
      ) {
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
      }
      return sent;
    };

    for (let i = 0; i < WEBMCP_QUALITY_PRESSURE_DROPS; i += 1) {
      h.session.noteFramePressure();
    }
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf("function"));
    const stopping = h.session.setScreencast(false);
    releaseStart!();
    await stopping;
    await vi.advanceTimersByTimeAsync(50);

    // Chromium must end STOPPED. A restart that finished after the disable and
    // left the browser encoding would paint into a pane nobody is watching,
    // for as long as the session lived.
    const screencastCalls = h.cdp
      .methods()
      .filter(
        (method) =>
          method === "Page.startScreencast" || method === "Page.stopScreencast",
      );
    expect(screencastCalls.at(-1)).toBe("Page.stopScreencast");
    h.cdp.emit("Page.screencastFrame", screencastFrame("after"));
    expect(h.frames).toHaveLength(0);
  });
});
