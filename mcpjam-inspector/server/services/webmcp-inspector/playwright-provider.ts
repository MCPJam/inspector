/**
 * The only module in the inspector that speaks CDP.
 *
 * Everything it knows about Chrome's experimental `WebMCP` domain is asserted
 * against a real browser in `__tests__/webmcp-cdp.spike.test.ts`; when a
 * Chromium bump drifts the protocol, that suite fails with a named expectation
 * rather than this file failing mysteriously in production.
 *
 * Deliberately separate from `utils/mcp-app-browser-harness.ts`. That harness
 * is a hardened *widget* renderer: default-deny networking, `setContent` of a
 * bundled host page, one tab, no navigation. This drives a developer's own site
 * across real navigations. Sharing a class would mean one set of options
 * meaning two different things.
 */
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { existsSync } from "node:fs";
import { ensureLocalChromiumInstalled } from "../../utils/browser-rendering-setup";
import {
  WEBMCP_FRAME_BOOST_INTERVAL_MS,
  WEBMCP_FRAME_BOOST_WINDOW_MS,
  WEBMCP_FRAME_MAX_BYTES,
  WEBMCP_FRAME_MIN_INTERVAL_MS,
  WEBMCP_HOUSEKEEPING_INTERVAL_MS,
  WEBMCP_QUALITY_PRESSURE_DROPS,
  WEBMCP_QUALITY_PRESSURE_WINDOW_MS,
  WEBMCP_QUALITY_RECOVER_QUIET_MS,
  WEBMCP_QUALITY_STEP_HOLD_MS,
  WEBMCP_SETTLE_QUIET_MS,
  WEBMCP_SETTLE_STILL_QUALITIES,
  WEBMCP_STREAM_QUALITY_LADDER,
  WEBMCP_SUBSTITUTE_QUALITY_LADDER,
  WEBMCP_VIEWPORT,
  type WebMcpFrame,
  type WebMcpInputEvent,
  type WebMcpInputModifiers,
  type WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";
import { readJpegDimensions } from "@/shared/jpeg-dimensions";
import { createFrameThrottle, type FrameThrottle } from "./frame-throttle";
import { logger } from "../../utils/logger.js";
import {
  buildWebMcpLaunchArgs,
  PAGE_API_PROBE,
  webMcpHeadlessRequested,
} from "./launch-args";
import { WebMcpBridge, type CdpLike } from "../browserd/daemon/webmcp-bridge";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_WIDTH,
  translateBridgeError,
} from "./provider-shared";
import {
  WebMcpChromiumNotInstalledError,
  WebMcpNoDisplayError,
  WebMcpUnsupportedError,
  type CreateWebMcpSessionOptions,
  type WebMcpBrowserProvider,
  type WebMcpBrowserSession,
  type WebMcpInvokeRequest,
  type WebMcpSessionCallbacks,
  type WebMcpViewportMode,
} from "./provider";

/** Cap on how long a browser teardown may block shutdown. */
const CLOSE_TIMEOUT_MS = 5_000;
/**
 * How much of a frame's base64 to decode when reading its SOF marker.
 *
 * A prefix, because the answer is in the first few hundred bytes and decoding
 * a 200 KiB base64 string per frame to read four of them would be a per-frame
 * allocation the size of the frame. A multiple of 4 so the slice is a whole
 * number of base64 groups.
 */
const JPEG_PROBE_BASE64_CHARS = 4_096;
/** The modifier keys a pointer event's snapshot can name, in Playwright's spelling. */
const MODIFIER_KEYS = ["Alt", "Control", "Meta", "Shift"] as const;

/**
 * The one CDP payload this file still names.
 *
 * Everything the WebMCP domain declares — tools, responses, invocations — lives
 * in `webmcp-bridge.ts` now. The screencast is a Page-domain concern and stays
 * here with the rest of the viewport.
 */
interface CdpScreencastFrame {
  data: string;
  sessionId: number;
  metadata?: {
    deviceWidth?: number;
    deviceHeight?: number;
    timestamp?: number;
  };
}

/** As in the widget harness: a hung close must not block shutdown. */
async function waitForClose(promise: Promise<unknown> | undefined) {
  if (!promise) return;
  await Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ]);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "about:blank";
  }
}

/**
 * Exported for `__tests__/playwright-provider.screencast.test.ts`, which drives
 * the CDP wiring with fakes. The screencast path is the one part of this file
 * whose ordering (ack before anything else) cannot be observed from the
 * provider's public surface, and the Chromium-gated integration suite only runs
 * where a WebMCP-capable build exists.
 */
