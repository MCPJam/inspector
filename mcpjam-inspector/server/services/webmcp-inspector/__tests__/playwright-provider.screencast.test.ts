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
import { PlaywrightWebMcpSession } from "../playwright-provider";
import {
  WEBMCP_FRAME_MAX_BYTES,
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

  // One frame, the main one: the provider's frame sweep must find nothing to
  // attach here rather than nothing to call.
  const mainFrame = { url: () => "https://example.test/" };
  const page = {
    on: () => {},
    goto: async () => {},
    url: () => "https://example.test/",
    evaluate: async () => true,
    screenshot: screenshots,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
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
      quality: 75,
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

describe("inspection delegates capture and input to the shared viewport", () => {
  it("dispatches one CDP call per wheel with modifiers, without Playwright positioning", async () => {
    const h = await started();
    await h.session.dispatchInput([
      {
        kind: "wheel",
        x: 10,
        y: 20,
        deltaX: 0.1,
        deltaY: 15,
        modifiers: { shift: true },
      },
      { kind: "wheel", x: 11, y: 22, deltaX: -0.1, deltaY: 20 },
    ]);
    const calls = h.cdp.sent.filter(
      (call) => call.method === "Input.dispatchMouseEvent",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].params).toMatchObject({
      type: "mouseWheel",
      x: 10,
      y: 20,
      modifiers: 8,
    });
    expect(h.driven).toEqual([]);
  });

  it("drops oversize paints without captures or quality restarts", async () => {
    const h = await startedWithFakeClock();
    await h.session.setScreencast(true);
    for (let i = 0; i < 20; i++) {
      h.cdp.emit(
        "Page.screencastFrame",
        screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1, i)),
      );
      h.session.noteFramePressure();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.frames).toHaveLength(0);
    expect(h.stills).not.toHaveBeenCalled();
    expect(
      h.cdp.methods().filter((method) => method === "Page.startScreencast"),
    ).toHaveLength(1);
  });

  it("follows the pane only for embedded sessions", async () => {
    const h = await started({ viewportMode: "embedded" });
    h.page.setViewportSize = vi.fn().mockResolvedValue(undefined);
    await h.session.resizeViewport(600, 700);
    expect(h.page.setViewportSize).toHaveBeenCalledWith({
      width: 600,
      height: 700,
    });
    expect(h.session.viewportTransport()).toEqual({
      kind: "frame-stream",
      width: 600,
      height: 700,
    });
    const window = await started({ viewportMode: "window" });
    window.page.setViewportSize = vi.fn();
    await window.session.resizeViewport(600, 700);
    expect(window.page.setViewportSize).not.toHaveBeenCalled();
  });
});
