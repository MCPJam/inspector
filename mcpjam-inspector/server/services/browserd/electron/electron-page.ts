/**
 * A `DriverPage` over one Electron `webContents`.
 *
 * The packaged desktop app ships no `node_modules`, so `import("playwright")`
 * rejects there and the local engine — which otherwise runs fine in Electron —
 * had a browser it could never launch. Electron already IS a Chromium, and
 * `webContents.debugger` speaks CDP 1.3, which is everything the driver needs:
 * navigation, input, the AX tree, screenshots and the screencast. Nothing is
 * downloaded.
 *
 * WHAT MAKES THIS CHEAP. `daemon/viewport.ts` is written against `CdpLike`
 * rather than against Playwright, so the pane, the screencast, the quality
 * governor and input forwarding all work here the moment `cdp()` answers. This
 * file only has to cover the act verbs and the observations, and even those
 * mostly reduce to "find the node, get its box, aim at the middle".
 *
 * ERROR PROSE IS LOAD-BEARING. `chromium-driver.ts` classifies a thrown message
 * with `/timeout|not found|no element|strict mode/i` — matching turns it into
 * `target_not_found` ("the button isn't there", which the model can act on),
 * and anything else becomes `act_failed` (a daemon fault). Every throw below is
 * worded to land on the right side of that test.
 *
 * BUNDLE SAFETY. `electron` appears here only as an `import type`, which
 * erases. This module is never in the daemon bundle's entry graph — the E2B box
 * has no Electron and must never try to resolve one.
 */

import type { A11yNode, ConsoleEntry } from "../daemon/observation-budget";
import type { ActPoint, DriverPage } from "../daemon/browser-page";
import type { CdpLike, WebMcpBridge } from "../daemon/webmcp-bridge";
import { WebMcpBridge as Bridge } from "../daemon/webmcp-bridge";
import { PAGE_API_PROBE } from "../../webmcp-inspector/launch-args";
import { DebuggerCdpAdapter } from "./debugger-cdp";
import { readAxTree, resolveBackendNodeId } from "./cdp-a11y";
import { insertsText, resolveKeyPress } from "./key-events";

/** Matches the Playwright engine's navigation budget. */
const NAV_TIMEOUT_MS = 30_000;
/** Matches the Playwright engine's per-act budget. */
const ACT_TIMEOUT_MS = 15_000;
/** How long the page may stay busy before we call the network quiet enough. */
const NETWORK_QUIET_MS = 500;
/** Same quality as the Playwright engine: reading a page, not printing it. */
const SCREENSHOT_JPEG_QUALITY = 70;
/** Newest N console entries kept, matching the Playwright engine's ring. */
const CONSOLE_RING_MAX = 200;

