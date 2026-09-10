/**
 * The live Playwright implementation of the driver's browser boundary.
 *
 * This is the ONLY file in the daemon that imports Playwright and knows about
 * CDP-era specifics. It launches ONE persistent browser context (a single
 * profile, many tabs — unlike the local inspector, which launches a fresh
 * browser per single-page session) with browserd's hardened launch args (L4) and
 * determinism pins (L5), clears any stale profile lock first (L8), and wraps each
 * Playwright `Page` into the small `DriverPage` the driver logic is written
 * against. It carries no unit tests of its own — its live behaviour is validated
 * by `__tests__/chromium-launch.spike.test.ts`, which runs only when a real
 * Chromium is present.
 */
import type { DriverContext, DriverPage } from "./browser-page";
import {
  BROWSERD_CONTEXT_OPTIONS,
  buildBrowserdLaunchArgs,
} from "./launch-args";
import { clearStaleSingletonLock } from "./profile-lock";
import { capText, type ConsoleEntry } from "./observation-budget";
import { PAGE_TEXT_FN } from "./page-text";
import type { PendingDialog } from "./dialogs";
import { NetworkRing } from "./network";
import { WebMcpBridge, type CdpLike } from "./webmcp-bridge";

/**
 * Evaluated IN THE PAGE to decide whether this browser really supports
 * WebMCP. Duplicated from `webmcp-inspector/launch-args.ts` rather than
 * imported: the daemon is bundled standalone, and pulling in the local
 * inspector's module would drag its Playwright-facing dependencies into the
 * sandbox artifact. The two must agree — both read the documented
 * `document.modelContext`, falling back to the `navigator` alias Chromium 151
 * still carries.
 */
const PAGE_API_PROBE = "!!(document.modelContext ?? navigator.modelContext)";

const NAV_TIMEOUT_MS = 30_000;

/**
 * A structural skeleton of the DOM — cheap, and changes when structure does.
 * NOTE: `page.evaluate(string)` evaluates the string as an EXPRESSION, so this
 * function literal must be wrapped and self-invoked — `(${DOM_SIGNAL_FN})()` —
 * at the call site. A bare `() => {…}` string evaluates to the (uncalled)
 * function, which serializes to `undefined` and breaks every capture. Same for
 * the requestAnimationFrame string below.
 */
const DOM_SIGNAL_FN = `() => {
  const parts = [];
  const walk = (el, depth) => {
    if (depth > 12 || parts.length > 400) return;
    parts.push(depth + el.tagName);
    for (const child of el.children) walk(child, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  return parts.join(">");
}`;

/** Reject when the signal aborts, so a settle-timeout unblocks a waiting step. */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

// Playwright's Page is structurally richer than DriverPage needs; type the
// handle loosely and adapt, rather than dragging Playwright's types across the
// boundary.
export type AnyPage = {
  goto(url: string, options?: unknown): Promise<unknown>;
  reload(options?: unknown): Promise<unknown>;
  goBack(options?: unknown): Promise<unknown>;
  goForward(options?: unknown): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  waitForLoadState(state: string, options?: unknown): Promise<void>;
  evaluate<R>(fn: string): Promise<R>;
  screenshot(options?: unknown): Promise<Buffer>;
  url(): string;
  close(): Promise<void>;
  isClosed(): boolean;
  bringToFront(): Promise<void>;
  mouse: {
    click(x: number, y: number, options?: unknown): Promise<void>;
    move(x: number, y: number, options?: unknown): Promise<void>;
    down(options?: unknown): Promise<void>;
    up(options?: unknown): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    type(text: string, options?: unknown): Promise<void>;
    press(key: string, options?: unknown): Promise<void>;
  };
  click(selector: string, options?: unknown): Promise<void>;
  hover(selector: string, options?: unknown): Promise<void>;
  fill(selector: string, value: string, options?: unknown): Promise<void>;
  selectOption(
    selector: string,
    value: string,
    options?: unknown,
  ): Promise<unknown>;
  on(event: string, handler: (payload: any) => void): void;
  /**
   * Frames, for the WebMCP per-frame session sweep.
   *
   * OPTIONAL because every unit-test fake would otherwise have to grow one, and
   * a page with no frame surface simply has no cross-origin frames to inspect —
   * the same "no WebMCP here" path a context without `newCDPSession` takes.
   */
  frames?(): AnyFrame[];
  mainFrame?(): AnyFrame;
};

