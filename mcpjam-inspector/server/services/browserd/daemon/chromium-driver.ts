/**
 * The real browser driver: it fills the `CommandExecutor` seam PR (a)'s queue
 * drives and PR (b)'s control plane authenticates, turning a `BrowserCommand`
 * into operations on a persistent, multi-tab browser context.
 *
 * Every verb in the protocol is implemented here: navigate / back / reload /
 * observe, the `act` verbs, and the `webmcp_*` invocations. (This header used
 * to say the last two returned `unimplemented` "until W3" — they have been real
 * since W3 landed, and the word survived only in this comment.)
 *
 * It is written entirely against the `DriverContext` / `DriverPage` boundary, so
 * every path here is unit-testable with fakes; the live Playwright context is
 * built by `chromium-launch.ts` and validated by a spike-gated integration test.
 * L2 (settle-before-capture) and L3 (state token on every observation) are wired
 * in here from the pure helpers in PR (c1).
 */
import {
  BROWSERD_OBSERVATION_VIEWPORT,
  DEFAULT_QUEUE_KEY,
  formatBrowserdError,
  isPointInViewport,
  type BrowserAction,
  type BrowserCommand,
  type BrowserCommandResult,
} from "../protocol";
import type { BrowserDriver, DriverHealth } from "./browser-driver";
import type { ActPoint, DriverContext, DriverPage } from "./browser-page";
import { computeStateToken } from "./state-token";
import {
  capA11yTree,
  capConsole,
  capText,
  capToolOutput,
  DEFAULT_A11Y_BUDGET,
  DEFAULT_CONSOLE_BUDGET,
  type A11yBudget,
  type ConsoleBudget,
} from "./observation-budget";
import {
  DEFAULT_PAGE_TEXT_MAX_BYTES,
  PAGE_TEXT_RETRIEVAL_HINT,
} from "./page-text";
import { WebMcpBridgeError } from "./webmcp-bridge";
import { handoffNoteFor, leaseRefusalFor, type HandoffLease } from "./lease";
import { createTabViewport, type TabViewport } from "./viewport";
import {
  DEFAULT_SETTLE_OPTIONS,
  settlePage,
  type SettleOptions,
  type SettleSteps,
} from "./settle";

/**
 * The tab a tab-less (whole-session) command operates on. It MUST equal the
 * command queue's `queueKeyFor` default (`DEFAULT_QUEUE_KEY`): otherwise an
 * explicit `tabId` equal to either name would drive this same page from a
 * separate FIFO and race the tab-less commands (P1).
 */
const DEFAULT_TAB = DEFAULT_QUEUE_KEY;

interface TabEntry {
  page: DriverPage;
  /** Bumps on every navigation so back/forward to the same URL yield distinct
   * tokens (L3). */
  navCounter: number;
}

/**
 * A tab's URL + DOM signal read together. Both are part of the L3 state token,
 * so an observation binds its token to the snapshot the OUTPUT was captured
 * against — never a fresh read — or a change between capture and token (a DOM
 * mutation OR a same-skeleton client-side route change) would let the token and
 * the returned frame describe different states (P1).
 */
interface FrameSnapshot {
  url: string;
  domSignal: string;
}

export interface ChromiumDriverOptions {
  settle?: SettleOptions;
  /**
   * The human-handoff lease, shared with the request handler.
   *
   * The driver READS it for two things: to make the first observation after a
   * handoff loud (L6), and to refuse a capture the moment someone takes the
   * browser mid-command. The handler's 423 covers commands that ARRIVE during
   * a hold; it cannot cover the one already executing, whose screenshot would
   * otherwise be taken a beat after a person started typing a password.
   */
  lease?: Pick<
    HandoffLease,
    "consumeResumedDirty" | "consumeResumedHeldSince" | "resumedFromKind" | "state"
  >;
  a11y?: A11yBudget;
  console?: ConsoleBudget;
  /** Byte budget for a WebMCP tool's returned output (L9). */
  webmcpOutputBytes?: number;
  /** Byte budget for one `observe {mode:"text"}` (L9). */
  pageTextBytes?: number;
}

/** Big enough for a real tool result, small enough not to blow a context. */
const DEFAULT_WEBMCP_OUTPUT_BYTES = 16_000;