/**
 * A structural skeleton of the DOM for the L3 state token.
 *
 * Byte-identical to the Playwright engine's, deliberately: the token is
 * compared against one the model was given, and two engines that describe the
 * same page differently would make a token minted on one meaningless on the
 * other.
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

/** Reject after `ms` with prose the driver reads as `target_not_found`. */
function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout: ${what} did not finish in ${ms}ms`)),
      ms,
    );
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * The subset of `webContents` this file uses.
 *
 * Structural rather than `Partial<WebContents>` so the unit suite can hand in
 * a fake without implementing three hundred members it never calls — and so
 * that adding a call here is a deliberate edit to this list rather than
 * something that compiles silently against the real type.
 */
export interface PageWebContents {
  loadURL(url: string): Promise<void>;
  reload(): void;
  executeJavaScript(code: string): Promise<unknown>;
  isDestroyed(): boolean;
  focus(): void;
  // `unknown[]` rather than `never[]`: EventEmitter's own listener parameter
  // is `any[]`, which is assignable to everything EXCEPT `never` — so the
  // stricter spelling makes every real emitter, and every fake built on one,
  // fail to satisfy this interface.
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(
    event: string,
    listener: (...args: unknown[]) => void,
  ): unknown;
  debugger: {
    isAttached(): boolean;
    attach(version?: string): void;
    detach(): void;
    sendCommand(method: string, params?: unknown): Promise<unknown>;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    removeListener(
      event: string,
      listener: (...args: unknown[]) => void,
    ): unknown;
  };
  navigationHistory?: {
    canGoBack(): boolean;
    goBack(): void;
  };
}

export interface ElectronPageDeps {
  /** Called when this page is asked to close, so the context drops its window. */
  onClose(): Promise<void> | void;
  /** Bring the page's window forward — what `activate_tab` means here. */
  onBringToFront?(): void;
}

/**
 * Wrap a `webContents` as a `DriverPage`.
 *
 * The debugger is attached EAGERLY rather than on first use. Unlike the
 * Playwright engine — where a CDP session is an extra attach on a page that
 * already works — here CDP is the only way to do anything at all, so deferring
 * it would just move every failure to the first act.
 */
export function createElectronPage(
  wc: PageWebContents,
  deps: ElectronPageDeps,
): DriverPage {
  const consoleRing: ConsoleEntry[] = [];
  let closed = false;
  let currentUrl = "about:blank";
  let cdpPromise: Promise<CdpLike | null> | undefined;
  let webmcpPromise: Promise<WebMcpBridge | null> | undefined;
  let adapter: DebuggerCdpAdapter | undefined;

  // The console ring fills eagerly, from before any observation asks for it —
  // which is the point: a page logs while it loads, not when it is read. The
  // lease's `dropConsoleSince` is what keeps a person's session out of it.
  wc.on("console-message", (...args: unknown[]) => {
    // Electron 30+ passes one event object; older builds pass positional
    // (event, level, message). Both shapes appear in the wild depending on
    // which Electron the packaged app was built against, so read either.
    const first = args[0] as
      { level?: string | number; message?: string } | undefined;
    const level = first?.level ?? (args[1] as string | number | undefined);
    const message = first?.message ?? (args[2] as string | undefined);
    if (typeof message !== "string") return;
    consoleRing.push({ type: levelName(level), text: message, at: Date.now() });
    if (consoleRing.length > CONSOLE_RING_MAX) consoleRing.shift();
  });

  // Both events, because a single-page app changes its URL without a
  // navigation — and an observation stamped with the URL from before the route
  // change describes a page the model is not looking at.
  const trackUrl = (...args: unknown[]) => {
    const url = args[1];
    if (typeof url === "string") currentUrl = url;
  };
  wc.on("did-navigate", trackUrl);
  wc.on("did-navigate-in-page", trackUrl);

  /** The CDP session, attached once and shared by everything that needs one. */
  function session(): Promise<CdpLike | null> {
    cdpPromise ??= (async () => {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        adapter = new DebuggerCdpAdapter(wc.debugger as never);
        // Enabling here rather than per-call: `DOM.querySelector` answers
        // nothing until `DOM.enable`, and a first act that silently found no
        // element would be indistinguishable from a page without the button.
        await adapter.send("DOM.enable").catch(() => {});
        await adapter.send("Page.enable").catch(() => {});
        await adapter.send("Runtime.enable").catch(() => {});
        return adapter;
      } catch {
        // A debugger another tool already owns, or a destroyed surface. The
        // driver treats a page with no CDP as one with no WebMCP and no
        // viewport, which is the honest reading.
        return null;
      }
    })();
    return cdpPromise;
  }

  /** The CDP session or a throw the driver reads as a real failure. */
  async function needCdp(): Promise<CdpLike> {
    const cdp = await session();
    if (!cdp) throw new Error("no debugger session on this page");
    return cdp;
  }

  /** Centre of the element a selector names, in CSS pixels. */
  async function pointFor(selector: string): Promise<ActPoint> {
    const cdp = await needCdp();
    const doc = (await cdp.send("DOM.getDocument", { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const rootNodeId = doc?.root?.nodeId;
    if (rootNodeId === undefined)
      throw new Error("no element: the document has no root");

    const found = (await cdp.send("DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    })) as { nodeId?: number };
    if (!found?.nodeId)
      throw new Error(`no element: ${selector} matched nothing`);

    // Off-screen elements are the common case on a long page, and a click at
    // their unscrolled coordinates lands on whatever is actually there.
    await cdp
      .send("DOM.scrollIntoViewIfNeeded", { nodeId: found.nodeId })
      .catch(() => {});

    const box = (await cdp.send("DOM.getBoxModel", {
      nodeId: found.nodeId,
    })) as {
      model?: { content?: number[] };
    };
    const quad = box?.model?.content;
    if (!quad || quad.length < 8) {
      // A matched node with no box is display:none, or zero-sized. "not found"
      // is the truthful answer to "click this": there is nothing to click.
      throw new Error(`not found: ${selector} has no visible box to aim at`);
    }
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    return {
      x: Math.round(xs.reduce((a, b) => a + b, 0) / 4),
      y: Math.round(ys.reduce((a, b) => a + b, 0) / 4),
    };
  }

  async function mouse(
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
    point: ActPoint,
    options: {
      button?: "left" | "right" | "middle";
      buttons?: number;
      clickCount?: number;
    } = {},
  ): Promise<void> {
    const cdp = await needCdp();
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: type === "mouseMoved" ? "none" : (options.button ?? "left"),
      buttons: options.buttons ?? 0,
      clickCount: options.clickCount ?? (type === "mouseMoved" ? 0 : 1),
    });
  }

  async function clickPoint(
    point: ActPoint,
    button: "left" | "right" = "left",
  ): Promise<void> {
    // The move first: hover handlers, and menus that open on mouseover, both
    // depend on the pointer having been there before the press.
    const mask = button === "right" ? 2 : 1;
    await mouse("mouseMoved", point);
    await mouse("mousePressed", point, { button, buttons: mask });
    await mouse("mouseReleased", point, { button, buttons: 0 });
  }

  async function pressKey(chord: string): Promise<void> {
    const cdp = await needCdp();
    const { key, modifiers, chord: held } = resolveKeyPress(chord);

    for (const modifier of held) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        modifiers,
      });
    }

    const text = insertsText(modifiers) ? key.text : undefined;
    await cdp.send("Input.dispatchKeyEvent", {
      // `keyDown` with text, `rawKeyDown` without: sending `keyDown` and no
      // text makes Chromium synthesise a `char` event for some keys and not
      // others, which is how a shortcut ends up typing its own letter.
      type: text === undefined ? "rawKeyDown" : "keyDown",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      modifiers,
      ...(text === undefined ? {} : { text }),
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      modifiers,
    });

    // Released in reverse, so a held Control outlives the Shift inside it.
    for (const modifier of [...held].reverse()) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        modifiers: 0,
      });
    }
  }

  const page: DriverPage = {
    async goto(url) {
      await deadline(
        (async () => {
          await wc.loadURL(url);
          currentUrl = url;
        })(),
        NAV_TIMEOUT_MS,
        `navigating to ${url}`,
      );
    },
    async reload() {
      await deadline(
        navigationSettled(wc, () => wc.reload()),
        NAV_TIMEOUT_MS,
        "reloading",
      );
    },
    async goBack() {
      const history = wc.navigationHistory;
      if (!history?.canGoBack())
        throw new Error("not found: there is no page to go back to");
      await deadline(
        navigationSettled(wc, () => history.goBack()),
        NAV_TIMEOUT_MS,
        "going back",
      );
    },

    // --- act primitives -----------------------------------------------------
    clickAt: (point, options) => clickPoint(point, options?.button ?? "left"),
    async clickSelector(selector) {
      await deadline(
        (async () => clickPoint(await pointFor(selector)))(),
        ACT_TIMEOUT_MS,
        `clicking ${selector}`,
      );
    },
    hoverAt: (point) => mouse("mouseMoved", point),
    async hoverSelector(selector) {
      await deadline(
        (async () => mouse("mouseMoved", await pointFor(selector)))(),
        ACT_TIMEOUT_MS,
        `hovering ${selector}`,
      );
    },
    async typeText(text) {
      // `Input.insertText` rather than a key event per character: it is one
      // round trip instead of three per letter, and it handles anything a
      // keyboard layout could not produce. The trade is that it fires no
      // keydown, which matters only for pages that filter input per keystroke.
      const cdp = await needCdp();
      await cdp.send("Input.insertText", { text });
    },
    async fillSelector(selector, text) {
      await deadline(
        (async () => {
          const cdp = await needCdp();
          const point = await pointFor(selector);
          // Click to focus, select what is there, then replace it. `fill`'s
          // contract is REPLACE, and an insert into a field with a value would
          // append instead.
          await clickPoint(point);
          await pressKey(
            process.platform === "darwin" ? "Meta+a" : "Control+a",
          );
          await cdp.send("Input.insertText", { text });
        })(),
        ACT_TIMEOUT_MS,
        `filling ${selector}`,
      );
    },
    press: (key) => deadline(pressKey(key), ACT_TIMEOUT_MS, `pressing ${key}`),
    async scrollBy({ dx, dy }) {
      const cdp = await needCdp();
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 0,
        y: 0,
        deltaX: dx,
        deltaY: dy,
      });
    },
    async dragTo(from, to) {
      // The intermediate move is not padding: HTML5 drag handlers and canvas
      // apps both need one, and a single jump lands as a click.
      await mouse("mouseMoved", from);
      await mouse("mousePressed", from, { button: "left", buttons: 1 });
      await mouse(
        "mouseMoved",
        { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
        { buttons: 1 },
      );
      await mouse("mouseMoved", to, { buttons: 1 });
      await mouse("mouseReleased", to, { button: "left", buttons: 0 });
    },
    async selectOption(selector, value) {
      await deadline(
        (async () => {
          const cdp = await needCdp();
          // Setting `.value` alone changes nothing a page listens for, so the
          // `change` event is dispatched too — that is what a framework binds.
          const escaped = JSON.stringify(selector);
          const wanted = JSON.stringify(value);
          const ok = await wc.executeJavaScript(
            `(() => {
              const el = document.querySelector(${escaped});
              if (!el) return "missing";
              const option = [...el.options ?? []].find(
                (o) => o.value === ${wanted} || o.label === ${wanted} || o.text === ${wanted},
              );
              if (!option) return "no-option";
              el.value = option.value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return "ok";
            })()`,
          );
          void cdp;
          if (ok === "missing")
            throw new Error(`no element: ${selector} matched nothing`);
          if (ok === "no-option") {
            throw new Error(`not found: ${selector} has no option "${value}"`);
          }
        })(),
        ACT_TIMEOUT_MS,
        `selecting in ${selector}`,
      );
    },
    async bringToFront() {
      deps.onBringToFront?.();
      wc.focus();
    },

    // --- observation --------------------------------------------------------
    async a11ySnapshot(rootSelector?: string): Promise<A11yNode | null> {
      const cdp = await session();
      if (!cdp) return null;
      if (rootSelector === undefined) return readAxTree(cdp);
      const backendNodeId = await resolveBackendNodeId(cdp, rootSelector);
      // `null` for an unmatched root as well: the driver already reports an
      // unmatched ROOT selector as an error rather than as an empty page, and
      // it decides that by whether it asked for one.
      if (backendNodeId === null) return null;
      return readAxTree(cdp, backendNodeId);
    },
    consoleEntries: () => consoleRing,
    dropConsoleSince(since: number) {
      let keep = consoleRing.length;
      while (keep > 0 && consoleRing[keep - 1]!.at >= since) keep -= 1;
      consoleRing.length = keep;
    },
    webmcp() {
      webmcpPromise ??= (async () => {
        const cdp = await session();
        if (!cdp) return null;
        try {
          const bridge = new Bridge(cdp);
          await bridge.start(async () => {
            // `WebMCP.enable` resolves even where the feature is off; the page
            // API is the only honest probe. Same rule as every other engine.
            const supported = await wc
              .executeJavaScript(`(() => ${PAGE_API_PROBE})()`)
              .catch(() => false);
            return supported === true;
          });
          return bridge;
        } catch {
          return null;
        }
      })();
      return webmcpPromise;
    },
    cdp: () => session(),

    async waitForNetworkIdle(signal) {
      const cdp = await session();
      if (!cdp) return;
      await Promise.race([networkQuiet(cdp), abortPromise(signal)]).catch(
        () => {},
      );
    },
    async requestAnimationFrame(signal) {
      await Promise.race([
        wc.executeJavaScript(
          "(() => new Promise((r) => requestAnimationFrame(() => r())))()",
        ),
        abortPromise(signal),
      ]);
    },
    async domStructureSignal() {
      const signal = await wc.executeJavaScript(`(${DOM_SIGNAL_FN})()`);
      return typeof signal === "string" ? signal : "";
    },
    async screenshotBase64() {
      const cdp = await needCdp();
      // Through CDP rather than `capturePage`: a hidden window has nothing on
      // screen for `capturePage` to read, and every window this engine opens
      // is hidden.
      const shot = (await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: SCREENSHOT_JPEG_QUALITY,
      })) as { data?: string };
      return shot?.data ?? "";
    },
    url: () => currentUrl,
    async close() {
      if (closed) return;
      closed = true;
      adapter?.dispose();
      try {
        if (wc.debugger.isAttached()) wc.debugger.detach();
      } catch {
        // A surface already destroyed detaches itself; nothing to salvage.
      }
      await deps.onClose();
    },
    isClosed: () => closed || wc.isDestroyed(),
  };

  return page;
}

/** CDP's numeric console levels, and the modern string ones. */
function levelName(level: string | number | undefined): string {
  if (typeof level === "string") return level;
  switch (level) {
    case 0:
      return "verbose";
    case 2:
      return "warning";
    case 3:
      return "error";
    default:
      return "info";
  }
}

/**
 * Run a navigation that reports through events rather than a promise.
 *
 * `reload()` and `goBack()` return void, so the commit has to be waited for
 * separately or the driver would settle and capture the OLD page.
 */
function navigationSettled(
  wc: PageWebContents,
  start: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      wc.removeListener?.("did-finish-load", onLoad);
      wc.removeListener?.("did-fail-load", onFail);
      if (error) reject(error);
      else resolve();
    };
    const onLoad = () => finish();
    const onFail = (...args: unknown[]) =>
      // Worded so the driver reads a bad URL or a dead host as something the
      // model can act on, not as a daemon fault.
      finish(
        new Error(`not found: navigation failed (${String(args[2] ?? "")})`),
      );
    wc.on("did-finish-load", onLoad);
    wc.on("did-fail-load", onFail);
    try {
      start();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Resolve once the page has had `NETWORK_QUIET_MS` with nothing in flight.
 *
 * There is no `waitForLoadState("networkidle")` here, so the requests are
 * counted directly. No inner timeout, deliberately: settle's abort signal is
 * the sole budget, and giving this its own would report a never-quiet page as
 * quiet — the exact P1 the Playwright engine had.
 */
function networkQuiet(cdp: CdpLike): Promise<void> {
  return new Promise<void>((resolve) => {
    let inFlight = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const arm = () => {
      if (timer) clearTimeout(timer);
      if (inFlight > 0) return;
      timer = setTimeout(resolve, NETWORK_QUIET_MS);
      (timer as { unref?: () => void }).unref?.();
    };

    cdp.on("Network.requestWillBeSent", () => {
      inFlight += 1;
      if (timer) clearTimeout(timer);
    });
    const settle = () => {
      inFlight = Math.max(0, inFlight - 1);
      arm();
    };
    cdp.on("Network.loadingFinished", settle);
    cdp.on("Network.loadingFailed", settle);

    void cdp.send("Network.enable").catch(() => {});
    // Armed immediately: a page that was already idle when asked must not wait
    // for a request that is never coming.
    arm();
  });
}