/** The little of a Playwright `Frame` the WebMCP sweep needs. */
export type AnyFrame = { url(): string };

/**
 * How many console entries a tab keeps. A ring buffer, because console
 * history is a TAIL the model reads after an act — not a document, and not
 * something a chatty page should be able to grow without bound.
 */
const CONSOLE_RING_SIZE = 200;
/** Per-entry cap at CAPTURE time; the observe budget caps again for output. */
const CONSOLE_ENTRY_CAPTURE_BYTES = 4_000;
/**
 * Per-dialog message cap at capture time.
 *
 * A dialog's text is page-authored and reaches the model, so it is bounded
 * here for the same reason console entries are — and generously, because the
 * whole value of the message is that a person or a model can recognise which
 * dialog it is.
 */
const DIALOG_MESSAGE_BYTES = 2_000;

/**
 * The daemon's diagnostic sink.
 *
 * `process.stderr`, not the server's `logger`: everything under `daemon/**` is
 * bundled and uploaded into an E2B box, where `@/utils/logger` (and the Sentry
 * and Axiom clients behind it) does not exist and must never be resolved. The
 * daemon's own entry point logs the same way, and the sandbox's stderr is what
 * a hosted session's logs are read from.
 */
function warn(message: string): void {
  process.stderr.write(`[mcpjam-browserd] ${message}\n`);
}

/** The shapes Playwright's `Request`/`Response` give us. Structural, like `AnyPage`. */
interface PlaywrightRequest {
  url?(): string;
  method?(): string;
  resourceType?(): string;
  failure?(): { errorText?: string } | null;
}
interface PlaywrightResponse {
  status?(): number;
  statusText?(): string;
  headers?(): Record<string, string>;
  request?(): PlaywrightRequest;
}