export class PlaywrightWebMcpSession implements WebMcpBrowserSession {
  /**
   * The WebMCP state machine, shared with the daemon.
   *
   * ONE copy of it now. This file used to carry its own — tool map, frame map,
   * pending invocations, cancel-reason bookkeeping — beside an identical one in
   * `browserd/daemon/webmcp-bridge.ts`, and every hard-won behaviour in it (a
   * navigation fires no `toolsRemoved`; the browser answers every cancel
   * `Canceled` whatever the reason; a cancel the page never answers must still
   * settle) had to be fixed twice or drift. The bridge imports nothing, so
   * Playwright's `CDPSession` satisfies its `CdpLike` structurally and this is
   * a plain instantiation.
   *
   * What stays HERE is everything outside the WebMCP domain: the screencast,
   * input dispatch, navigation, screenshots and lifecycle.
   */
  private readonly bridge: WebMcpBridge;
  private url: string;
  private disposed = false;
  /** Whether the browser is currently painting frames at us. */
  private screencasting = false;
  private readonly frameThrottle: FrameThrottle<WebMcpFrame>;
  /** One in-flight still at a time; see `publishStill`. */
  private stillInFlight = false;
  /**
   * An oversize frame arrived while a still was already being captured.
   *
   * Remembered rather than dropped, because oversize frames come in BURSTS: the
   * page paints five times while one capture is in flight, and every one of
   * them is refused by the single-flight guard. Without this the pane would
   * settle on the picture that happened to be current when the first of the
   * burst arrived, which is the oldest of them.
   */
  private oversizePending = false;
  /**
   * Every frame the browser has handed us, oversize ones INCLUDED.
   *
   * Distinct from `framesReceived` on purpose. This is the settle latch's
   * clock, and it has to count paints the stream could not carry: a page whose
   * every paint exceeds the cap never bumps `framesReceived`, so a latch keyed
   * on that would take one settle still and then believe the page had gone
   * quiet forever.
   */
  private paintsSeen = 0;
  /** When the last paint arrived; the quiet window is measured from it. */
  private lastPaintAt = -Infinity;
  /**
   * When input was last dispatched.
   *
   * Part of the same quiet window, because a gesture that changes nothing on
   * screen — a click on dead space, a key the page swallows — produces no paint
   * to reset the window with, and taking a full-quality still in the middle of
   * someone typing spends a CDP round trip on a picture that is about to be
   * wrong.
   */
  private lastInputAt = -Infinity;
  /**
   * The `paintsSeen` value the last settle still was taken for.
   *
   * The latch that makes it ONE still per quiet page rather than one every
   * housekeeping tick: an idle page stays quiet indefinitely, and re-capturing
   * it four times a second would be a screenshot loop nobody asked for.
   */
  private settleGeneration = -1;
  /** Drives the settle window. Armed with the stream, cleared with it. */
  private housekeeping?: ReturnType<typeof setInterval>;
  /**
   * The bytes of the last screencast frame, for the redundancy check in
   * `wireScreencast`.
   *
   * One string reference, not a copy: the frame is allocated either way, and
   * holding the newest one until the next arrives costs a delayed collection.
   */
  private lastFrameData: string | undefined;
  /**
   * Which rung of {@link WEBMCP_STREAM_QUALITY_LADDER} the stream is on.
   *
   * PERSISTS across `setScreencast` cycles, deliberately. The client withdraws
   * the stream whenever its tab is hidden and asks for it again on return, and
   * a rung reset per cycle would make a session on a slow link re-discover the
   * same pressure at full quality every time somebody switched tabs.
   */
  private rungIndex = 0;
  /** Recent drops, for the "3 inside 2 seconds" test. */
  private dropTimestamps: number[] = [];
  /** The last drop of any kind, for the much longer recovery quiet window. */
  private lastDropAt = -Infinity;
  /** When the rung last moved, for the hold that keeps steps apart. */
  private lastRungChangeAt = -Infinity;
  /** A stop/start cycle is in flight; a second one would race it. */
  private restartInFlight = false;
  /**
   * Monotonic count of frames ACCEPTED from the browser, for a still's
   * staleness check.
   *
   * Counted on receipt rather than on publication, because the throttle holds
   * the newest frame of a burst in its trailing slot without emitting it yet.
   * A still compared against a published count would sail past that check
   * and overwrite a newer frame that had simply not been flushed — and if no
   * later paint arrived, the pane would settle on the older picture.
   */
  private framesReceived = 0;
  /** Modifier keys Playwright currently believes are down. See `syncModifiers`. */
  private readonly heldModifiers = new Set<string>();
  /**
   * Where Playwright's virtual pointer was last put, so a `mouse.move` that
   * would change nothing can be skipped. Forgotten on navigation: a new
   * document starts with no hover state, and skipping the move into it would
   * leave the page believing the pointer had never arrived.
   */
  private pointerAt: { x: number; y: number } | undefined;
  /**
   * Bumped by every main-frame navigation, so a `mouse.move` still in flight
   * when the page changes cannot write its coordinate back afterwards.
   * Clearing `pointerAt` alone is not enough: the clear happens during the
   * await, and the assignment after it would restore a coordinate that
   * describes the previous document.
   */
  private pointerGeneration = 0;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly callbacks: WebMcpSessionCallbacks,
    startUrl: string,
    private readonly headless: boolean,
    private readonly viewportMode: WebMcpViewportMode = "window",
    /**
     * Device pixels per CSS pixel this session's context renders at.
     *
     * Read back onto every frame rather than trusted: what the browser
     * actually hands over is what the client has to scale clicks against.
     */
    private readonly dpr: number = 1,
  ) {
    this.url = startUrl;
    this.frameThrottle = createFrameThrottle<WebMcpFrame>({
      minIntervalMs: WEBMCP_FRAME_MIN_INTERVAL_MS,
      emit: (frame) => this.callbacks.onFrame(frame),
    });
    this.bridge = new WebMcpBridge(cdp as unknown as CdpLike, {
      // The bridge's descriptors are already the raw browser facts this
      // interface asks for, frame id included, so the snapshot passes straight
      // through. Identity policy — stable keys, collision suffixes — is the
      // runtime's, one layer up, because that is the layer that sees the whole
      // registry at once.
      onChange: (tools) => this.callbacks.onToolsChanged(tools),
      onExternalInvocation: (toolName) =>
        this.callbacks.onExternalInvocation(
          "A tool was invoked from outside this inspector.",
          toolName || undefined,
        ),
    });
  }

  async start(url: string): Promise<void> {
    // Wired BEFORE the bridge, so its `Page.frameNavigated` handler runs first
    // and the runtime still sees `navigated` ahead of the tool snapshot the
    // bridge publishes from the same event. CDP dispatches handlers in
    // registration order, and the timeline reads badly the other way round.
    this.wireNavigation();
    this.wireScreencast();
    this.wirePage();
    // The first navigation happens INSIDE the bridge's probe callback, because
    // both of its neighbours pin it there: the domains must be enabled first or
    // tools registered during page load are never reported, and the page must
    // be loaded before `document.modelContext` can be asked about — the domain
    // is never the probe, since `WebMCP.enable` resolves even where the feature
    // is switched off.
    //
    // The bridge treats a throwing probe as "unsupported", which is right for a
    // probe and wrong for a navigation: a DNS failure or a refused connection
    // would be reported as "this browser cannot do WebMCP" and send someone
    // chasing a browser problem they do not have. So the navigation's own
    // failure is carried out and rethrown as itself.
    let navigationFailure: unknown;
    await this.bridge.start(async () => {
      try {
        await this.navigate(url);
      } catch (error) {
        navigationFailure = error;
        return false;
      }
      return (
        (await this.page.evaluate(PAGE_API_PROBE).catch(() => false)) === true
      );
    });
    if (navigationFailure) throw navigationFailure;
    // Before the unsupported check: an embedded session has no window, so the
    // stream is the ONLY view of it. A page that turns out to have no WebMCP
    // support still deserves to be visible while the person reads why.
    if (this.viewportMode === "embedded") await this.setScreencast(true);
    // Detected HERE rather than left to the bridge's own per-invocation
    // refusal, so creating a session on a browser that cannot do WebMCP fails
    // immediately with an explanation instead of succeeding into an empty tool
    // list that looks like the page's fault.
    if (!this.bridge.isSupported()) {
      throw new WebMcpUnsupportedError(
        "This browser build does not expose the WebMCP page API " +
          "(document.modelContext), so no tools can be discovered. The page " +
          "itself loaded normally; check that the page is origin-isolated, " +
          "the WebMCP tools Permissions Policy is allowed, and the feature is " +
          "enabled for this origin.",
      );
    }
  }

  /**
   * The one Page-domain fact this class still needs for itself: where we are.
   *
   * The bridge watches the same event for its own bookkeeping — it has to, to
   * drop a navigated frame's tools — but the main-frame URL is a session fact,
   * not a WebMCP one, so it is read here rather than routed back out of the
   * bridge.
   */
  private wireNavigation(): void {
    this.cdp.on("Page.frameNavigated", (event) => {
      const { frame } = event as {
        frame: { id: string; url: string; parentId?: string };
      };
      if (frame.parentId) return;
      this.url = frame.url;
      // A new document has no hover state, so the remembered coordinate no
      // longer describes anything. Keeping it would let the wheel path skip
      // the move that first tells the new page where the pointer is.
      this.pointerAt = undefined;
      this.pointerGeneration += 1;
      this.callbacks.onNavigated(frame.url, originOf(frame.url));
    });
  }

  private wireScreencast(): void {
    this.cdp.on("Page.screencastFrame", (event) => {
      const frame = event as CdpScreencastFrame;
      // ACK FIRST, before any size check, throttling or publishing. Chromium
      // sends the NEXT frame only once the current one is acknowledged, so an
      // ack that waits on consumption lets a slow consumer starve the stream
      // into stillness — and the pane would then show a page frozen at whatever
      // it looked like when the consumer fell behind.
      void this.cdp
        .send(
          "Page.screencastFrameAck" as never,
          {
            sessionId: frame.sessionId,
          } as never,
        )
        .catch(() => {});

      // A frame already in flight when the stream was stopped. Publishing it
      // would repaint a pane the client has just cleared, with a picture
      // nothing is going to correct afterwards.
      if (!this.screencasting || this.disposed) return;

      // Counted BEFORE the size check, and that ordering is the whole reason
      // this counter is not `framesReceived`. A paint the stream cannot carry
      // is still a paint: it means the page is busy, and the settle window has
      // to restart from it.
      // A frame whose bytes are identical to the one before it carries no
      // news, and dropping it is not an optimisation — it is what makes the
      // settle still work at all.
      //
      // EVERY `Page.captureScreenshot` makes Chromium produce a compositor
      // frame to satisfy the copy request, and the screencast then encodes and
      // sends that frame: on an idle page it is byte-for-byte the frame before
      // it (measured against Chromium 141 headless — one induced frame per
      // capture, identical bytes, and none at all while merely idle). Publish
      // it and the sharp still we just took is replaced a tenth of a second
      // later by the same picture at streaming quality; count it as a paint and
      // the settle clock restarts, so the next quiet window takes another
      // still, which induces another frame — a capture loop on a page that is
      // doing nothing.
      //
      // The comparison is exact rather than a heuristic window: JPEG encoding
      // is deterministic, so identical bytes mean identical pixels. A page that
      // really did paint something produces different bytes and is treated as
      // the activity it is.
      if (frame.data === this.lastFrameData) return;
      this.lastFrameData = frame.data;

      this.paintsSeen += 1;
      this.lastPaintAt = Date.now();

      // A frame is transient — the next paint replaces it — so an oversized one
      // is dropped rather than re-encoded in the hot path. But the throttle's
      // trailing-frame guarantee does not cover THIS drop, so a complex page
      // whose final paint never fits would leave the pane stale forever.
      // Converge it with one budgeted still instead: lower fidelity, but the
      // current paint.
      const bytes = Buffer.byteLength(frame.data, "base64");
      if (bytes > WEBMCP_FRAME_MAX_BYTES) {
        void this.publishStill(WEBMCP_SUBSTITUTE_QUALITY_LADDER, "oversize");
        return;
      }

      this.framesReceived += 1;
      this.frameThrottle.push({
        data: frame.data,
        // The metadata's dimensions are the surface in CSS pixels; the frame's
        // own header says how many device pixels that came out as.
        ...this.frameGeometry(
          frame.data,
          {
            width: frame.metadata?.deviceWidth ?? WEBMCP_VIEWPORT.width,
            height: frame.metadata?.deviceHeight ?? WEBMCP_VIEWPORT.height,
          },
          this.streamScale(),
        ),
        ts: Date.now(),
      });
    });
  }

  /**
   * What a published frame should say about its own geometry.
   *
   * Read from the JPEG's own frame header wherever possible, because every
   * other source is a claim by something that is not the picture: CDP reports
   * screencast metadata in DIP whatever the device scale factor is, a frame
   * can still be in flight from a cast started with different bounds, and the
   * `sessionId` on a screencast frame is a counter rather than an identity. The
   * client scales pointer coordinates against what a frame reports, so a frame
   * that misdescribes itself puts every click in the wrong place.
   *
   * `dip` is the surface in CSS pixels; `expectedScale` is what this capture
   * path would produce if the bytes cannot be read. The fallback keeps the
   * geometry self-consistent rather than exact — which is the property clicks
   * actually depend on.
   */
  private frameGeometry(
    data: string,
    dip: { width: number; height: number },
    expectedScale: number,
  ): { deviceWidth: number; deviceHeight: number; scale: number } {
    const sof = readJpegDimensions(
      Buffer.from(data.slice(0, JPEG_PROBE_BASE64_CHARS), "base64"),
    );
    if (sof && dip.width > 0) {
      return {
        deviceWidth: sof.width,
        deviceHeight: sof.height,
        // Three decimals: enough for the ratios a real display reports
        // (1.25, 1.5, 1.75, 2) and for the wire's fixed-point field.
        scale: Math.round((sof.width / dip.width) * 1_000) / 1_000,
      };
    }
    return {
      deviceWidth: Math.round(dip.width * expectedScale),
      deviceHeight: Math.round(dip.height * expectedScale),
      scale: expectedScale,
    };
  }

  /**
   * The scale the STREAM is currently producing.
   *
   * Chromium clamps a screencast to the CSS-pixel size of the surface —
   * `Page.startScreencast`'s `maxWidth`/`maxHeight` can only ever scale a
   * capture DOWN — so a session rendering at a device pixel ratio of 2 still
   * receives 1280x800 frames, supersampled from a 2560x1600 raster. Measured
   * against Chromium 141 headless, and the reason this is 1 rather than
   * `this.dpr`: the frame's own bytes decide, and this is only the fallback
   * when they cannot be read.
   */
  private streamScale(): number {
    return 1;
  }

  /**
   * One still of the current surface, as a base64 JPEG.
   *
   * Raw `Page.captureScreenshot` rather than Playwright's `page.screenshot()`,
   * and the difference is not stylistic. Playwright's default `caret: "hide"`
   * writes an inline `caret-color` onto every input, textarea and
   * contenteditable in the document and restores it afterwards — two style
   * mutations, which paint. Those paints reach the screencast handler, bump
   * the counters this file's staleness checks read, and the still then
   * discards ITSELF as overtaken. Reading the compositor surface instead
   * touches no DOM at all.
   *
   * NO `clip`, ever. A clip is in document coordinates and goes through an
   * emulation path that can relayout and paint — the same self-defeating
   * mutation — and a cropped picture published as a full viewport would stretch
   * part of the page across the pane and put every click at the wrong
   * coordinate. This degrades QUALITY only, never geometry.
   */
  private async captureStill(quality: number): Promise<string | undefined> {
    try {
      const result = (await this.cdp.send(
        "Page.captureScreenshot" as never,
        {
          format: "jpeg",
          quality,
          // The compositor's own surface: no relayout, no paint, and the
          // picture the person is actually looking at.
          fromSurface: true,
        } as never,
      )) as { data?: string };
      return typeof result?.data === "string" ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Publish one still as a frame, walking `qualities` until one fits the cap.
   *
   * TWO callers, ONE slot, deliberately. An oversize frame asks for a still
   * because the page's own paint could not be carried; the settle timer asks
   * for a sharp one because the page has stopped painting. Two independent
   * single-flight captures would race — a low-quality substitute landing after
   * a sharp settle still would overwrite the good picture with a worse one of
   * the same frozen page — so both go through here and at most one is ever in
   * flight.
   *
   * The generation check is against `framesReceived` (ACCEPTED frames), not
   * `paintsSeen`: what makes a still stale is a real frame the pane is already
   * showing, or one held in the throttle's trailing slot about to be shown.
   *
   * A capture that FAILS publishes nothing and does not fall down the ladder:
   * the pane keeps the picture it has, which is the same outcome as before and
   * strictly better than a wrong-geometry frame.
   */
  private async publishStill(
    qualities: readonly number[],
    reason: "oversize" | "settle",
  ): Promise<void> {
    if (this.disposed || !this.screencasting) return;
    if (this.stillInFlight) {
      // Only the oversize path re-runs: the settle path has its own latch and
      // its own timer, and will simply try again on the next tick.
      if (reason === "oversize") this.oversizePending = true;
      return;
    }
    this.stillInFlight = true;
    const generation = this.framesReceived;
    try {
      for (const quality of qualities) {
        const data = await this.captureStill(quality);
        // Re-checked after EVERY await: a still that lands behind a real frame
        // would drag the pane backwards to an older picture.
        if (this.disposed || !this.screencasting) return;
        if (this.framesReceived !== generation) return;
        if (data === undefined) return;
        if (Buffer.byteLength(data, "base64") > WEBMCP_FRAME_MAX_BYTES) {
          continue;
        }
        this.frameThrottle.push({
          data,
          // A still is captured from the surface itself rather than through the
          // screencast's scaling, so its expected scale is the session's own
          // device pixel ratio — and, as everywhere else, the bytes win.
          ...this.frameGeometry(data, WEBMCP_VIEWPORT, this.dpr),
          ts: Date.now(),
        });
        return;
      }
    } finally {
      this.stillInFlight = false;
      const rerun = this.oversizePending;
      this.oversizePending = false;
      // One trailing re-capture, not one per refused frame: a burst of
      // oversize paints converges on the LAST of them with exactly two
      // captures, however many arrived in between.
      if (rerun) {
        void this.publishStill(WEBMCP_SUBSTITUTE_QUALITY_LADDER, "oversize");
      }
    }
  }

  /**
   * Arm the housekeeping timer, which is what notices a page has gone quiet.
   *
   * Idempotent, and armed only while frames are actually flowing: a timer left
   * running on a stopped stream would capture stills for a pane nobody is
   * watching.
   */
  private armHousekeeping(): void {
    if (this.housekeeping !== undefined) return;
    this.housekeeping = setInterval(
      () => this.housekeepingTick(),
      WEBMCP_HOUSEKEEPING_INTERVAL_MS,
    );
    // Never a reason to hold the process open.
    this.housekeeping.unref?.();
  }

  private clearHousekeeping(): void {
    if (this.housekeeping === undefined) return;
    clearInterval(this.housekeeping);
    this.housekeeping = undefined;
  }

  private housekeepingTick(): void {
    if (!this.screencasting || this.disposed) return;
    // The governor first: a rung change decides whether the settle still is
    // worth taking at all, and reading a stale rung here would spend a big
    // capture on a link that has just told us it cannot carry one.
    this.governorTick();
    this.settleTick();
  }

  /**
   * Publish one SHARP still once the page has stopped painting.
   *
   * The stream is tuned for motion: 10fps of moderate-quality JPEG, which is
   * the right trade while something is moving and the wrong one the moment it
   * stops. What a person actually reads is the picture that is still there a
   * second after they stopped scrolling, and this replaces it with one encoded
   * well above the streaming baseline.
   *
   * KNOWN GAP: a focused text field blinks its caret at about 2Hz, so the
   * quiet window never arrives while someone is typing into one. The still
   * fires when focus leaves. Accepted rather than worked around — suppressing
   * caret paints means telling the page not to draw a caret, which is a visible
   * change to what the person is looking at.
   */
  private settleTick(): void {
    // Nothing has ever painted, or nothing has painted since the last still.
    if (this.paintsSeen === 0 || this.paintsSeen === this.settleGeneration) {
      return;
    }
    // An oversize still is already running. Bailing BEFORE the latch is the
    // point: latching here and then being refused by `publishStill`'s
    // single-flight guard would lose the sharp still until the next paint.
    if (this.stillInFlight) return;
    const quietSince = Math.max(this.lastPaintAt, this.lastInputAt);
    if (Date.now() - quietSince < WEBMCP_SETTLE_QUIET_MS) return;
    // A link that is already dropping frames does not want a 200 KiB still on
    // top of the stream it cannot carry. Latched all the same, so the still is
    // SKIPPED for this quiet page rather than retried every tick until the
    // governor recovers.
    if (this.rungIndex > 0) {
      this.settleGeneration = this.paintsSeen;
      return;
    }
    // Latched BEFORE the await, so an idle page gets ONE still per paint
    // generation rather than one per tick.
    this.settleGeneration = this.paintsSeen;
    void this.publishStill(WEBMCP_SETTLE_STILL_QUALITIES, "settle");
  }

  /** The quality the stream is encoding at right now. */
  private rungQuality(): number {
    return (
      WEBMCP_STREAM_QUALITY_LADDER[this.rungIndex] ??
      WEBMCP_STREAM_QUALITY_LADDER[WEBMCP_STREAM_QUALITY_LADDER.length - 1]!
    );
  }

  /**
   * A viewer's transport could not take a frame.
   *
   * The one thing this provider cannot observe for itself: it publishes into a
   * fan-out and never learns what became of a frame. Three of these inside two
   * seconds is a link that cannot carry the stream at this quality — one is
   * just two paints landing inside one round trip, which happens on any link.
   *
   * Called on the hot path, from inside a socket's send callback, so it does
   * arithmetic and returns; the restart it may schedule is not awaited here.
   */
  noteFramePressure(): void {
    const now = Date.now();
    this.lastDropAt = now;
    this.dropTimestamps.push(now);
    this.dropTimestamps = this.dropTimestamps.filter(
      (at) => now - at <= WEBMCP_QUALITY_PRESSURE_WINDOW_MS,
    );
    if (this.dropTimestamps.length < WEBMCP_QUALITY_PRESSURE_DROPS) return;
    // The frames already in flight when a step lands are still the old size,
    // so a governor without this hold would read its own transition as more
    // pressure and fall to the bottom of the ladder in one burst.
    if (now - this.lastRungChangeAt < WEBMCP_QUALITY_STEP_HOLD_MS) return;
    if (this.rungIndex >= WEBMCP_STREAM_QUALITY_LADDER.length - 1) return;
    if (!this.screencasting || this.disposed || this.restartInFlight) return;
    this.rungIndex += 1;
    this.lastRungChangeAt = now;
    // Cleared, not kept: the drops that justified this step must not also
    // justify the next one.
    this.dropTimestamps = [];
    void this.restartScreencast();
  }

  /**
   * Climb back toward the baseline once the link has been quiet for a while.
   *
   * Much more patient than the way down, and asymmetric on purpose: stepping
   * down answers something a person is watching happen, while stepping up is
   * an experiment whose failure costs them another stall.
   */
  private governorTick(): void {
    if (this.rungIndex === 0 || this.restartInFlight) return;
    const now = Date.now();
    if (now - this.lastDropAt < WEBMCP_QUALITY_RECOVER_QUIET_MS) return;
    if (now - this.lastRungChangeAt < WEBMCP_QUALITY_STEP_HOLD_MS) return;
    this.rungIndex -= 1;
    this.lastRungChangeAt = now;
    void this.restartScreencast();
  }

  /**
   * Re-encode at the current rung, without ever changing whether we are
   * streaming.
   *
   * The screencast's quality is fixed when it starts, so a rung change is a
   * stop and a start. Everything about that is a race with the client's own
   * enable/disable, so the flags are re-read after every await and a start that
   * lost the race is compensated with a stop — the alternative is a browser
   * left encoding frames for a pane that has gone.
   *
   * `frameThrottle` is deliberately untouched: an in-flight boost belongs to
   * the person's gesture, not to the encoder's settings, and resetting it here
   * would drop the rate back to 10fps in the middle of a scroll.
   */
  private async restartScreencast(): Promise<void> {
    if (this.restartInFlight || this.disposed || !this.screencasting) return;
    this.restartInFlight = true;
    try {
      await this.cdp.send("Page.stopScreencast" as never).catch(() => {});
      // The first frame of the restarted cast is the current picture again,
      // and it must not be dropped as a duplicate of the last frame of the
      // previous one — that frame is what the pane is waiting for.
      this.lastFrameData = undefined;
      if (this.disposed || !this.screencasting) return;
      // No compensating stop after this: CDP commands reach the browser in the
      // order they are SENT, and there is no await between the check above and
      // the send inside — so a disable racing this either arrives before the
      // check (and is caught by it) or after the start (and stops it). The
      // browser cannot end up streaming into a pane that has gone.
      await this.sendStartScreencast();
    } finally {
      this.restartInFlight = false;
    }
  }

  /**
   * Ask the browser to start painting at the current rung.
   *
   * Reports failure by clearing `screencasting` rather than throwing, which is
   * what lets the client fall back to polling screenshots on a browser that
   * cannot screencast at all.
   */
  private async sendStartScreencast(): Promise<void> {
    const quality = this.rungQuality();
    await this.cdp
      .send(
        "Page.startScreencast" as never,
        {
          format: "jpeg",
          quality,
          // Not multiplied by the session's device pixel ratio: Chromium
          // clamps a screencast to the CSS size of the surface, so asking for
          // more is a no-op that only makes this line look like a promise.
          maxWidth: WEBMCP_VIEWPORT.width,
          maxHeight: WEBMCP_VIEWPORT.height,
        } as never,
      )
      .catch((error) => {
        // Reported, not thrown. The caller turns `false` into the screenshot
        // fallback; a throw would be an error banner on a session whose only
        // problem is that this browser cannot screencast.
        this.screencasting = false;
        logger.debug("[webmcp] could not start the screencast", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    if (this.screencasting && !this.disposed) {
      this.callbacks.onStreamQualityChanged?.(quality);
    }
  }

  private wirePage(): void {
    this.page.on("popup", (popup) => {
      // Left open on purpose: closing a popup, or re-hosting its URL in the
      // main tab, breaks OAuth and anything using window.opener. We report it
      // and stay out of the way. Its tools belong to a separate target and are
      // out of V1 scope.
      const report = (url: string) => this.callbacks.onPopupOpened(url);
      popup
        .waitForLoadState("domcontentloaded", { timeout: 3_000 })
        .then(() => report(popup.url()))
        .catch(() => report(popup.url()));
    });
    this.page.on("crash", () =>
      this.callbacks.onCrashed("The browser page crashed."),
    );
    this.page.on("close", () => {
      if (!this.disposed) this.callbacks.onCrashed("The browser was closed.");
    });
    // A human driving the window keeps the session alive even while the
    // inspector tab is closed.
    this.page.on("framenavigated", () => this.callbacks.onActivityObserved());
    this.page.on("console", () => this.callbacks.onActivityObserved());
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    this.url = this.page.url();
    this.callbacks.onActivityObserved();
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    this.url = this.page.url();
  }

  async goBack(): Promise<void> {
    await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
    this.url = this.page.url();
  }

  /**
   * Run a page tool, translating the bridge's vocabulary into this interface's.
   *
   * The translation is the whole job here, and each mapping matters to someone
   * reading the timeline afterwards: `webmcp_tool_gone` is "the page moved on",
   * a cancel carries WHY it was cancelled (the browser's own answer never
   * says), and the daemon's `{invocationId, output}` envelope loses its id
   * because the runtime already has its own handle for this call.
   */
  async invokeTool(request: WebMcpInvokeRequest): Promise<{ output: unknown }> {
    try {
      const { output } = await this.bridge.invoke({
        toolName: request.toolName,
        // The frame the runtime resolved from its own registry, so a subframe's
        // tool is not shadowed by a same-named one in the main frame.
        ...(request.frameId ? { frameId: request.frameId } : {}),
        input: request.input,
        // Handing the signal over also hands the DEADLINE over: the bridge
        // stops arming its own, so the runtime stays the single owner of what
        // "too long" means and a timeout is not reported as a user cancel.
        signal: request.signal,
      });
      return { output };
    } catch (error) {
      throw translateBridgeError(error, request.toolName);
    }
  }

  async captureScreenshot(): Promise<string | undefined> {
    try {
      const buffer = await this.page.screenshot({
        type: "jpeg",
        quality: 50,
        timeout: 5_000,
      });
      if (buffer.byteLength <= SCREENSHOT_MAX_BYTES) {
        return buffer.toString("base64");
      }
      // One retry at a smaller size. A frame that still will not fit the budget
      // is dropped: the timeline can say "no screenshot", but it must not carry
      // multi-megabyte entries.
      const smaller = await this.page.screenshot({
        type: "jpeg",
        quality: 30,
        clip: {
          x: 0,
          y: 0,
          width: SCREENSHOT_WIDTH,
          height: Math.round(
            (SCREENSHOT_WIDTH * WEBMCP_VIEWPORT.height) / WEBMCP_VIEWPORT.width,
          ),
        },
        timeout: 5_000,
      });
      return smaller.byteLength > SCREENSHOT_MAX_BYTES
        ? undefined
        : smaller.toString("base64");
    } catch {
      return undefined;
    }
  }

  currentUrl(): string {
    return this.url;
  }

  /**
   * Apply a batch of input to the page, in order.
   *
   * Driven through Playwright's `page.mouse` / `page.keyboard` rather than raw
   * `Input.dispatchMouseEvent` / `dispatchKeyEvent`. Those primitives take a
   * modifier bitmask, a `text`/`unmodifiedText` pair, a `windowsVirtualKeyCode`
   * and a `code`, all of which have to be derived per key and per layout —
   * Playwright already carries that table, along with modifier state tracking
   * and click counting. Reimplementing it here would be reimplementing it
   * WRONGLY, quietly, for every key that is not a letter.
   *
   * Each event is applied under its own try/catch. One exotic key that
   * Playwright refuses to map must not swallow the click queued behind it — a
   * batch is a person's gesture, and losing the rest of it is far more visible
   * than losing the one event that failed.
   */
  async dispatchInput(events: WebMcpInputEvent[]): Promise<void> {
    if (this.disposed) return;
    // Part of the settle window, and stamped even when nothing is streaming:
    // a gesture that changes nothing on screen produces no paint to push the
    // window out with, and a still taken mid-gesture is a round trip spent on
    // a picture that is about to be wrong.
    this.lastInputAt = Date.now();
    // BEFORE the first awaited operation, not after it. The paint caused by
    // the very first event of a batch can reach the screencast handler while
    // this method is still awaiting, and a boost applied afterwards would
    // arrive too late to speed up the one frame the person is actually
    // waiting to see.
    //
    // NOT gated on who is watching: input arriving IS the signal that a human
    // wants to see the result, and that is as true for a client on the SSE
    // stream — the ones that felt the lag — as for one on the socket. Gating
    // it would need subscriber state plumbed from the transport down into the
    // provider, which is a coupling this layering exists to avoid.
    if (this.screencasting) {
      this.frameThrottle.boost(
        WEBMCP_FRAME_BOOST_INTERVAL_MS,
        WEBMCP_FRAME_BOOST_WINDOW_MS,
      );
    }
    for (const event of events) {
      try {
        await this.applyInput(event);
      } catch (error) {
        logger.debug("[webmcp] could not apply an input event", {
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Move the virtual pointer, remembering where it ended up.
   *
   * `skipIfUnchanged` is for the wheel path: a scroll is a run of wheels at
   * one coordinate and each move is an awaited CDP round trip, so the ones
   * after the first buy nothing.
   */
  private async moveTo(
    x: number,
    y: number,
    skipIfUnchanged = false,
  ): Promise<void> {
    const [clampedX, clampedY] = this.clamp(x, y);
    if (
      skipIfUnchanged &&
      this.pointerAt?.x === clampedX &&
      this.pointerAt?.y === clampedY
    ) {
      return;
    }
    const generation = this.pointerGeneration;
    await this.page.mouse.move(clampedX, clampedY);
    // Only if the page is still the one this move was aimed at. A navigation
    // during the await already cleared the remembered coordinate; writing it
    // back here would let the next same-coordinate wheel skip the move that
    // first tells the NEW document where the pointer is.
    if (generation === this.pointerGeneration) {
      this.pointerAt = { x: clampedX, y: clampedY };
    }
  }

  private async applyInput(event: WebMcpInputEvent): Promise<void> {
    // POINTER events only. Their snapshot is the only source of truth for a
    // modifier that was held before the pane had focus — and note that "nothing
    // held" is an ABSENT field, so this must run for events with no snapshot
    // too, or a modifier could never be released. Key events are left alone:
    // they carry their own state through the presses the client forwards, and
    // syncing there would double-press the very key being reported.
    if (
      event.kind === "mouse_move" ||
      event.kind === "mouse_down" ||
      event.kind === "mouse_up" ||
      event.kind === "wheel"
    ) {
      await this.syncModifiers(event.modifiers);
    }
    switch (event.kind) {
      case "mouse_move":
        await this.moveTo(event.x, event.y);
        return;
      case "mouse_down":
        await this.moveTo(event.x, event.y);
        await this.page.mouse.down({
          button: event.button,
          ...(event.clickCount ? { clickCount: event.clickCount } : {}),
        });
        return;
      case "mouse_up":
        await this.moveTo(event.x, event.y);
        await this.page.mouse.up({
          button: event.button,
          ...(event.clickCount ? { clickCount: event.clickCount } : {}),
        });
        return;
      case "wheel":
        // Skip the positioning move when the pointer is provably already
        // there. A wheel costs TWO awaited CDP round trips, and a scroll is a
        // run of wheels at one coordinate — so this halves the server-side
        // cost of the most latency-sensitive input there is. Only the move is
        // skipped; the wheel itself always goes.
        await this.moveTo(event.x, event.y, true);
        await this.page.mouse.wheel(event.deltaX, event.deltaY);
        return;
      case "key_down":
        await this.page.keyboard.down(event.key);
        this.noteModifierKey(event.key, true);
        return;
      case "key_up":
        await this.page.keyboard.up(event.key);
        this.noteModifierKey(event.key, false);
        return;
      case "text":
        // `insertText`, not a synthesized key sequence. Paste and IME
        // composition have no keystrokes to replay, and reconstructing them
        // would be wrong in a different way on every keyboard layout.
        await this.page.keyboard.insertText(event.text);
        return;
    }
  }

  /**
   * Make Playwright's modifier state match what the person was actually
   * holding when they produced this event.
   *
   * Playwright tracks modifiers from the key events IT has seen, and the pane
   * only forwards keys while it has focus. So someone who holds Shift, THEN
   * clicks into the pane, produces a click whose snapshot says shift — and a
   * page that receives it unmodified, because no keydown was ever forwarded.
   * Shift-click to extend a selection, ctrl-click to open in a new tab and
   * ctrl-scroll to zoom all fail exactly that way.
   *
   * The snapshot rides on every event rather than being tracked here for the
   * same reason: focus can leave mid-chord, and a server holding its own idea
   * of "shift is down" would apply it to every later click with nothing to
   * correct it.
   */
  private async syncModifiers(
    modifiers: WebMcpInputModifiers | undefined,
  ): Promise<void> {
    const wanted = new Set<string>();
    if (modifiers?.alt) wanted.add("Alt");
    if (modifiers?.ctrl) wanted.add("Control");
    if (modifiers?.meta) wanted.add("Meta");
    if (modifiers?.shift) wanted.add("Shift");

    for (const key of MODIFIER_KEYS) {
      const held = this.heldModifiers.has(key);
      if (wanted.has(key) === held) continue;
      if (wanted.has(key)) {
        await this.page.keyboard.down(key);
        this.heldModifiers.add(key);
      } else {
        await this.page.keyboard.up(key);
        this.heldModifiers.delete(key);
      }
    }
  }

  /** Keep the tracked set honest when the client forwards a modifier key itself. */
  private noteModifierKey(key: string, down: boolean): void {
    if (!(MODIFIER_KEYS as readonly string[]).includes(key)) return;
    if (down) this.heldModifiers.add(key);
    else this.heldModifiers.delete(key);
  }

  /**
   * Hold a pointer inside the viewport.
   *
   * The client scales against the frame it is looking at, so a coordinate
   * arriving out of range means the two disagreed for a moment — a resize, or a
   * frame that landed after the pane had already changed size. Clamping keeps
   * that from dispatching at a negative coordinate, where Chromium's behaviour
   * is its own business rather than anything the page would do.
   */
  private clamp(x: number, y: number): [number, number] {
    return [
      Math.min(Math.max(x, 0), WEBMCP_VIEWPORT.width - 1),
      Math.min(Math.max(y, 0), WEBMCP_VIEWPORT.height - 1),
    ];
  }

  async setScreencast(enabled: boolean): Promise<boolean> {
    if (this.disposed) return false;
    if (enabled === this.screencasting) return this.screencasting;
    this.screencasting = enabled;
    if (enabled) {
      // Rides the session's existing CDPSession — the same one `Page.enable`
      // and the WebMCP domain are on. A second session would double every
      // event this class already handles.
      //
      // Page-target-level, so it survives navigations: the pane keeps painting
      // across a page load without anything re-arming it.
      await this.sendStartScreencast();
      // A fresh audience, and the replay burst that comes with it, is not
      // evidence about the link: the drops that pressured the PREVIOUS stream
      // are stale, and the hold keeps the first seconds of this one from being
      // read as more of them. The RUNG itself survives — see the field.
      this.dropTimestamps = [];
      this.lastRungChangeAt = Date.now();
      // AFTER the start resolves, and only if the stream survived it. A stop
      // that lands mid-start wins (see `setScreencast(false)` below), and an
      // interval armed unconditionally here would outlive it — capturing
      // stills for a stream nobody restarted.
      if (this.screencasting && !this.disposed) this.armHousekeeping();
      return this.screencasting;
    }
    this.clearHousekeeping();
    this.frameThrottle.reset();
    // The next stream is a fresh picture. Keeping the old bytes would let the
    // first frame of a restarted cast be dropped as a duplicate of the last
    // frame of the previous one — which is exactly the frame the pane is
    // waiting for.
    this.lastFrameData = undefined;
    await this.cdp.send("Page.stopScreencast" as never).catch(() => {});
    return false;
  }

  viewportTransport(): WebMcpViewportTransport {
    // An embedded session has no window by construction, so the streamed pane
    // is the viewport — and it is interactive, which is what separates this
    // from plain `headless`. Reporting `headless` here would tell the client
    // there is nothing to drive.
    if (this.viewportMode === "embedded") {
      return { kind: "frame-stream", ...WEBMCP_VIEWPORT };
    }
    // Otherwise the browser runs on the developer's own machine, so the
    // viewport IS the window in front of them — unless it was launched
    // headless, where there is no window and the UI must not tell anyone to go
    // look at one. A remote provider returns an interactive URL here instead,
    // and the client renders that without further changes.
    return this.headless ? { kind: "headless" } : { kind: "native-window" };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Before the context closes, so the browser stops encoding immediately
    // rather than painting into a teardown that is racing a timeout.
    this.clearHousekeeping();
    this.frameThrottle.reset();
    if (this.screencasting) {
      this.screencasting = false;
      await this.cdp.send("Page.stopScreencast" as never).catch(() => {});
    }
    // Rejects every in-flight invocation and clears their timers.
    this.bridge.dispose();
    await waitForClose(this.context.close());
    await waitForClose(this.browser.close());
  }
}

export class PlaywrightWebMcpProvider implements WebMcpBrowserProvider {
  /** Overridable so tests can force the binary-missing path. */
  protected async loadChromium() {
    try {
      const { chromium } = await import("playwright");
      return chromium;
    } catch {
      const { chromium } = await import("playwright-core");
      return chromium;
    }
  }

  async createSession(
    options: CreateWebMcpSessionOptions,
  ): Promise<WebMcpBrowserSession> {
    const chromium = await this.loadChromium();
    await this.ensureExecutable(chromium);

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    const viewportMode = options.viewportMode ?? "window";
    // Headed for real sessions: the developer drives their own window. Tests
    // pass `headless` explicitly; `MCPJAM_WEBMCP_HEADLESS` is the escape hatch
    // for an inspector running where no display exists.
    //
    // An embedded session is headless regardless of either, and not as a
    // default someone can override: its whole proposition is that the page
    // lives in the pane. A window would put a second, separately-driveable copy
    // of the page on the developer's desktop, and the two would fight for the
    // same clicks.
    const headless =
      viewportMode === "embedded"
        ? true
        : (options.headless ?? webMcpHeadlessRequested());

    try {
      // Chromium cannot start its sandbox as uid 0 (the pinned CI/browser
      // container runs as root). Playwright adds the minimal no-sandbox
      // fallback in that environment; every unprivileged local/production
      // process keeps the renderer sandbox enabled.
      const chromiumSandbox = process.getuid?.() !== 0;
      browser = await chromium.launch({
        headless,
        // The inspector opens arbitrary pages. Keep Chromium's renderer
        // sandbox enabled wherever the OS permits it.
        chromiumSandbox,
        args: buildWebMcpLaunchArgs(),
      });
      context = await browser.newContext({
        viewport: { ...WEBMCP_VIEWPORT },
        // The VIEWER's ratio, so the page rasterises the way it would on their
        // own screen: text at 2x is laid out and hinted for 2x and reaches the
        // pane supersampled rather than merely upscaled. Set once, at context
        // creation, rather than emulated per navigation — see the option's
        // documentation for why a second override is the wrong instrument.
        deviceScaleFactor: options.devicePixelRatio ?? 1,
        acceptDownloads: false,
        permissions: [],
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const session = new PlaywrightWebMcpSession(
        browser,
        context,
        page,
        cdp,
        options.callbacks,
        options.url,
        headless,
        viewportMode,
        options.devicePixelRatio ?? 1,
      );
      await session.start(options.url);
      return session;
    } catch (error) {
      await waitForClose(context?.close());
      await waitForClose(browser?.close());
      const message = error instanceof Error ? error.message : String(error);
      // Headed launch on a machine with no display: SSH, a container, a bare
      // WSL install. Playwright's own text is a wall of browser logs, and the
      // fix is one env var, so say that instead of relaying it.
      if (/XServer|Missing X server|DISPLAY/i.test(message)) {
        throw new WebMcpNoDisplayError(
          "The WebMCP Inspector opens a real browser window, and this machine has no display " +
            "to open one on. Set MCPJAM_WEBMCP_HEADLESS=true to run the browser headless — " +
            "tool discovery, invocation and screenshots all still work; only interacting with " +
            "the page by hand does not. If you need to interact with the page, use a hosted " +
            "browser on an MCPJam computer instead: it runs on a machine with a display, and " +
            "you drive it from the Browser panel.",
        );
      }
      if (/Executable doesn't exist|please run|install/i.test(message)) {
        throw new WebMcpChromiumNotInstalledError(message);
      }
      throw error;
    }
  }

  private async ensureExecutable(chromium: {
    executablePath(): string;
  }): Promise<void> {
    const resolve = () => {
      try {
        const path = chromium.executablePath();
        return path && existsSync(path) ? path : undefined;
      } catch {
        return undefined;
      }
    };
    if (resolve()) return;
    await ensureLocalChromiumInstalled({ reason: "webmcp" });
    if (resolve()) return;
    throw new WebMcpChromiumNotInstalledError(
      "Chromium is required to inspect a page's WebMCP tools, and it could not be installed.",
    );
  }
}

export const playwrightWebMcpProvider = new PlaywrightWebMcpProvider();
