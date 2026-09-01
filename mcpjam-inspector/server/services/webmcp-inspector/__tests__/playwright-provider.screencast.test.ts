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
  WEBMCP_FRAME_QUALITY,
  WEBMCP_VIEWPORT,
  type WebMcpFrame,
} from "@/shared/webmcp-inspector-protocol";
import type { WebMcpSessionCallbacks, WebMcpViewportMode } from "../provider";

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

/** Base64 of `bytes` raw bytes, for exercising the oversize cap. */
function base64OfSize(bytes: number): string {
  return Buffer.alloc(bytes, 0x41).toString("base64");
}

function harness(
  options: {
    viewportMode?: WebMcpViewportMode;
    onSend?: (method: string) => unknown;
    screenshot?: (options?: Record<string, unknown>) => Promise<Buffer>;
  } = {},
) {
  const cdp = new FakeCdp();
  /** ONE ordered log, so "ack came first" is a real assertion, not two counts. */
  const log: string[] = [];
  const frames: WebMcpFrame[] = [];
  // Typed with the options argument Playwright's `page.screenshot` takes, so a
  // test can assert on it — the substitute path's geometry is the whole point
  // of one of them.
  const screenshots = vi.fn<
    (options?: Record<string, unknown>) => Promise<Buffer>
  >(options.screenshot ?? (async () => Buffer.from("tiny-screenshot")));

  const originalSend = cdp.send.bind(cdp);
  cdp.send = async (method: string, params?: unknown) => {
    if (method === "Page.screencastFrameAck") log.push("ack");
    await originalSend(method, params);
    return options.onSend?.(method) ?? {};
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
  );

  return { session, cdp, log, frames, screenshots, driven, page };
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
      quality: WEBMCP_FRAME_QUALITY,
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
      data: "paint",
      sessionId: 1,
      metadata: { deviceWidth: 900, deviceHeight: 500 },
    });
    expect(h.frames[0]).toMatchObject({
      data: "paint",
      deviceWidth: 900,
      deviceHeight: 500,
    });
  });

  it("substitutes a budgeted screenshot for an oversized frame", async () => {
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
    expect(h.frames[0].data).toBe(
      Buffer.from("tiny-screenshot").toString("base64"),
    );
    expect(h.screenshots).toHaveBeenCalledTimes(1);
    // Still acknowledged, before the size was even looked at.
    expect(h.log[0]).toBe("ack");
  });

  it("substitutes a FULL-VIEWPORT capture, never the thumbnail's crop", async () => {
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
    for (const call of h.screenshots.mock.calls) {
      expect(call[0]).not.toHaveProperty("clip");
    }
    expect(h.frames[0]).toMatchObject({
      deviceWidth: WEBMCP_VIEWPORT.width,
      deviceHeight: WEBMCP_VIEWPORT.height,
    });
  });

  it("drops a substitute that a newer frame has already overtaken", async () => {
    // The capture is pinned open rather than made slow: the race this test is
    // about only exists WHILE the screenshot is in flight, and a sleep long
    // enough to make that window likely is also long enough to close early on
    // a loaded machine and pass without ever testing anything.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await started({
      screenshot: async () => {
        await held;
        return Buffer.from("late-shot");
      },
    });
    await h.session.setScreencast(true);
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.waitFor(() => expect(h.screenshots).toHaveBeenCalledTimes(1));

    // A newer paint arrives while the screenshot is still being taken.
    h.cdp.emit("Page.screencastFrame", screencastFrame("newer"));
    release();
    // Everything left in the substitute's path is microtasks, so one turn of
    // the timer queue runs it to its decision — no wall-clock guess.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The substitute is now older than what the pane is showing. Publishing it
    // would drag the picture backwards.
    expect(h.frames.map((frame) => frame.data)).toEqual(["newer"]);
  });

  it("drops a substitute overtaken by a frame still held in the throttle", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await started({
      screenshot: async () => {
        await held;
        return Buffer.from("late-shot");
      },
    });
    await h.session.setScreencast(true);
    // Burn the throttle's leading edge, so the next real frame is HELD in the
    // trailing slot rather than published.
    h.cdp.emit("Page.screencastFrame", screencastFrame("first"));
    h.cdp.emit(
      "Page.screencastFrame",
      screencastFrame(base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1)),
    );
    await vi.waitFor(() => expect(h.screenshots).toHaveBeenCalledTimes(1));

    h.cdp.emit("Page.screencastFrame", screencastFrame("newer"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Nothing new has been PUBLISHED yet — "newer" is inside the throttle,
    // waiting for the window to close. A staleness check counting publications
    // would see no change, let the substitute through, and the throttle would
    // then coalesce the older picture over the newer one: the pane settles on
    // the stale paint and stays there until the page happens to repaint.
    expect(h.frames.map((frame) => frame.data)).toEqual(["first"]);
    await vi.waitFor(
      () =>
        expect(h.frames.map((frame) => frame.data)).toEqual(["first", "newer"]),
      { timeout: 2_000 },
    );
  });

  it("does not queue a screenshot per oversized frame", async () => {
    const h = await started();
    await h.session.setScreencast(true);
    const huge = base64OfSize(WEBMCP_FRAME_MAX_BYTES + 1);
    for (let i = 0; i < 5; i++) {
      h.cdp.emit("Page.screencastFrame", screencastFrame(huge, i));
    }
    await vi.waitFor(() => expect(h.frames.length).toBeGreaterThan(0));
    // Oversized frames arrive in bursts, and a screenshot each would queue CDP
    // round trips behind a page that is already expensive to encode.
    expect(h.screenshots).toHaveBeenCalledTimes(1);
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

  /**
   * Fake timers BEFORE the session is built, deliberately.
   *
   * `createFrameThrottle` captures `Date.now` at construction, so faking the
   * clock afterwards would leave the throttle reading real time while its
   * timers ran on the fake one — and every assertion below would be measuring
   * whatever the machine happened to do.
   */
  async function startedWithFakeClock() {
    vi.useFakeTimers();
    return started();
  }

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