/** The shape Playwright's `Dialog` gives us. Structural, like `AnyPage`. */
interface PlaywrightDialog {
  type?(): string;
  message?(): string;
  defaultValue?(): string | undefined;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

/** Act timeouts: long enough for a slow page, short enough to stay a turn. */
const ACT_TIMEOUT_MS = 15_000;

/**
 * JPEG quality for model-facing captures. High enough that text stays legible
 * and layout edges stay crisp for coordinate targeting; low enough that a
 * capture on every act does not dominate the turn's token budget.
 */
const SCREENSHOT_JPEG_QUALITY = 70;

export function wrapPage(page: AnyPage): DriverPage {
  // The console ring. Attached once per wrapped page; entries are captured
  // eagerly because a console message is gone the moment it is emitted.
  const consoleRing: ConsoleEntry[] = [];
  // Monotonic totals, never decremented when the ring evicts or a handoff
  // purges. They are CURSORS: a ledger row records where they stood after a
  // command, and two rows bracket the output that command produced. Counting
  // only what is still readable would make a lost window indistinguishable
  // from a quiet one.
  let consoleTotal = 0;
  let errorsTotal = 0;
  page.on(
    "console",
    (message: { type?: () => string; text?: () => string }) => {
      try {
        const text = message.text?.() ?? "";
        consoleRing.push({
          type: message.type?.() ?? "log",
          text: capText(text, CONSOLE_ENTRY_CAPTURE_BYTES),
          at: Date.now(),
        });
        consoleTotal += 1;
        if (consoleRing.length > CONSOLE_RING_SIZE) consoleRing.shift();
      } catch {
        // A console listener must never take the page down.
      }
    },
  );
  // THE NETWORK RING. Playwright hands back objects rather than CDP ids, so
  // the ring's own id is minted here and remembered against the Request — the
  // same object the response reports, which is what folds the two events into
  // one row. A WeakMap so a page that runs for hours does not accumulate ids
  // for requests nobody will ask about again.
  const network = new NetworkRing();
  const requestIds = new WeakMap<object, string>();
  let nextRequestId = 0;
  const idFor = (request: object): string => {
    const known = requestIds.get(request);
    if (known) return known;
    nextRequestId += 1;
    const minted = `r${nextRequestId}`;
    requestIds.set(request, minted);
    return minted;
  };
  page.on("request", (request: PlaywrightRequest) => {
    try {
      network.started({
        requestId: idFor(request as unknown as object),
        method: request.method?.() ?? "GET",
        url: request.url?.() ?? "",
        ...(request.resourceType?.()
          ? { resourceType: request.resourceType() }
          : {}),
      });
    } catch {
      // A network listener must never take the page down.
    }
  });
  page.on("response", (response: PlaywrightResponse) => {
    try {
      const request = response.request?.();
      if (!request) return;
      const headers = response.headers?.();
      const length = Number(headers?.["content-length"]);
      network.finished({
        requestId: idFor(request as unknown as object),
        ...(response.status ? { status: response.status() } : {}),
        ...(response.statusText?.()
          ? { statusText: response.statusText() }
          : {}),
        ...(Number.isFinite(length) ? { bytes: length } : {}),
        ...(headers ? { headers } : {}),
      });
    } catch {
      // As above.
    }
  });
  page.on("requestfailed", (request: PlaywrightRequest) => {
    try {
      network.finished({
        requestId: idFor(request as unknown as object),
        failure: request.failure?.()?.errorText ?? "request failed",
      });
    } catch {
      // As above.
    }
  });

  // DIALOGS ARE CAPTURED, NOT ANSWERED HERE.
  //
  // Registering any `dialog` listener turns OFF Playwright's own auto-dismiss,
  // which is what makes this possible at all: the dialog stays open, and the
  // driver decides. That decision needs the lease — a dialog raised while a
  // person is driving is theirs to answer, and dismissing it out from under
  // them is exactly the surprise the handoff exists to prevent — and the lease
  // is not something a page wrapper can see.
  let pending: { dialog: PendingDialog; handle: PlaywrightDialog } | null =
    null;
  page.on("dialog", (dialog: PlaywrightDialog) => {
    try {
      pending = {
        handle: dialog,
        dialog: {
          kind: (dialog.type?.() ?? "alert") as PendingDialog["kind"],
          message: capText(dialog.message?.() ?? "", DIALOG_MESSAGE_BYTES),
          ...(dialog.defaultValue?.()
            ? {
                defaultPrompt: capText(
                  dialog.defaultValue()!,
                  DIALOG_MESSAGE_BYTES,
                ),
              }
            : {}),
          at: Date.now(),
        },
      };
    } catch {
      // A dialog listener must never take the page down.
    }
  });
  page.on("pageerror", (error: unknown) => {
    consoleRing.push({
      type: "pageerror",
      text: capText(
        error instanceof Error ? error.message : String(error),
        CONSOLE_ENTRY_CAPTURE_BYTES,
      ),
      at: Date.now(),
    });
    // Counted in BOTH: a page error is a console entry (the ring holds one) and
    // it is also the thing `errors` names. A reader asking "did this command
    // throw" wants the second number, and deriving it from the first would mean
    // scanning entries the ring may already have dropped.
    consoleTotal += 1;
    errorsTotal += 1;
    if (consoleRing.length > CONSOLE_RING_SIZE) consoleRing.shift();
  });

  // The WebMCP bridge is attached ONCE and memoized here. It USED to be
  // attached lazily, on the first `webmcp_*` action, on the reasoning that a
  // tab which never calls a page tool should not pay for a CDP session. The
  // driver now attaches it eagerly on tab creation instead (see
  // `ChromiumDriver.getOrCreateTab`), because the tool set became something
  // READ between model steps: a bridge that attaches on first use knows
  // nothing about what the page registered before it existed, so a tool
  // registered during page load would be invisible until something else
  // happened to touch WebMCP. It still reuses the memoized session below
  // rather than attaching its own — a page serving both a tool call and the
  // pane would otherwise hold two.
  let webmcpPromise: Promise<WebMcpBridge | null> | null = null;
  // The CDP session itself is memoized separately and shared: the WebMCP
  // bridge and the viewport both want one, and attaching twice to the same
  // page gives two sessions whose events interleave unpredictably.
  let cdpPromise: Promise<CdpLike | null> | null = null;

  // Named rather than returned inline so `webmcp()` can reach `cdp()` — one
  // attach, two consumers.
  const adapted: DriverPage = {
    async goto(url) {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    },
    async reload() {
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    },
    async goBack() {
      await page.goBack({
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    },
    async setViewportSize(size) {
      // Playwright's own call, which resizes the page's CSS viewport WITHOUT
      // touching the OS window. That separation is the point on Electron and
      // the hosted box alike: moving a window must not change the coordinate
      // space the agent reasons in, and changing the coordinate space must not
      // depend on anybody being able to move a window.
      await page.setViewportSize(size);
    },
    async goForward() {
      // Playwright resolves with a null response rather than throwing when
      // there is nothing ahead, which is the behaviour the verb wants: the
      // pane disables the button from `canGoForward`, so reaching this with an
      // empty forward history is a race and not a fault worth a message.
      await page.goForward({
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    },
    async waitForNetworkIdle(signal) {
      // settle's maxWait (via the abort signal) is the SOLE budget — no inner
      // timeout. A page that never idles stays pending until the signal aborts,
      // and then this rejects, so `settlePage` reports `settled: false`. The
      // earlier version gave the wait its own 8s timeout and swallowed it, which
      // turned a never-quiet page into a false `settled: true` (P1). Guard the
      // losing promise so it does not surface as an unhandled rejection.
      const idle = page.waitForLoadState("networkidle", { timeout: 0 });
      idle.catch(() => {});
      await Promise.race([idle, abortPromise(signal)]);
    },
    async requestAnimationFrame(signal) {
      await Promise.race([
        page.evaluate<void>(
          "(() => new Promise((r) => requestAnimationFrame(() => r())))()",
        ),
        abortPromise(signal),
      ]);
    },
    domStructureSignal() {
      return page.evaluate<string>(`(${DOM_SIGNAL_FN})()`);
    },
    async screenshotBase64() {
      // JPEG, not PNG. Every act and navigate result carries a capture, and a
      // full-viewport PNG of a real page runs 100–400 KB — which becomes tens
      // of thousands of tokens once it reaches the model as image content. At
      // this quality the difference is invisible for reading a page and
      // aiming a click, and roughly an order of magnitude cheaper.
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: SCREENSHOT_JPEG_QUALITY,
        // CSS PIXELS, always — the model's coordinate space (L5). Without
        // this, Playwright captures at the device scale factor, so raising the
        // display's sharpness would silently hand the model a 1536×1152 or
        // 2048×1536 picture while `isPointInViewport` went on refusing
        // anything past 1023×767. Every click the model computed from that
        // screenshot would land at a fraction of where it aimed.
        //
        // At DPR 1 this produces byte-identical output to the call it
        // replaces, which is what makes it safe to land before any DPR change.
        scale: "css",
      });
      return buffer.toString("base64");
    },
    url: () => page.url(),
    close: () => page.close(),
    isClosed: () => page.isClosed(),
    bringToFront: () => page.bringToFront(),

    // --- act primitives -----------------------------------------------------
    // Coordinates are already in the canonical observation viewport (L5), so
    // no scaling happens here: what the model saw IS what it clicks.
    clickAt: (point, options) =>
      page.mouse.click(point.x, point.y, {
        ...(options?.button ? { button: options.button } : {}),
      }),
    clickSelector: (selector) =>
      page.click(selector, { timeout: ACT_TIMEOUT_MS }),
    hoverAt: (point) => page.mouse.move(point.x, point.y),
    hoverSelector: (selector) =>
      page.hover(selector, { timeout: ACT_TIMEOUT_MS }),
    typeText: (text) => page.keyboard.type(text),
    fillSelector: (selector, text) =>
      page.fill(selector, text, { timeout: ACT_TIMEOUT_MS }),
    press: (key) => page.keyboard.press(key),
    scrollBy: ({ dx, dy }) => page.mouse.wheel(dx, dy),
    async dragTo(from, to) {
      // Explicit down/move/up rather than `dragAndDrop`: HTML5 drag handlers
      // and canvas apps both need the intermediate move to fire, and a single
      // jump often lands as a click.
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
      await page.mouse.move(to.x, to.y);
      await page.mouse.up();
    },
    async selectOption(selector, value) {
      await page.selectOption(selector, value, { timeout: ACT_TIMEOUT_MS });
    },

    // --- observation --------------------------------------------------------
    async pageText() {
      // Degrades rather than throwing, like every other read on this page: a
      // navigation mid-read destroys the execution context and rejects, and a
      // whole failed observation teaches the model less than an empty one it
      // can retry.
      try {
        const text = await page.evaluate<string>(`(${PAGE_TEXT_FN})()`);
        return typeof text === "string" ? text : "";
      } catch {
        return "";
      }
    },
    networkEntries: () => network.entries(),
    dropNetworkSince: (since: number) => network.dropSince(since),
    networkCursor: () => network.count(),
    pendingDialog: () => pending?.dialog ?? null,
    async resolveDialog(accept: boolean, promptText?: string) {
      const open = pending;
      // CLEARED BEFORE THE ANSWER IS SENT, not after. `accept()` resolves once
      // the renderer has taken the answer and started running again, and any
      // command that arrives in that window must see an unblocked page rather
      // than refuse against a dialog that is already on its way out.
      pending = null;
      if (!open) return false;
      try {
        if (accept) await open.handle.accept(promptText);
        else await open.handle.dismiss();
      } catch {
        // Already gone — the page closed it, or the tab navigated. Answered
        // either way, as far as the caller is concerned.
      }
      return true;
    },
    consoleEntries: () => consoleRing,
    consoleCursor: () => ({ console: consoleTotal, errors: errorsTotal }),
    dropConsoleSince: (since: number) => {
      // Walk from the end: the ring is chronological, so the tail is the
      // window to drop.
      let keep = consoleRing.length;
      while (keep > 0 && consoleRing[keep - 1].at >= since) keep -= 1;
      consoleRing.length = keep;
    },
    webmcp() {
      webmcpPromise ??= (async () => {
        // Through the memoized session, so the bridge and the viewport share
        // ONE attach. Two sessions on a page is two of everything the CDP
        // domains keep per session, for one page's worth of truth.
        const session = await adapted.cdp();
        return session ? attachWebMcp(page, session) : null;
      })();
      return webmcpPromise;
    },
    cdp() {
      cdpPromise ??= (async () => {
        const attach = cdpAttachers.get(page);
        if (!attach) return null;
        return attach.page().catch(() => null);
      })();
      return cdpPromise;
    },
  };
  return adapted;
}

/**
 * Attach a WebMCP bridge to a page over the session its adapter already holds.
 * Returns null when this browser cannot speak the domain at all — a page with
 * no WebMCP tools is the normal case, not a failure, so nothing here throws.
 *
 * The session is passed IN rather than attached here: the page adapter
 * memoizes one, and a bridge that opened its own would give a page serving
 * both a tool call and the pane two sessions.
 */
async function attachWebMcp(
  page: AnyPage,
  session: CdpLike,
): Promise<WebMcpBridge | null> {
  try {
    // ONE probe closure, used for the initial `start()` AND re-run on every
    // main-frame navigation. `document.modelContext` is a property of the
    // DOCUMENT, not of the session: a bridge that probed once reported "this
    // browser has no WebMCP" forever after opening on a page that had none,
    // including on the WebMCP page the model navigated to next.
    const probe = async () => {
      // `WebMCP.enable` resolves even where the feature is off — the page API
      // is the only honest probe (same reasoning as the local inspector's).
      const supported = await page
        .evaluate<boolean>(`(() => ${PAGE_API_PROBE})()`)
        .catch(() => false);
      return supported === true;
    };
    const bridge = new WebMcpBridge(session);
    bridge.resupport(probe);
    await bridge.start(probe);
    attachFrameSessions(page, bridge);
    return bridge;
  } catch {
    return null;
  }
}

/**
 * Keep one CDP session per separately-targeted frame, for the hosted box.
 *
 * The SAME change as the local inspector's, because the daemon drives
 * Playwright inside the sandbox and ends at the same bridge: a cross-origin
 * frame is a separate Chromium target, so its tools never reach the page's
 * session and a page whose tools live in a cross-origin widget would inspect as
 * having none.
 *
 * ATTEMPTED, never predicted from origins: Playwright throws a specific error
 * when the frame has no session of its own, and that error — and only that one
 * — means "nothing to attach here". Everything else is logged, because a frame
 * we failed to reach is a frame whose tools are silently missing.
 *
 * NESTED TARGETS need no recursion here, for the same reason they do not in the
 * local inspector: Playwright's own auto-attach already walks the tree, so
 * `page.frames()` is a FLAT list that reaches a cross-origin frame inside a
 * cross-origin frame and one sweep of it covers every depth. (The Electron
 * adapter, which has no such list, has to re-issue `Target.setAutoAttach` per
 * child session instead.)
 *
 * Fire-and-forget on purpose. Tool discovery is the cooperation layer; a driver
 * waiting on frame attachment before it could navigate would make every page
 * load pay for a feature most pages do not use.
 */
function attachFrameSessions(page: AnyPage, bridge: WebMcpBridge): void {
  const attach = cdpAttachers.get(page)?.frame;
  if (!attach || !page.frames || !page.mainFrame) return;
  const tokens = new Map<AnyFrame, string>();
  const busy = new Set<AnyFrame>();

  const attachOne = async (frame: AnyFrame): Promise<void> => {
    // The page's own session already covers the main frame; a second one on it
    // would report every tool twice.
    if (frame === page.mainFrame?.()) return;
    if (tokens.has(frame) || busy.has(frame)) return;
    busy.add(frame);
    try {
      const session = await attach(frame);
      const tree = (await session.send("Page.getFrameTree")) as {
        frameTree?: { frame?: { id?: string } };
      };
      const frameId = tree?.frameTree?.frame?.id;
      if (!frameId) return;
      const token = await bridge.addSession(frameId, session);
      // The frame can go away DURING those two awaits, and its `framedetached`
      // has then already run and found no token to remove — leaving a session
      // wired to the bridge publishing tools for a frame that is off the page.
      // The local inspector closes the same window with `frame.isDetached()`;
      // `AnyFrame` exposes only `url()`, so membership in the CURRENT frame
      // list is the equivalent question here.
      if (!page.frames?.().includes(frame)) {
        bridge.removeSession(token);
        return;
      }
      tokens.set(frame, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not have a separate CDP session/i.test(message)) return;
      warn(
        `could not attach a CDP session to the frame at ${frame.url()}: ${message}`,
      );
    } finally {
      busy.delete(frame);
    }
  };

  const sweep = () => {
    for (const frame of page.frames?.() ?? []) void attachOne(frame);
  };
  page.on("frameattached", (frame: AnyFrame) => void attachOne(frame));
  // The sweep, not just the navigated frame: a cross-origin navigation can give
  // a DESCENDANT its own target, and that frame gets no event of its own.
  page.on("framenavigated", () => sweep());
  // A detach that really is a removal — Playwright fires this one only when the
  // frame goes away, never for the target swap that a frame becoming
  // cross-origin produces. Teardown quotes the attachment's token, so a removal
  // landing after a replacement has attached names an attachment already gone.
  page.on("framedetached", (frame: AnyFrame) => {
    const token = tokens.get(frame);
    if (token === undefined) return;
    tokens.delete(frame);
    bridge.removeSession(token);
  });
  sweep();
}

/**
 * How a wrapped page opens a CDP session. Populated by `adaptContext` (which
 * holds the BrowserContext); a page wrapped without one — every unit test —
 * simply has no WebMCP, which is exactly the "page offers no tools" path.
 *
 * TWO attachers, because a cross-origin frame is a separate Chromium target:
 * its tools never reach the page's session, so the WebMCP bridge needs one
 * session per such frame. The frame attacher is the same `newCDPSession` call
 * with a `Frame` instead of a `Page`.
 */
const cdpAttachers = new WeakMap<
  AnyPage,
  {
    page: () => Promise<CdpLike>;
    frame?: (frame: AnyFrame) => Promise<CdpLike>;
  }
>();

/** Record how a page (and its frames) open CDP sessions (called by `adaptContext`). */
export function registerCdpAttacher(
  page: AnyPage,
  attach: () => Promise<CdpLike>,
  attachFrame?: (frame: AnyFrame) => Promise<CdpLike>,
): void {
  cdpAttachers.set(page, {
    page: attach,
    ...(attachFrame ? { frame: attachFrame } : {}),
  });
}

export interface LaunchBrowserdContextOptions {
  /** Persistent profile directory — the singleton whose lock L8 clears. */
  userDataDir: string;
  /** Headed under Xfce in the sandbox; tests may force headless. */
  headless?: boolean;
  /** Extra args, e.g. `--window-size` matched to the X screen geometry. */
  extraArgs?: readonly string[];
  /**
   * `persistent` (default) keeps one profile across boots — what a
   * playground login depends on. `ephemeral` launches a throwaway browser
   * with a fresh context and NO profile dir, so an eval iteration can never
   * inherit the previous one's cookies.
   */
  contextMode?: "persistent" | "ephemeral";
  /**
   * Device pixels per CSS pixel, from the box's own configuration.
   *
   * Honoured only in `persistent` mode — see `contextOptionsFor`. The CSS
   * viewport is unchanged either way: the model's coordinate space is 1024×768
   * whatever the display rasterises at.
   */
  deviceScaleFactor?: number;
  /**
   * Which Chromium build to launch.
   *
   * Unset means Playwright's own default, which is what the hosted desktop
   * wants (headed under Xfce, from the template's install). The local engine
   * passes `"chromium"` deliberately: without a channel, `headless: true`
   * resolves to the `chromium-headless-shell` binary — the OLD headless, a
   * different executable with a different compositor path and a fingerprint
   * public sites recognise. "No window" must not mean "a browser sites
   * refuse", so the local engine runs the same full build a headed launch
   * would and merely declines to show it.
   */
  channel?: string;
  /**
   * An explicit Chromium binary.
   *
   * For environments that ship one at a path Playwright's resolver does not
   * know (a prebuilt CI image). Production never sets it — a user's machine
   * has the browser Playwright installed, and pinning a path here would make
   * the engine depend on a filesystem layout we do not control.
   */
  executablePath?: string;
}

/**
 * Launch the persistent browser context and adapt it to `DriverContext`. Clears
 * a stale singleton lock first so a relaunch-on-wake never hands off to a dead
 * instance (L8). Chromium cannot start its renderer sandbox as uid 0 (the image
 * builds as root), so the sandbox is disabled only in that case.
 */
/**
 * The context options, with the display's scale factor folded in.
 *
 * PERSISTENT ONLY. An ephemeral context is an eval or a swarm iteration, where
 * the whole point of the pinned options is that a screenshot on one host
 * matches a screenshot on another (L5) — so its scale factor stays 1 whatever
 * the box is configured for, and hosted and local eval captures stay identical.
 */
export function contextOptionsFor(options: {
  contextMode: "persistent" | "ephemeral";
  deviceScaleFactor?: number;
}): Omit<typeof BROWSERD_CONTEXT_OPTIONS, "deviceScaleFactor"> & {
  deviceScaleFactor: number;
} {
  const dpr = options.deviceScaleFactor ?? 1;
  if (options.contextMode !== "persistent" || dpr === 1) {
    return BROWSERD_CONTEXT_OPTIONS;
  }
  return { ...BROWSERD_CONTEXT_OPTIONS, deviceScaleFactor: dpr };
}

export async function launchBrowserdContext(
  options: LaunchBrowserdContextOptions,
): Promise<DriverContext> {
  const { chromium } = await import("playwright");
  const launchArgs = {
    headless: options.headless ?? false,
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.executablePath
      ? { executablePath: options.executablePath }
      : {}),
    // Chromium cannot start its renderer sandbox as uid 0 (the image builds
    // as root), so it is disabled only in that case.
    chromiumSandbox: process.getuid?.() !== 0,
    args: buildBrowserdLaunchArgs(options.extraArgs),
  };

  if (options.contextMode === "ephemeral") {
    // No user-data-dir at all: an eval's isolation must be a property of the
    // BROWSER, not of remembering to clear cookies. Nothing persists, so
    // there is no singleton lock to clear either (L8 is about the shared
    // profile directory, which does not exist here).
    const browser = await chromium.launch(launchArgs);
    let context;
    try {
      context = await browser.newContext({
        acceptDownloads: false,
        permissions: [],
        // Ephemeral: `contextOptionsFor` pins the scale factor at 1 here
        // whatever the box says, so eval captures match across hosts.
        ...contextOptionsFor({ contextMode: "ephemeral" }),
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
      });
    } catch (error) {
      // Ownership of the browser transfers to `adaptContext` below. If we
      // never get there, nothing else will ever close it, and a stranded
      // Chromium keeps running inside the box until the sandbox dies.
      await browser.close().catch(() => {});
      throw error;
    }
    return adaptContext(context as unknown as AnyContext, {
      // The browser outlives the context, so closing the context alone would
      // leave a Chromium process behind in the box.
      onClose: () => browser.close(),
    });
  }

  const cleared = await clearStaleSingletonLock(options.userDataDir);
  if (cleared.heldBy) {
    // Somebody took the profile between the session layer's check and this
    // launch. Refusing here beats Chromium's own message, and beats removing a
    // live owner's lock to make room for ourselves.
    throw new Error(
      `profile_in_use: another browser (pid ${cleared.heldBy.pid ?? "unknown"}` +
        `${cleared.heldBy.host ? ` on ${cleared.heldBy.host}` : ""}) holds ` +
        "this profile; close it and try again",
    );
  }
  const context = await chromium.launchPersistentContext(options.userDataDir, {
    ...launchArgs,
    acceptDownloads: false,
    permissions: [],
    ...contextOptionsFor({
      contextMode: "persistent",
      ...(options.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: options.deviceScaleFactor }
        : {}),
    }),
  });
  return adaptContext(context as unknown as AnyContext);
}

/** The subset of a Playwright BrowserContext the adapter uses. */
export type AnyContext = {
  newPage(): Promise<AnyPage>;
  pages(): AnyPage[];
  browser(): { isConnected(): boolean } | null;
  close(): Promise<void>;
  /** Present on a real Playwright context; absent in unit-test fakes. */
  newCDPSession?(page: AnyPage): Promise<CdpLike>;
};

/**
 * Adapt a persistent Playwright context to `DriverContext`. A persistent context
 * opens with a startup page (about:blank on a fresh profile, restored tabs
 * otherwise); adopt those first so the FIRST driver tab IS the startup page.
 * Otherwise `newPage()` would create a second page and leave the startup tab
 * visible and permanently outside the driver's tab map, where a headed user could
 * focus it while observations ran against a different tab (P2).
 */
export function adaptContext(
  context: AnyContext,
  options: { onClose?: () => Promise<unknown> } = {},
): DriverContext {
  const startup = [...context.pages()];
  let adopted = 0;
  const listeners = new Set<
    (event: { page: DriverPage; opener: DriverPage }) => void
  >();
  const wrapped = new WeakMap<AnyPage, DriverPage>();
  function adopt(page: AnyPage): DriverPage {
    const existing = wrapped.get(page);
    if (existing) return existing;
    if (context.newCDPSession) {
      registerCdpAttacher(
        page,
        () => context.newCDPSession!(page),
        (frame) => context.newCDPSession!(frame as unknown as AnyPage),
      );
    }
    const driverPage = wrapPage(page);
    wrapped.set(page, driverPage);
    page.on("popup", (popup: AnyPage) => {
      const child = adopt(popup);
      for (const listener of listeners)
        listener({ page: child, opener: driverPage });
    });
    return driverPage;
  }
  return {
    onPageCreated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async newPage() {
      return adopt(
        adopted < startup.length ? startup[adopted++] : await context.newPage(),
      );
    },
    isConnected() {
      return context.browser()?.isConnected() ?? true;
    },
    async close() {
      // Ephemeral mode owns a Browser above the context, and closing only the
      // context would strand its process inside the box — so the browser close
      // runs even when the context close fails, which is exactly the case
      // where something is already wrong.
      try {
        await context.close();
      } finally {
        await options.onClose?.();
      }
    },
  };
}