/** Parse `"x,y"` from an act's `value`. */
function parsePoint(value: string | undefined): ActPoint | null {
  if (!value) return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

/** One viewport-ish step down — the overwhelmingly common scroll intent. */
const DEFAULT_SCROLL_STEP = 600;

/**
 * How long teardown waits for tab creations that were already in flight.
 *
 * Long enough for a healthy `newPage()` (tens of milliseconds), short enough
 * that a browser which has stopped answering cannot hold the server's shutdown
 * open. Nothing is lost by giving up: `closing` keeps whatever lands late from
 * registering, and the browser process is killed either way.
 */
const CLOSE_PENDING_TAB_GRACE_MS = 2_000;

/**
 * A scroll's `value`: `"down"`/`"up"`, a pixel count, or `"dx,dy"`. Anything
 * unrecognized scrolls down by the default step rather than erroring — a
 * scroll is cheap and recoverable, and refusing one teaches nothing.
 */
function parseScrollDelta(value: string | undefined): [number, number] {
  const point = parsePoint(value);
  if (point) return [point.x, point.y];
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (trimmed === "up") return [0, -DEFAULT_SCROLL_STEP];
  if (trimmed === "down" || trimmed === "") return [0, DEFAULT_SCROLL_STEP];
  if (trimmed === "top") return [0, -1_000_000];
  if (trimmed === "bottom") return [0, 1_000_000];
  const pixels = Number(trimmed);
  if (Number.isFinite(pixels)) return [0, pixels];
  return [0, DEFAULT_SCROLL_STEP];
}

export class ChromiumDriver implements BrowserDriver {
  private readonly context: DriverContext;
  private readonly settleOptions: SettleOptions;
  private readonly a11yBudget: A11yBudget;
  private readonly consoleBudget: ConsoleBudget;
  private readonly webmcpOutputBudgetBytes: number;
  private readonly pageTextMaxBytes: number;
  private readonly lease:
    | Pick<
        HandoffLease,
        | "consumeResumedDirty"
        | "consumeResumedHeldSince"
        | "resumedFromKind"
        | "state"
      >
    | undefined;
  private readonly tabs = new Map<string, TabEntry>();
  /**
   * One viewport per tab, created on first watch.
   *
   * Lazy for the same reason the WebMCP bridge is: attaching a CDP session and
   * encoding JPEGs for a tab nobody is looking at is work done for nobody.
   */
  private readonly viewports = new Map<string, Promise<TabViewport | null>>();
  /**
   * Tab creations already under way, by tabId.
   *
   * `context.newPage()` is awaited, so without this two callers arriving
   * together — a navigate and the pane opening, say — each open a page and the
   * second overwrites the first in `tabs`. The result is an orphaned renderer
   * and subscribers split across two pages, one of which nothing will ever
   * drive again.
   */
  private readonly pendingTabs = new Map<string, Promise<TabEntry | null>>();
  /**
   * Teardown has begun; no new page is opened on this browser.
   *
   * `close()` can only settle the creations it can SEE. Without a latch, a
   * caller arriving one tick later opens a page after the sweep has run and
   * leaves a renderer nobody will ever close — the exact leak `pendingTabs`
   * was added to prevent, moved one step later.
   */
  private closing = false;

  constructor(context: DriverContext, options: ChromiumDriverOptions = {}) {
    this.context = context;
    this.settleOptions = options.settle ?? DEFAULT_SETTLE_OPTIONS;
    this.a11yBudget = options.a11y ?? DEFAULT_A11Y_BUDGET;
    this.consoleBudget = options.console ?? DEFAULT_CONSOLE_BUDGET;
    this.webmcpOutputBudgetBytes =
      options.webmcpOutputBytes ?? DEFAULT_WEBMCP_OUTPUT_BYTES;
    this.pageTextMaxBytes = options.pageTextBytes ?? DEFAULT_PAGE_TEXT_MAX_BYTES;
    this.lease = options.lease;
  }

  async execute(command: BrowserCommand): Promise<BrowserCommandResult> {
    // W4/L6 — before ANYTHING can read, discard what a person's handoff left
    // behind. The 423 gate stops an agent observing DURING a handoff, but the
    // console ring fills from an eager page listener that knows nothing about
    // leases, so a token or a form value the page logged while someone signed
    // in would otherwise be readable the instant they hand back. Doing it here
    // rather than in the console branch covers every future reader too.
    this.purgeHandoffConsole();
    // The third and last gate (handler → dequeue → here). A command that got
    // this far while a person holds the browser must not run: `execute` is
    // where the page is actually touched.
    const permit = this.permitFor(command);
    if (!permit()) {
      return this.leaseBlockedResult(
        "a person took control of this browser before this action ran; nothing was run and nothing was observed",
      );
    }
    const tabId = command.tabId ?? DEFAULT_TAB;
    const action = command.action;
    switch (action.kind) {
      case "navigate": {
        // `navigate` is the only verb that may CREATE a tab (P2).
        if (action.newTab) {
          // A new tab needs a NAME the caller chose, because the tabId is the
          // addressing mechanism for everything that follows. Reusing an
          // existing one would silently replace that tab's page — the exact
          // confusion this branch exists to prevent.
          if (command.tabId === undefined) {
            return {
              ok: false,
              error:
                "newTab requires an explicit tabId to address the new tab by",
            };
          }
          const existing = this.tabs.get(tabId);
          if (existing && !existing.page.isClosed()) {
            return {
              ok: false,
              error: `tab_exists: ${tabId} — omit newTab to navigate it, or choose another tabId`,
            };
          }
        }
        const entry = await this.getOrCreateTab(tabId);
        if (!entry) {
          return {
            ok: false,
            error: formatBrowserdError(
              "driver_closed",
              "this browser is shutting down; no new tab was opened",
            ),
          };
        }
        return this.navigateVerb(
          tabId,
          entry,
          (page) => page.goto(action.url),
          permit,
        );
      }
      case "back":
      case "reload": {
        // back/reload act on an EXISTING tab only — an unknown tabId is an error,
        // not a reason to conjure a fresh about:blank page (P2).
        const entry = this.tabs.get(tabId);
        if (!entry || entry.page.isClosed()) {
          return { ok: false, error: `unknown_tab: ${tabId}` };
        }
        return this.navigateVerb(
          tabId,
          entry,
          (page) => (action.kind === "back" ? page.goBack() : page.reload()),
          permit,
        );
      }
      case "observe":
        return this.observe(tabId, action, permit);
      case "act":
        return this.act(tabId, action, permit);
      case "webmcp_invoke":
        return this.webmcpInvoke(tabId, action, permit);
      case "webmcp_cancel":
        return this.webmcpCancel(tabId, action, permit);
    }
  }

  /**
   * Run one act verb, then FOLD THE OBSERVATION IN (L1): every act settles and
   * returns the post-act screenshot + URL with a fresh state token, so the
   * model never has to spend a turn asking "what happened?" — and the token it
   * gets back is the one its NEXT act should be pinned to.
   *
   * L3 staleness is enforced upstream by `guardStaleness`, which compares the
   * act's `expectedState` before this runs.
   */
  private async act(
    tabId: string,
    action: Extract<BrowserAction, { kind: "act" }>,
    permit: () => boolean,
  ): Promise<BrowserCommandResult> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    const page = entry.page;

    // Tab lifecycle verbs do not produce an observation of their own tab.
    if (action.verb === "close_tab") {
      await page.close().catch(() => {});
      await this.dropTab(tabId);
      return { ok: true, output: { closed: tabId } };
    }
    if (action.verb === "activate_tab") {
      await page.bringToFront();
      const frame = await this.snapshot(page);
      return this.observation(tabId, entry, { url: frame.url }, frame, permit);
    }

    try {
      await this.dispatchVerb(page, action);
    } catch (error) {
      // A target that cannot be resolved is a NORMAL answer the model must be
      // able to act on ("the button isn't there"), not a daemon fault — and
      // Playwright's own timeout prose would just confuse it.
      const message = error instanceof Error ? error.message : String(error);
      const kind = /timeout|not found|no element|strict mode/i.test(message)
        ? "target_not_found"
        : "act_failed";
      // Same rule as the success path: the act may have failed, but the page
      // it failed on can still be someone's now. `permit()` decides whether we
      // may say anything about it beyond "it failed" — asked before the read
      // to avoid making it, and again after, because the read is an await and
      // a handoff can land inside it.
      const before = permit()
        ? await this.snapshot(page).catch(() => null)
        : null;
      const frame = permit() ? before : null;
      return {
        ok: false,
        error: `${kind}: ${message.split("\n")[0]}`,
        // Hand back the CURRENT state anyway: a failed act still moves the
        // model forward if it can see what the page actually looks like. It
        // carries the handoff note too — an act that failed right after a
        // person used the browser most likely failed BECAUSE the page is now
        // somewhere else, and "your click missed" would be the wrong lesson.
        ...(frame
          ? {
              stateToken: this.tokenFor(tabId, entry, frame),
              output: this.withHandoffNote({ url: frame.url }),
            }
          : {}),
      };
    }

    const settled = await this.settle(page);
    // The act RAN. If a person took the browser while the page settled, we
    // still owe the caller an honest answer — but not a picture of whatever
    // they are doing now. Say what happened and hand back nothing else.
    if (!permit()) {
      return this.leaseBlockedResult(
        "the action ran, but a person took control of this browser before its result could be observed; re-observe after they hand it back",
      );
    }
    const frame = await this.snapshot(page);
    const screenshot = await page.screenshotBase64().catch(() => undefined);
    return {
      ...this.observation(
        tabId,
        entry,
        { url: frame.url, ...(screenshot ? { screenshot } : {}) },
        frame,
        permit,
        "the action ran, but a person took control of this browser before its result could be observed; re-observe after they hand it back",
      ),
      settled,
    };
  }

  /** Map an act verb onto the page primitives. */
  private async dispatchVerb(
    page: DriverPage,
    action: Extract<BrowserAction, { kind: "act" }>,
  ): Promise<void> {
    const target = action.target;
    const point =
      target && "coordinates" in target
        ? { x: target.coordinates[0], y: target.coordinates[1] }
        : null;
    if (point && !isPointInViewport(point.x, point.y)) {
      // Refuse rather than dispatch. Chromium delivers a mouse event outside
      // the viewport quite happily; it hits nothing, and the caller reads an
      // ordinary post-act observation that looks exactly like a click landing
      // on empty space. The daemon is the authority on the coordinate space,
      // so the refusal lives here and not only in the tool schema — the panel
      // and the v1 bridge reach this same path.
      throw new Error(
        `out_of_viewport: (${point.x}, ${point.y}) is outside the ` +
          `${BROWSERD_OBSERVATION_VIEWPORT.width}x${BROWSERD_OBSERVATION_VIEWPORT.height} ` +
          "observation viewport; coordinates are CSS pixels with (0, 0) at the " +
          "top-left of the last screenshot",
      );
    }
    const selector = target && "selector" in target ? target.selector : null;
    if (target && "a11yRef" in target) {
      // Deferred deliberately: a ref that silently drifts across a re-render
      // is worse than one the model cannot use at all.
      throw new Error(
        "unsupported_target: a11yRef targeting is not available; use coordinates or a selector",
      );
    }

    switch (action.verb) {
      case "click":
        if (point) return page.clickAt(point);
        if (selector) return page.clickSelector(selector);
        throw new Error("no element: click needs coordinates or a selector");
      case "hover":
        if (point) return page.hoverAt(point);
        if (selector) return page.hoverSelector(selector);
        throw new Error("no element: hover needs coordinates or a selector");
      case "type": {
        const text = action.value ?? "";
        // With a selector, REPLACE the field's value; without one, type into
        // whatever has focus (the model's previous click).
        if (selector) return page.fillSelector(selector, text);
        return page.typeText(text);
      }
      case "press":
        if (!action.value) throw new Error("press needs a key in `value`");
        return page.press(action.value);
      case "scroll": {
        // Default to one viewport-ish step down, the overwhelmingly common
        // intent, so a bare `scroll` does something useful.
        const [dx, dy] = parseScrollDelta(action.value);
        return page.scrollBy({ dx, dy });
      }
      case "drag": {
        if (!point) throw new Error("drag needs start coordinates");
        const to = parsePoint(action.value);
        if (!to) {
          throw new Error(
            'drag needs a destination in `value` as "x,y" (viewport coordinates)',
          );
        }
        if (!isPointInViewport(to.x, to.y)) {
          // The destination rides in a string and so bypasses the check above;
          // a drag ending off-viewport drops its payload on nothing.
          throw new Error(
            `out_of_viewport: drag destination (${to.x}, ${to.y}) is outside the ` +
              `${BROWSERD_OBSERVATION_VIEWPORT.width}x${BROWSERD_OBSERVATION_VIEWPORT.height} ` +
              "observation viewport",
          );
        }
        return page.dragTo(point, to);
      }
      case "select":
        if (!selector) throw new Error("select needs a selector");
        if (action.value === undefined) {
          throw new Error("select needs the option value in `value`");
        }
        return page.selectOption(selector, action.value);
      case "close_tab":
      case "activate_tab":
        // Handled by the caller before dispatch.
        return;
    }
  }

  private async webmcpInvoke(
    tabId: string,
    action: Extract<BrowserAction, { kind: "webmcp_invoke" }>,
    permit: () => boolean,
  ): Promise<BrowserCommandResult> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    const bridge = await entry.page.webmcp();
    if (!bridge || !bridge.isSupported()) {
      return {
        ok: false,
        error:
          "webmcp_unsupported: this page (or this browser build) does not expose WebMCP tools",
      };
    }
    // Before the CALL, not only before its result: resolving the bridge is an
    // await, and a page's own tool changes the page — running one under
    // somebody else's hands is the agent acting during a handoff, whatever we
    // then decide to return.
    if (!permit()) {
      return this.leaseBlockedResult(
        "a person took control of this browser before the page's tool could be called; nothing was run",
      );
    }
    try {
      const { invocationId, output } = await bridge.invoke({
        toolName: action.toolKey,
        // Forwarded so a subframe's tool is not shadowed by a same-named one
        // in the main frame. `invoke` falls back to name resolution when it is
        // absent or when the frame no longer offers the tool, so an older
        // caller that sends no frame still works.
        ...(action.frameId ? { frameId: action.frameId } : {}),
        input: action.input,
      });
      const { output: capped, omitted } = capToolOutput(
        output,
        this.webmcpOutputBudgetBytes,
      );
      const frame = await this.snapshot(entry.page);
      return {
        ...this.observation(
          tabId,
          entry,
          { invocationId, result: capped, ...(omitted ? { omitted } : {}) },
          frame,
          permit,
          "the page's tool ran, but a person took control of this browser before its result could be read; re-run it after they hand it back",
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof WebMcpBridgeError
            ? `${error.failure}: ${error.message}`
            : `webmcp_error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async webmcpCancel(
    tabId: string,
    action: Extract<BrowserAction, { kind: "webmcp_cancel" }>,
    permit: () => boolean,
  ): Promise<BrowserCommandResult> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    const bridge = await entry.page.webmcp();
    if (!bridge) {
      return { ok: false, error: "webmcp_unsupported: no WebMCP session" };
    }
    // Cancelling reaches into the page, and `bridge.webmcp()` above was an
    // await — so the permit is re-asked here even though this verb returns no
    // observation of its own.
    if (!permit()) {
      return this.leaseBlockedResult(
        "a person took control of this browser before the cancellation could be delivered",
      );
    }
    const known = await bridge.cancel(action.invocationId);
    return { ok: true, output: { cancelled: known } };
  }

  /**
   * Run a navigation on an already-resolved tab, bump its nav counter, settle
   * the page (L2), and return the post-settle observation with its state token
   * (L3). Every W1 navigating verb funnels through here so settle + token are
   * never skipped. Tab creation is the caller's decision (only `navigate`).
   */
  private async navigateVerb(
    tabId: string,
    entry: TabEntry,
    navigate: (page: DriverPage) => Promise<void>,
    permit: () => boolean,
  ): Promise<BrowserCommandResult> {
    await navigate(entry.page);
    entry.navCounter += 1;
    const settled = await this.settle(entry.page);
    if (!permit()) {
      return this.leaseBlockedResult(
        "the navigation ran, but a person took control of this browser before the page could be observed; re-observe after they hand it back",
      );
    }
    const frame = await this.snapshot(entry.page);
    return {
      ...this.observation(
        tabId,
        entry,
        { url: frame.url },
        frame,
        permit,
        "the navigation ran, but a person took control of this browser before the page could be observed; re-observe after they hand it back",
      ),
      settled,
    };
  }

  private async observe(
    tabId: string,
    action: Extract<BrowserAction, { kind: "observe" }>,
    permit: () => boolean,
  ): Promise<BrowserCommandResult> {
    if (!permit()) {
      return this.leaseBlockedResult(
        "a person has taken control of this browser; nothing was observed",
      );
    }
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    switch (action.mode) {
      case "url": {
        const frame = await this.snapshot(entry.page);
        return this.observation(tabId, entry, { url: frame.url }, frame, permit);
      }
      case "dom": {
        // The token is computed from the SAME snapshot returned as output, so
        // they cannot disagree.
        const frame = await this.snapshot(entry.page);
        return this.observation(
          tabId,
          entry,
          { dom: frame.domSignal },
          frame,
          permit,
        );
      }
      case "screenshot":
        return this.observeScreenshot(tabId, entry, permit);
      case "text": {
        return this.observeText(tabId, entry, permit);
      }
      case "a11y": {
        // L9: the tree is reduced by omitting WHOLE subtrees (each replaced by
        // a marker naming the retrieval verb), never by cutting one open.
        const snapshot = await entry.page.a11ySnapshot(action.rootSelector);
        if (action.rootSelector && snapshot === null) {
          // The retrieval verb the omission marker names must fail LOUDLY when
          // its selector finds nothing. Returning an empty tree would read as
          // "that subtree is empty" — the opposite of "your selector was
          // wrong" — and the caller would believe the page, not retry.
          return {
            ok: false,
            error:
              `unknown_selector: nothing on this page matches ` +
              `"${action.rootSelector}"; re-observe the page and pick a ` +
              `selector from what it shows`,
          };
        }
        const frame = await this.snapshot(entry.page);
        const { tree, omittedSubtrees, totalNodes } = capA11yTree(
          snapshot,
          this.a11yBudget,
        );
        return this.observation(
          tabId,
          entry,
          {
            a11y: tree,
            ...(omittedSubtrees > 0 ? { omittedSubtrees, totalNodes } : {}),
          },
          frame,
          permit,
        );
      }
      case "console": {
        const { entries, omitted } = capConsole(
          entry.page.consoleEntries(),
          this.consoleBudget,
        );
        const frame = await this.snapshot(entry.page);
        return this.observation(
          tabId,
          entry,
          { console: entries, ...(omitted > 0 ? { omitted } : {}) },
          frame,
          permit,
        );
      }
      case "webmcp_tools": {
        const bridge = await entry.page.webmcp();
        const frame = await this.snapshot(entry.page);
        if (!bridge || !bridge.isSupported()) {
          // NOT an error: "this page offers no WebMCP tools" is a legitimate
          // and common answer, and the model should carry on driving the page
          // rather than treating cooperation as a precondition.
          return this.observation(
            tabId,
            entry,
            { webmcpSupported: false, tools: [] },
            frame,
            permit,
          );
        }
        return this.observation(
          tabId,
          entry,
          { webmcpSupported: true, tools: bridge.list() },
          frame,
          permit,
        );
      }
    }
  }

  /**
   * Read the page's text, with a token that describes the state it was read
   * from (P1) — the same guarantee `observeScreenshot` gives an image.
   *
   * Without the before/after sample, a page that navigated or re-rendered
   * while the read was in flight returns the OLD prose under a token minted
   * from the NEW state. `guardStaleness` would then admit an act chosen from
   * text the page no longer shows, which is precisely the class of bug the
   * state token exists to prevent.
   *
   * Prose is CUT rather than omitted. The a11y budget can drop a whole subtree
   * because a tree has boundaries to drop at; running text has none, and a cut
   * string with a counted marker is honest about exactly that.
   */
  private async observeText(
    tabId: string,
    entry: TabEntry,
    permit: () => boolean,
  ): Promise<BrowserCommandResult> {
    const STABLE_ATTEMPTS = 2;
    let before = await this.snapshot(entry.page);
    for (let attempt = 0; attempt < STABLE_ATTEMPTS; attempt += 1) {
      const text = await entry.page.pageText();
      const after = await this.snapshot(entry.page);
      const output = this.cappedText(text);
      // Both must hold: a same-skeleton client-side route change moves the URL
      // while `domSignal` does not, and would bind a new-route token to
      // old-route prose (P1).
      if (before.url === after.url && before.domSignal === after.domSignal) {
        return this.observation(tabId, entry, output, after, permit);
      }
      before = after;
    }
    // Would not hold still within budget: hand the prose back but flag it
    // unsettled, so nothing pins an act to text the page may have moved past.
    if (!permit()) {
      return this.leaseBlockedResult(
        "a person has taken control of this browser; nothing was observed",
      );
    }
    const text = await entry.page.pageText();
    const after = await this.snapshot(entry.page);
    return {
      ...this.observation(tabId, entry, this.cappedText(text), after, permit),
      settled: false,
    };
  }

  /** The text observation's payload, cut to budget with the counted marker. */
  private cappedText(text: string): Record<string, unknown> {
    const capped = capText(
      text,
      this.pageTextMaxBytes,
      PAGE_TEXT_RETRIEVAL_HINT,
    );
    return { text: capped, ...(capped !== text ? { truncated: true } : {}) };
  }

  /**
   * Capture a screenshot whose state token provably describes the SAME frame the
   * image shows (P1). The DOM is sampled before and after the capture; if it
   * shifted mid-capture, the image and a fresh token would disagree — an act
   * chosen from the stale image could then slip past `guardStaleness` — so we
   * retry, and if the page will not hold still we return the frame with
   * `settled: false` (its token from the post-capture read) so the caller
   * re-observes rather than pinning an act to it.
   */
  private async observeScreenshot(
    tabId: string,
    entry: TabEntry,
    permit: () => boolean,
  ): Promise<BrowserCommandResult> {
    const STABLE_ATTEMPTS = 2;
    for (let attempt = 0; attempt < STABLE_ATTEMPTS; attempt++) {
      // Re-checked per attempt: this loop captures more than once, and a
      // handoff between attempts must stop the next one.
      if (!permit()) {
        return this.leaseBlockedResult(
          "a person has taken control of this browser; nothing was observed",
        );
      }
      const before = await this.snapshot(entry.page);
      const screenshot = await entry.page.screenshotBase64();
      const after = await this.snapshot(entry.page);
      // Both the URL and the DOM must be unchanged: a same-skeleton client-side
      // route change moves the URL while `domSignal` holds, and would otherwise
      // bind a new-route token to an old-route image (P1).
      if (before.url === after.url && before.domSignal === after.domSignal) {
        return this.observation(tabId, entry, { screenshot }, after, permit);
      }
    }
    // Would not stabilise within budget: hand back the frame but flag it unsettled
    // so nothing pins an act to a possibly-stale image.
    // The one capture in this method that is NOT inside the loop, and so was
    // the one the per-attempt check above could not cover: a handoff landing
    // during the final attempt would otherwise be photographed here.
    if (!permit()) {
      return this.leaseBlockedResult(
        "a person has taken control of this browser; nothing was observed",
      );
    }
    const screenshot = await entry.page.screenshotBase64();
    const after = await this.snapshot(entry.page);
    return {
      ...this.observation(tabId, entry, { screenshot }, after, permit),
      settled: false,
    };
  }

  async currentStateToken(tabId: string | undefined) {
    const entry = this.tabs.get(tabId ?? DEFAULT_TAB);
    if (!entry) return undefined;
    return computeStateToken({
      tabId: tabId ?? DEFAULT_TAB,
      navCounter: entry.navCounter,
      url: entry.page.url(),
      domSignal: await entry.page.domStructureSignal(),
    });
  }

  /**
   * The live picture of a tab.
   *
   * Deliberately NOT routed through the command queue. Input arrives as
   * pointer batches at up to twenty a second while someone drags a scrollbar,
   * and every command consumes an idempotency slot from a per-boot ledger that
   * refuses new ids once exhausted — a person scrolling for a few minutes
   * would rotate the daemon. The lease is the gate on this path instead, which
   * is the right one: it is the person's own hands, and the lease is what says
   * the hands are theirs.
   */
  async viewport(tabId?: string): Promise<TabViewport | null> {
    const key = tabId ?? DEFAULT_TAB;
    const live = this.tabs.get(key);
    if (live && !live.page.isClosed()) {
      const cached = this.viewports.get(key);
      if (cached) return cached;
    } else {
      // The page this viewport watched is gone. Retire it here as well as at
      // `close_tab`, because a page can also close itself (`window.close()`,
      // a crashed renderer) with nothing routed through the driver.
      await this.dropViewport(key);
    }
    // OPENS the tab when it does not exist yet, unlike every model-facing
    // verb but `navigate`. Someone opening the pane before the agent has done
    // anything should see the browser's blank startup page, not an error —
    // and they need a page to exist before they can take control and type a
    // URL into it. An explicit tabId that names no tab is still unknown.
    const entry =
      tabId === undefined || key === DEFAULT_TAB
        ? await this.getOrCreateTab(key)
        : this.tabs.get(key);
    if (!entry || entry.page.isClosed()) return null;
    // Re-read after the await: a concurrent caller resuming from the same
    // `getOrCreateTab` promise may already have attached one, and two
    // screencasts on one page is two encoders for one picture.
    const raced = this.viewports.get(key);
    if (raced) return raced;
    const created = (async () => {
      const cdp = await entry.page.cdp();
      if (!cdp) return null;
      return createTabViewport(cdp, {
        surface: BROWSERD_OBSERVATION_VIEWPORT,
      });
    })();
    this.viewports.set(key, created);
    return created;
  }

  async health(): Promise<DriverHealth> {
    return this.context.isConnected()
      ? { ok: true }
      : { ok: false, detail: "browser context disconnected" };
  }

  async close(): Promise<void> {
    // Refuse new pages from here on, so nothing can register behind the sweep.
    this.closing = true;
    // A tab creation already awaiting `newPage()` would otherwise register its
    // page after this ran, leaving a renderer nobody closes for the life of
    // the browser. Settle them first, then let the sweep below take whatever
    // they added — but BOUNDED: `newPage()` against a browser that has stopped
    // answering never settles, and teardown is on the server's shutdown path,
    // where waiting forever means the process never exits and Chromium is
    // orphaned. Whatever has not landed by the deadline is dropped instead;
    // the latch above is what makes dropping it safe.
    await Promise.race([
      Promise.allSettled([...this.pendingTabs.values()]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_PENDING_TAB_GRACE_MS);
        // Never the reason the process stays alive.
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    for (const viewport of this.viewports.values()) {
      await viewport.then((v) => v?.dispose()).catch(() => {});
    }
    this.viewports.clear();
    for (const entry of this.tabs.values()) {
      if (!entry.page.isClosed()) await entry.page.close().catch(() => {});
    }
    this.tabs.clear();
    await this.context.close().catch(() => {});
  }

  /**
   * Build an observation result whose L3 state token is computed from the SAME
   * frame snapshot (url + DOM) the caller captured the output against — passed
   * in, never re-read here — so the token can never describe a different state
   * than the returned output (P1).
   */
  /**
   * The ONE funnel every page-derived result leaves through — which is why the
   * last permit check lives here rather than at each caller.
   *
   * Every observation is read from the page across at least one `await`, and a
   * check made before that await can only say the lease was free when the read
   * STARTED. Asking again here, on the result's way out, is what makes "while a
   * person holds the browser the agent observes nothing" true rather than
   * nearly true: whatever was read is dropped instead of returned. Callers
   * keep their own earlier checks — those refuse cheaply, before the read —
   * and pass the prose that fits what already happened.
   */
  private observation(
    tabId: string,
    entry: TabEntry,
    output: Record<string, unknown>,
    frame: FrameSnapshot,
    permit: () => boolean,
    blockedDetail = "a person took control of this browser while this was running; the result was discarded and nothing was observed",
  ): BrowserCommandResult {
    if (!permit()) return this.leaseBlockedResult(blockedDetail);
    return {
      ok: true,
      // WHERE this came from, on every observation without exception. The
      // unattended origin allowlist is enforced against the result's `url`
      // (`enforceResultOrigin` in built-in-tools/browser.ts), and a result
      // carrying none fails that check OPEN — a screenshot of an off-allowlist
      // page would reach the model unfiltered. Stamped at the funnel so no
      // future observation mode can forget it. An explicit `url` in `output`
      // still wins; today it is the same value.
      output: this.withHandoffNote({ url: frame.url, ...output }),
      stateToken: this.tokenFor(tabId, entry, frame),
    };
  }

  /**
   * L6 — LOUD RESUME. The first result after a person handed the browser back
   * says so, explicitly naming auth and cookies: the common handoff is a
   * login, and "something may have changed" would understate exactly the
   * change that just happened. Consumed once, so it marks the result that
   * actually crossed the handoff rather than every later one.
   */
  private withHandoffNote(output: Record<string, unknown>) {
    return this.lease?.consumeResumedDirty()
      ? {
          ...output,
          handoffNote: handoffNoteFor(this.lease.resumedFromKind()),
        }
      : output;
  }

  /**
   * May THIS command look at the page right now?
   *
   * Bound to the command rather than read globally, because "a lease is held"
   * is not the same as "you may not look": the holder's own `manual` commands
   * are exactly what a lease is for. It is the same predicate the handler and
   * the dequeue guard ask, asked a third time — and passed down as a closure
   * rather than stored on the instance, because two tabs run concurrently and
   * a shared field would answer one command's question with another's.
   *
   * Asked immediately before EVERY capture rather than once per command: a
   * command can take seconds (a navigation settles for up to ten), and the
   * handoff it must respect is the one happening NOW.
   */
  private permitFor(command: BrowserCommand): () => boolean {
    const lease = this.lease;
    if (!lease) return () => true;
    return () => leaseRefusalFor(lease.state(), command) === undefined;
  }

  /** The result a capture-time handoff produces: no output, no token, no frame. */
  private leaseBlockedResult(detail: string): BrowserCommandResult {
    return {
      ok: false,
      leaseBlocked: true,
      error: formatBrowserdError("lease_held", detail),
    };
  }

  /**
   * Drop console captured while a person held the browser, across EVERY tab —
   * they may have opened one, and a leak in a tab nobody was watching is
   * still a leak. Consumed once per handoff.
   */
  private purgeHandoffConsole(): void {
    const since = this.lease?.consumeResumedHeldSince?.();
    if (since === undefined) return;
    for (const entry of this.tabs.values()) {
      if (entry.page.isClosed()) continue;
      try {
        entry.page.dropConsoleSince(since);
      } catch {
        // A page that cannot be purged must not take the command down; the
        // budgeted console read that follows is capped either way.
      }
    }
  }

  /** The L3 token for a frame snapshot the caller already captured. */
  private tokenFor(tabId: string, entry: TabEntry, frame: FrameSnapshot) {
    return computeStateToken({
      tabId,
      navCounter: entry.navCounter,
      url: frame.url,
      domSignal: frame.domSignal,
    });
  }

  /** Read a tab's URL and DOM signal together, as one frame snapshot. */
  private async snapshot(page: DriverPage): Promise<FrameSnapshot> {
    const url = page.url();
    const domSignal = await page.domStructureSignal();
    return { url, domSignal };
  }

  private async settle(page: DriverPage): Promise<boolean> {
    const steps: SettleSteps = {
      // goto/reload/goBack already awaited the document commit.
      waitForCommit: async () => {},
      waitForNetworkQuiet: (signal) => page.waitForNetworkIdle(signal),
      waitForAnimationFrame: (signal) => page.requestAnimationFrame(signal),
    };
    const { settled } = await settlePage(steps, this.settleOptions);
    return settled;
  }

  /** `null` means teardown has begun and no new page will be opened. */
  private async getOrCreateTab(tabId: string): Promise<TabEntry | null> {
    const existing = this.tabs.get(tabId);
    if (existing && !existing.page.isClosed()) return existing;
    const inFlight = this.pendingTabs.get(tabId);
    if (inFlight) return inFlight;
    if (this.closing) return null;
    const creating = (async () => {
      // Replacing a closed tab retires everything attached to the old page —
      // its viewport is bound to a CDP session that will never speak again.
      await this.dropTab(tabId);
      const page = await this.context.newPage();
      // `newPage()` is an await, so the close may have started — and finished
      // its sweep — inside it. Registering now is exactly the orphaned
      // renderer this guards against, so close the page instead of keeping it.
      if (this.closing) {
        await page.close().catch(() => {});
        return null;
      }
      const entry: TabEntry = { page, navCounter: 0 };
      this.tabs.set(tabId, entry);
      return entry;
    })();
    this.pendingTabs.set(tabId, creating);
    try {
      return await creating;
    } finally {
      this.pendingTabs.delete(tabId);
    }
  }

  /** Forget a tab and everything attached to it. */
  private async dropTab(tabId: string): Promise<void> {
    this.tabs.delete(tabId);
    await this.dropViewport(tabId);
  }

  /**
   * Retire a tab's viewport.
   *
   * The cache is keyed by tabId but its contents belong to a PAGE. A closed or
   * replaced tab left its viewport in place, still holding the dead page's CDP
   * session: it published no more frames and swallowed the new page's input,
   * so the recreated tab could be neither watched nor driven.
   */
  private async dropViewport(tabId: string): Promise<void> {
    const viewport = this.viewports.get(tabId);
    if (!viewport) return;
    this.viewports.delete(tabId);
    await viewport.then((v) => v?.dispose()).catch(() => {});
  }
}
