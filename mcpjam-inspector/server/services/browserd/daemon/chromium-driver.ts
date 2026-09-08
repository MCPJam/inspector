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
  type WebMcpToolsRevision,
  isPointInViewport,
  type BrowserAction,
  type BrowserCommand,
  type BrowserCommandResult,
} from "../protocol";
import type { BrowserDriver, DriverHealth } from "./browser-driver";
import type { ActPoint, DriverContext, DriverPage } from "./browser-page";
import { computeStateToken, shortHash } from "./state-token";
import type { A11yNode } from "./observation-budget";
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
import { readAxTree, resolveBackendNodeId } from "./cdp-a11y";
import {
  assignRefs,
  filterInteractive,
  parseRef,
  type RefMap,
} from "./a11y-refs";
import { renderA11yTree } from "./a11y-render";
import {
  WebMcpBridgeError,
  type WebMcpBridge,
  type WebMcpToolDescriptor,
} from "./webmcp-bridge";
import {
  declaredToolsFromWebmcp,
  declaredToolsHash,
} from "../../../../shared/declared-tools";
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
  /** What this tab's page currently offers over WebMCP. */
  webmcp: TabWebmcpState;
}

/**
 * A tab's WebMCP tool set, kept current by a PUSH subscription on the bridge.
 *
 * The point of caching it is that "did the page's tools change?" becomes a
 * question the server can ask before every model step for free. The alternative
 * — an `observe {mode:"webmcp_tools"}` per step — reaches into the page, settles
 * it, and costs a round trip to usually learn nothing; run on a loop it would
 * also be an observation with side effects on the thing it observes.
 */
interface TabWebmcpState {
  /**
   * Bumps on every change the bridge reports (added, removed, navigated,
   * detached) AND on every navigation this driver performs.
   *
   * Both, because they are different events that can occur without each other:
   * a page can register a tool with no navigation, and a navigation to a page
   * with no tools at all produces an empty set that is nonetheless a NEW
   * generation, against which every existing binding is void.
   */
  revision: number;
  supported: boolean;
  tools: WebMcpToolDescriptor[];
  /** Detaches the bridge subscription when the tab goes away. */
  unsubscribe?: () => void;
  /** The in-flight (or completed) eager attach, so it happens once. */
  attaching?: Promise<void>;
}

function emptyWebmcpState(): TabWebmcpState {
  return { revision: 0, supported: false, tools: [] };
}

/**
 * How many `commandId -> invocationId` pairs to remember.
 *
 * Bounded but generous, and entries are NOT dropped when an invocation
 * settles: a cancel that races a completion must be able to answer "that
 * already finished" rather than "I have never heard of that command", which is
 * what a caller reads as "the cancel did not work".
 */
const MAX_TRACKED_INVOCATIONS = 256;

/**
 * How many cancelled-before-it-ran intents to hold, and for how long.
 *
 * A Stop can land while its invoke is still QUEUED behind another command on
 * the same tab, when there is nothing in flight to latch onto. The intent has
 * to wait somewhere for the command to be dequeued, and a cancel for a command
 * that never arrives (it failed upstream, or never existed) must not wait
 * forever — so both a ceiling and a TTL, and eviction never takes a latch that
 * guards a running invocation.
 */
const MAX_PENDING_CANCELS = 64;
const PENDING_CANCEL_TTL_MS = 60_000;

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
    | "consumeResumedDirty"
    | "consumeResumedHeldSince"
    | "resumedFromKind"
    | "state"
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

/**
 * How much of a tab list may ride the heartbeat.
 *
 * The heartbeat is a frame-stream record, and a record over 8 KiB is REJECTED
 * by the reader as `record too large` — which drops an otherwise healthy
 * pane's whole stream. A page that opens twenty tabs with long URLs is not a
 * reason for the picture to stop, so the strip is bounded here rather than
 * discovered at the decoder.
 */
const TABS_SNAPSHOT_MAX = 16;
/** And each URL: the strip shows a HOST, so a path is already more than it needs. */
const TAB_URL_MAX = 256;
/**
 * And the whole strip, in bytes of JSON.
 *
 * Counting entries is not the same as bounding cost: a tab id is whatever the
 * CALLER asked for — `getOrCreateTab` opens a page under any string — so
 * sixteen tabs named with a kilobyte each is a heartbeat over the reader's
 * limit and a stream that dies on a record it cannot take. Well under the 8
 * KiB the reader allows, because the strip is not the only field in that
 * message.
 */
const TABS_SNAPSHOT_BYTES = 4_096;
/** `{"id":"","url":""},` — what one entry costs beyond its two strings. */
const TAB_ENTRY_OVERHEAD = 24;

/**
 * Which entry a bound drops: the last, unless the last is the one on screen.
 *
 * The active tab goes only when it is all that is left — one entry over the
 * bound on its own is not a tab anybody opened by hand, and no strip is better
 * than no stream.
 */
function dropIndex(
  list: ReadonlyArray<{ id: string }>,
  activeTabId: string | undefined,
): number {
  const last = list.length - 1;
  return list[last]?.id === activeTabId && list.length > 1 ? last - 1 : last;
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
   * Which tab is on screen.
   *
   * Load-bearing only for the HUMAN pane's video, which grabs the X display and
   * therefore always shows whatever tab Chromium is displaying. A model
   * `activate_tab` changes what a watching person sees, and without this the
   * pane could not say so — the picture would simply become a different page.
   */
  private activeTabId: string | undefined;
  /**
   * One viewport per tab, created on first watch.
   *
   * Lazy for the same reason the WebMCP bridge is: attaching a CDP session and
   * encoding JPEGs for a tab nobody is looking at is work done for nobody.
   */
  private readonly viewports = new Map<string, Promise<TabViewport | null>>();
  /**
   * The refs the LAST a11y observation of each tab handed out.
   *
   * One map per tab, replaced whole on every observation. It is state the
   * driver must own rather than the model: a ref the model made up, or one it
   * kept from two observations ago, has to be refusable — and only the side
   * that minted them can tell the difference.
   */
  private readonly refs = new Map<string, RefMap>();
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
  /**
   * `commandId -> invocationId`, recorded the instant the browser accepts an
   * invocation.
   *
   * The whole cancellation path hangs off this. `webmcp_invoke` is synchronous
   * — it does not return an invocation id until the page's tool has SETTLED —
   * so a caller wanting to stop a running tool has never known what to name.
   * Its own `commandId` is the one id it holds before the call, so that is the
   * handle `webmcp_cancel` takes.
   */
  private readonly invocationsByCommand = new Map<
    string,
    { tabId: string; invocationId: string }
  >();
  /**
   * Commands whose cancellation arrived before their invocation could act on
   * it, mapped to when that intent expires.
   *
   * Three moments a cancel BY ID cannot reach: while the invoke is still
   * queued behind another command on its tab, while it is dequeued but the
   * browser has not yet named the invocation, and the gap between. All three
   * latch here; `webmcpInvoke` consults the latch on entry, so a command
   * cancelled before it ran never touches the page, and `rememberInvocation`
   * consults it when the id arrives. Bounded by `MAX_PENDING_CANCELS` and
   * `PENDING_CANCEL_TTL_MS` (see `latchCancel`); a latch guarding a running
   * invocation is never evicted and never expires.
   */
  private readonly pendingCancels = new Map<string, number>();
  /**
   * Commands whose `webmcp_invoke` is in flight RIGHT NOW.
   *
   * Registered at dequeue, cleared in the `finally`. This is what protects a
   * latch in `pendingCancels` from eviction and expiry: an intent for a
   * running command is live for as long as the command is.
   */
  private readonly activeInvocations = new Set<string>();

  constructor(context: DriverContext, options: ChromiumDriverOptions = {}) {
    this.context = context;
    this.settleOptions = options.settle ?? DEFAULT_SETTLE_OPTIONS;
    this.a11yBudget = options.a11y ?? DEFAULT_A11Y_BUDGET;
    this.consoleBudget = options.console ?? DEFAULT_CONSOLE_BUDGET;
    this.webmcpOutputBudgetBytes =
      options.webmcpOutputBytes ?? DEFAULT_WEBMCP_OUTPUT_BYTES;
    this.pageTextMaxBytes =
      options.pageTextBytes ?? DEFAULT_PAGE_TEXT_MAX_BYTES;
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
        return this.webmcpInvoke(tabId, action, permit, command.commandId);
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
      this.activeTabId = tabId;
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
    commandId: string,
  ): Promise<BrowserCommandResult> {
    // REGISTERED FIRST, before anything that can await.
    //
    // This set answers "is this command in flight", and the honest answer from
    // the moment it is dequeued is yes. Registering it later — after the bridge
    // resolve and the probe settle, as a first attempt did — left a window in
    // which a Stop found nothing to latch onto, was dropped, and the invoke
    // then proceeded under a cancellation that had already arrived. Every exit
    // below is inside the `finally`, so an early return clears it too.
    this.activeInvocations.add(commandId);
    try {
      // CANCELLED BEFORE IT RAN. A Stop that landed while this command was
      // still queued behind another on its tab found nothing in flight to
      // attach to, and waited in the latch. Honouring it here — before the
      // bridge is even resolved — is what makes "Stop stops it" true for a
      // queued call and not only for a running one.
      if (this.consumeCancel(commandId)) {
        return {
          ok: false,
          error:
            "webmcp_cancelled: the call was cancelled before it reached the page; nothing ran",
        };
      }
      return await this.runWebmcpInvoke(tabId, action, permit, commandId);
    } finally {
      // THE COMMAND IS OVER, so any cancellation still waiting on it is moot,
      // and nothing may latch a new one against it from here.
      this.activeInvocations.delete(commandId);
      this.pendingCancels.delete(commandId);
    }
  }

  /** The body of `webmcpInvoke`, run inside its in-flight registration. */
  private async runWebmcpInvoke(
    tabId: string,
    action: Extract<BrowserAction, { kind: "webmcp_invoke" }>,
    permit: () => boolean,
    commandId: string,
  ): Promise<BrowserCommandResult> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    const bridge = await entry.page.webmcp();
    // SETTLED FIRST, exactly as the tool-list read does. Support is decided by
    // a page-API probe that a navigation re-runs, and it is not a synchronous
    // event — so on the first invocation after a navigate `isSupported()` can
    // still be answering for the document the model has already left, and a
    // page that genuinely offers tools would be refused as unsupported.
    await bridge?.probeSettled();
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
    // THE BINDING IS CHECKED HERE, immediately before the page is touched,
    // and not one layer earlier. Everything between a caller deciding to
    // invoke and this line is time in which the page can navigate, the frame
    // can detach and the tool can be re-registered — and the failure that
    // produces is silent: a same-named tool on the page that REPLACED the one
    // the user approved, invoked under that approval.
    const binding = action.expectedBinding;
    if (binding) {
      const stale = this.bindingRefusal(tabId, entry, bridge, action.toolKey, binding);
      if (stale) {
        return {
          ok: false,
          error: formatBrowserdError("stale_binding", stale),
          // The fresh revision rides along so the caller re-reads the page's
          // tools instead of retrying the binding it already holds.
          ...this.webmcpEnvelope(tabId, entry),
        };
      }
    }
    try {
      const { invocationId, output } = await bridge.invoke({
        toolName: action.toolKey,
        // Forwarded so a subframe's tool is not shadowed by a same-named one
        // in the main frame. `invoke` falls back to name resolution when it is
        // absent or when the frame no longer offers the tool, so an older
        // caller that sends no frame still works.
        ...(binding
          ? {
              frameId: binding.frameId,
              strictFrame: true,
              // Re-checked inside `invoke`, against the same value
              // `bindingRefusal` just accepted. The gap between the two is a
              // real one — an abort check and a CDP round trip — and it is
              // exactly long enough for a page to swap the tool.
              expectedRegistrationSeq: binding.registrationSeq,
            }
          : {}),
        ...(!binding && action.frameId ? { frameId: action.frameId } : {}),
        input: action.input,
        // Recorded BEFORE the tool settles, which is the only window in which
        // a cancel can still reach the page.
        onStarted: (id) => {
          if (!this.rememberInvocation(commandId, id, tabId)) return;
          // THE SAME GATE THE NAMED-ID PATH ASKS. Cancelling reaches into the
          // page, and this delivery can span the whole accept window — longer
          // than the await that made the other path re-ask. A handoff landing
          // in it would otherwise let this touch a browser somebody else now
          // has their hands on.
          if (!permit()) return;
          // Fire-and-forget: awaiting here would hold the invocation open on
          // the very thing meant to end it, and a failure to cancel is not the
          // invocation's failure.
          void bridge.cancel(id).catch(() => undefined);
        },
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
    // A caller may name the invocation directly (it listed one) or name the
    // COMMAND whose invocation it wants stopped. The second is the case that
    // matters: a server aborting a tool call it issued has no invocation id,
    // because `webmcp_invoke` only reports one once the tool has settled.
    const started = action.commandId
      ? this.invocationsByCommand.get(action.commandId)
      : undefined;
    // THE TAB THE INVOCATION RAN ON, not the tab the cancellation names.
    //
    // An invocation id is meaningful only to the bridge that issued it, and
    // these two tabs need not agree: `webmcp_cancel {commandId}` is a valid
    // shape with no tab at all, which resolves to the default one. Resolving
    // the bridge from the CANCEL's tab and then handing it an id minted by
    // another sends a stop to a page that never started the thing — the
    // invocation runs on, and an id that happened to collide would stop
    // something unrelated.
    const invocationTabId = started?.tabId ?? tabId;
    const entry = this.tabs.get(invocationTabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${invocationTabId}` };
    }
    const invocationId = action.invocationId ?? started?.invocationId;
    if (!invocationId) {
      // NOT an error, and NOT forgotten either.
      //
      // The interesting case is a Stop pressed while `WebMCP.invokeTool` is
      // still in flight: the browser has the call, has not yet returned an id,
      // and there is nothing to name. Answering "nothing to stop" and dropping
      // it there let the invocation start a moment later and run to completion
      // under a cancellation the user had already made — which is the exact
      // failure this whole path exists to prevent, just moved earlier.
      //
      // So the intent is remembered against the COMMAND, and the id, when it
      // arrives, is cancelled on sight.
      //
      // WHETHER OR NOT IT IS RUNNING YET. The invoke may still be QUEUED behind
      // another command on its tab — the ordinary case when a model issues a
      // page tool beside an observe and the user presses Stop during the
      // observe. Nothing is in flight to attach to, so the intent waits in the
      // latch and `webmcpInvoke` honours it at dequeue, before the bridge is
      // resolved. A cancel for a command that already failed early, or never
      // existed, is what the latch's ceiling and TTL are for; a latch for a
      // live invocation is never the one evicted.
      if (action.commandId) this.latchCancel(action.commandId);
      return { ok: true, output: { cancelled: false, known: false } };
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
    const known = await bridge.cancel(invocationId);
    return { ok: true, output: { cancelled: known, known: true, invocationId } };
  }

  /**
   * Why this binding does not describe the tool that is here now, or undefined
   * when it does.
   *
   * `bootId` is deliberately NOT checked here: the transport already refuses a
   * command whose `expectedBootId` does not match (`command_unknown_boot`), so
   * a binding from a previous boot cannot reach this method at all. Checking it
   * again would need the driver to know the daemon's boot identity, which is
   * the control plane's business.
   */
  private bindingRefusal(
    tabId: string,
    entry: TabEntry,
    bridge: WebMcpBridge,
    toolKey: string,
    binding: NonNullable<
      Extract<BrowserAction, { kind: "webmcp_invoke" }>["expectedBinding"]
    >,
  ): string | undefined {
    if (binding.tabId !== tabId) {
      return `this tool was listed on tab "${binding.tabId}", not "${tabId}"`;
    }
    if (binding.navCounter !== entry.navCounter) {
      // The one the main frame's stable id cannot catch on its own.
      return "the page navigated after this tool was listed, so the tool it named is gone";
    }
    const live = bridge.registrationSeqFor(binding.frameId, toolKey);
    if (live === undefined) {
      return `the frame that offered "${toolKey}" no longer offers it`;
    }
    if (live !== binding.registrationSeq) {
      return `"${toolKey}" was re-registered by the page after it was listed`;
    }
    return undefined;
  }

  /** Remember which invocation a command started, evicting oldest-first. */
  private rememberInvocation(
    commandId: string,
    invocationId: string,
    tabId: string,
  ): boolean {
    // A CANCELLATION THAT ARRIVED FIRST. It had no id to name at the time, so
    // it left its intent here; this is the moment the id exists. Reported back
    // rather than acted on, because the caller holds the bridge.
    const cancelWanted = this.consumeCancel(commandId);
    if (this.invocationsByCommand.size >= MAX_TRACKED_INVOCATIONS) {
      const oldest = this.invocationsByCommand.keys().next().value;
      if (oldest !== undefined) this.invocationsByCommand.delete(oldest);
    }
    this.invocationsByCommand.set(commandId, { tabId, invocationId });
    return cancelWanted;
  }

  /**
   * Remember that `commandId` was cancelled, whether or not it has started.
   *
   * Expired latches for commands that are not running are swept first. At the
   * ceiling, the oldest latch that guards NO running invocation is evicted; if
   * every slot guards one, this intent is dropped rather than a live one — a
   * lost cancellation for a command that may never arrive is the cheaper
   * mistake.
   */
  private latchCancel(commandId: string): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.pendingCancels) {
      if (expiresAt <= now && !this.activeInvocations.has(id)) {
        this.pendingCancels.delete(id);
      }
    }
    if (
      this.pendingCancels.size >= MAX_PENDING_CANCELS &&
      !this.pendingCancels.has(commandId)
    ) {
      for (const id of this.pendingCancels.keys()) {
        if (!this.activeInvocations.has(id)) {
          this.pendingCancels.delete(id);
          break;
        }
      }
      if (this.pendingCancels.size >= MAX_PENDING_CANCELS) return;
    }
    this.pendingCancels.set(commandId, now + PENDING_CANCEL_TTL_MS);
  }

  /**
   * Take the latch for `commandId`, if one is still live.
   *
   * A latch for a RUNNING command is live regardless of its timestamp — the
   * TTL exists for commands that never arrive, not for ones taking their time
   * inside the bridge.
   */
  private consumeCancel(commandId: string): boolean {
    const expiresAt = this.pendingCancels.get(commandId);
    if (expiresAt === undefined) return false;
    this.pendingCancels.delete(commandId);
    return this.activeInvocations.has(commandId) || expiresAt > Date.now();
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
    // BEFORE THE PAGE STARTS LOADING, not after.
    //
    // The attach is fire-and-forget at tab creation so opening a tab is not
    // slowed by a CDP round trip, and every READ awaits it. That is not enough
    // on its own: `toolsAdded` is an event, not a query, so a page that
    // registers before `WebMCP.enable` and the listeners are wired loses those
    // registrations permanently — awaiting the attach afterwards asks a bridge
    // that was not listening when it mattered. Memoized, so this costs one
    // await on the first navigation and nothing on any later one.
    await this.attachWebmcp(tabId, entry).catch(() => undefined);
    await navigate(entry.page);
    entry.navCounter += 1;
    // A NEW GENERATION, whether or not the bridge has anything to say about it.
    // Every binding minted against the previous document is void from here, and
    // a page with no tools at all still replaced a page that may have had some.
    entry.webmcp.revision += 1;
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
        return this.observation(
          tabId,
          entry,
          { url: frame.url },
          frame,
          permit,
        );
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
        // filter → cap → number → render, in that order, and the order is
        // load-bearing. Filtering first keeps the budget from being spent on
        // prose the interactive view will not show; numbering after the cap
        // keeps every ref in the map reachable in the text (a ref stamped on a
        // node the budget then dropped would be a name for something the model
        // cannot see); rendering last means the map and the text were built
        // from one pass over one tree.
        const raw = await this.readA11y(tabId, entry, action);
        if (!raw.ok) return raw.error;
        const filtered =
          raw.filter === "interactive" && raw.tree
            ? filterInteractive(raw.tree)
            : raw.tree;
        const frame = await this.snapshot(entry.page);
        const { tree, omittedSubtrees, totalNodes } = capA11yTree(
          filtered,
          this.a11yBudget,
        );
        const refs = assignRefs(tree);
        const rendered = renderA11yTree(tree, {
          interactiveOnly: raw.filter === "interactive",
        });
        const result = this.observation(
          tabId,
          entry,
          {
            a11y: rendered,
            refs: Object.fromEntries(
              [...refs].map(([ref, entryValue]) => [
                ref,
                { role: entryValue.role, name: entryValue.name },
              ]),
            ),
            ...(omittedSubtrees > 0 ? { omittedSubtrees, totalNodes } : {}),
          },
          frame,
          permit,
        );
        // COMMITTED ONLY IF THE OBSERVATION WAS HANDED OVER. A handoff landing
        // mid-read discards the result — and refs stored anyway would be names
        // for a page the model was never shown, guessable afterwards by a model
        // that never received them. On that path the old map goes too: it
        // described a page this tab may no longer be on.
        if (!result.ok) {
          this.refs.delete(tabId);
          return result;
        }
        // Replaces the per-tab map wholesale: refs are valid for exactly one
        // observation, and leaving an older map merged underneath is how `e7`
        // comes to mean two things at once. Bound to the token the observation
        // carries, so a ref used after the page moved is refused rather than
        // resolved by name against whatever is there now.
        this.refs.set(tabId, { stateToken: result.stateToken, entries: refs });
        return result;
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
      case "webmcp_revision": {
        // TOUCHES NO PAGE. No screenshot, no settle, no DOM read — this is a
        // read of the cache the bridge subscription keeps current, and it is
        // what makes "did the page's tools change?" affordable before every
        // model step. It carries no state token for the same reason: nothing
        // here observed a rendered state, so there is none to pin an act to.
        await this.attachWebmcp(tabId, entry);
        return {
          ok: true,
          output: { url: safeUrl(entry.page) },
          ...this.webmcpEnvelope(tabId, entry),
        };
      }
      case "webmcp_tools": {
        const bridge = await entry.page.webmcp();
        // The support probe is a round trip into the page and navigation is a
        // synchronous event, so right after a navigate `isSupported()` can
        // still be answering for the page we LEFT — which reads as "this page
        // offers no tools" about a page whose whole point is its tools.
        await bridge?.probeSettled();
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
  /**
   * What is open, and which one is on screen.
   *
   * For the human pane, not for the model: the video stream grabs the X
   * display, so a model `activate_tab` silently changes what a watching person
   * is looking at. The pane draws its own tab strip from this (kiosk hides
   * Chromium's) and says so when the active one moves.
   *
   * Deliberately cheap and synchronous — it reads the driver's own map rather
   * than asking Chromium — because it runs on every heartbeat of every open
   * stream.
   */
  tabsSnapshot(): {
    active?: string;
    list: Array<{ id: string; url: string }>;
  } {
    const live = [...this.tabs.entries()]
      // A page can close ITSELF — `window.close()`, a crashed renderer — with
      // nothing routed through the driver, and the strip then showed a
      // phantom tab and could mark the closed id active.
      .filter(([, entry]) => !entry.page.isClosed());
    // THE ACTIVE ONE IS NOT WHAT A BOUND DROPS. It is the tab the video is
    // showing, and cutting at sixteen sent a strip that did not contain it —
    // so `active` fell away below and the picture changed with nothing
    // highlighted, which reads as "no tab is on screen". Position is kept:
    // it takes the last slot rather than jumping to the front, because a
    // strip that reorders itself when a tab is activated is its own puzzle.
    const activeAt = this.activeTabId
      ? live.findIndex(([id]) => id === this.activeTabId)
      : -1;
    const ordered =
      activeAt >= TABS_SNAPSHOT_MAX
        ? [...live.slice(0, TABS_SNAPSHOT_MAX - 1), live[activeAt]!]
        : live.slice(0, TABS_SNAPSHOT_MAX);
    const list = ordered.map(([id, entry]) => ({
      id,
      url: safeUrl(entry.page).slice(0, TAB_URL_MAX),
    }));
    // Then by SIZE, dropping from the end and never the active one. A caller
    // that invents long tab ids cannot be answered with a truncated id — the
    // strip matches `active` against it — so what gives is the number of
    // entries, and in the last resort the strip itself.
    //
    // Two passes, and the cheap one first for a reason: a raw-length estimate
    // is O(1) per entry and gets sixteen megabyte-long ids down to a handful
    // before anything is serialised, and the exact measure below is then
    // working on kilobytes rather than megabytes.
    const costOf = (tab: { id: string; url: string }): number =>
      tab.id.length + tab.url.length + TAB_ENTRY_OVERHEAD;
    let estimate = list.reduce((total, tab) => total + costOf(tab), 0);
    while (list.length > 1 && estimate > TABS_SNAPSHOT_BYTES) {
      estimate -= costOf(list[dropIndex(list, this.activeTabId)]!);
      list.splice(dropIndex(list, this.activeTabId), 1);
    }
    // Only if it is still there: the strip highlights `active`, and pointing
    // at a tab that is not in the list reads as "no tab is on screen".
    const payload = (): {
      active?: string;
      list: Array<{ id: string; url: string }>;
    } => {
      const active =
        this.activeTabId && list.some((tab) => tab.id === this.activeTabId)
          ? this.activeTabId
          : undefined;
      return { ...(active ? { active } : {}), list };
    };
    // A SOLE ENTRY THAT THE ESTIMATE ALREADY REJECTS never reaches the
    // serialiser. The estimate only ever undercounts, so "over budget by raw
    // length" is proof; and the alternative was stringifying a megabyte of
    // caller-chosen id on every heartbeat of every open stream, only to throw
    // it away — attacker-priced CPU, several times a second.
    if (list.length === 1 && estimate > TABS_SNAPSHOT_BYTES) list.length = 0;
    // MEASURED, not estimated, and in BYTES rather than characters. The
    // estimate above misses three things, all of them under the caller's
    // control: the payload repeats the active id in its own field,
    // `JSON.stringify` expands every quote, backslash and control character in
    // an id, and a `.length` counts UTF-16 units — so one CJK character is 1
    // there and 3 on the wire, and an emoji 2 and 4. The wire is where the 8
    // KiB record limit is enforced, by dropping the stream, so the wire's own
    // unit is the only one worth counting in.
    while (
      list.length > 0 &&
      Buffer.byteLength(JSON.stringify(payload()), "utf8") > TABS_SNAPSHOT_BYTES
    ) {
      list.splice(dropIndex(list, this.activeTabId), 1);
    }
    return payload();
  }

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
      // ON EVERY OBSERVATION, at the funnel, so no mode can forget it. A change
      // the model's OWN action caused — a navigation, a click that mounted a
      // component that registers a tool — is then visible in the result the
      // model already paid for, and costs no extra round trip.
      ...this.webmcpEnvelope(tabId, entry),
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
      const entry: TabEntry = {
        page,
        navCounter: 0,
        webmcp: emptyWebmcpState(),
      };
      this.tabs.set(tabId, entry);
      // EAGERLY, reversing the bridge's original lazy attach. Lazy was right
      // when the only consumer was `webmcp_invoke` — a tab that never called a
      // page tool should not pay for a CDP session. It is wrong now: the tool
      // set is a thing the server READS between model steps, and a bridge that
      // attaches on first use has no idea what the page registered before it
      // existed. Fire-and-forget so tab creation is not slowed by it; every
      // reader awaits `attachWebmcp` itself.
      void this.attachWebmcp(tabId, entry);
      // A new tab is the one Chromium shows, which is what the human pane's
      // video will be grabbing a moment later.
      this.activeTabId = tabId;
      return entry;
    })();
    this.pendingTabs.set(tabId, creating);
    try {
      return await creating;
    } finally {
      this.pendingTabs.delete(tabId);
    }
  }

  /**
   * Read the tree for an a11y observation, rooted where the caller asked.
   *
   * Three ways to be rooted and they fail differently, which is the reason
   * this is not inline: a `rootRef` the driver never issued is the model's
   * mistake and must say so; a `rootSelector` that matches nothing is the
   * page's answer and must not read as "that subtree is empty"; a page that
   * cannot produce a tree at all is neither, and telling a model its selector
   * was wrong in that case sends it hunting for a bug that is not there.
   */
  private async readA11y(
    tabId: string,
    entry: TabEntry,
    action: {
      rootSelector?: string;
      rootRef?: string;
      filter?: "interactive" | "all";
    },
  ): Promise<
    | { ok: true; tree: A11yNode | null; filter: "interactive" | "all" }
    | { ok: false; error: BrowserCommandResult }
  > {
    const filter = action.filter ?? "interactive";
    const cdp = await entry.page.cdp();
    if (!cdp) {
      return {
        ok: false,
        error: {
          ok: false,
          error:
            "a11y_unavailable: this page cannot answer an accessibility tree; " +
            'observe {mode:"text"} or {mode:"screenshot"} instead',
        },
      };
    }
    let rootBackendNodeId: number | undefined;
    if (action.rootRef !== undefined) {
      const parsed = parseRef(action.rootRef);
      const map = this.refs.get(tabId);
      // The token is the page the refs were minted against. Without this
      // check a ref survives a navigation, and scoping to it would read a
      // node id that a DIFFERENT document happens to reuse — or fall through
      // to name-matching and answer with a same-named element on a page the
      // model never asked about.
      if (map && !this.refsStillDescribe(tabId, entry, map)) {
        this.refs.delete(tabId);
        return {
          ok: false,
          error: {
            ok: false,
            error:
              `stale_ref: ${action.rootRef} was issued for a page this tab has ` +
              "since left; re-observe and use a ref from the new page",
          },
        };
      }
      const known = parsed ? map?.entries.get(parsed) : undefined;
      if (!known?.backendDOMNodeId) {
        return {
          ok: false,
          error: {
            ok: false,
            error:
              `unknown_ref: ${action.rootRef} is not a ref from this tab's last ` +
              "observation; re-observe and use a ref it names",
          },
        };
      }
      rootBackendNodeId = known.backendDOMNodeId;
    } else if (action.rootSelector !== undefined) {
      const resolved = await resolveBackendNodeId(cdp, action.rootSelector);
      if (resolved === null) {
        return {
          ok: false,
          error: {
            ok: false,
            error:
              `unknown_selector: nothing on this page matches ` +
              `"${action.rootSelector}"; re-observe the page and pick a ` +
              `selector from what it shows`,
          },
        };
      }
      rootBackendNodeId = resolved;
    }
    const read = await readAxTree(cdp, rootBackendNodeId);
    if (!read.ok) {
      return {
        ok: false,
        error: {
          ok: false,
          error:
            "a11y_unavailable: this page could not answer an accessibility " +
            'tree; observe {mode:"text"} or {mode:"screenshot"} instead',
        },
      };
    }
    if (rootBackendNodeId !== undefined && read.tree === null) {
      // The root resolved when it was issued and is gone now. An empty tree
      // here would read as "that subtree is empty" — the model would believe
      // the page rather than re-observing.
      return {
        ok: false,
        error: {
          ok: false,
          error:
            `stale_ref: the element ${action.rootRef ?? action.rootSelector} ` +
            "named is no longer on this page; re-observe and pick one it shows",
        },
      };
    }
    return { ok: true, tree: read.tree, filter };
  }

  /**
   * Do this tab's refs still describe the page it is on?
   *
   * Compares page IDENTITY (which navigation, which URL) and not content: a
   * DOM that mutated under a ref is what `stale_ref` recovery by role and name
   * exists to survive, and refusing every ref after any mutation would make
   * them useless on exactly the pages that need them.
   */
  private refsStillDescribe(
    tabId: string,
    entry: TabEntry,
    map: RefMap,
  ): boolean {
    const minted = map.stateToken;
    if (!minted) return false;
    return (
      minted.tabId === tabId &&
      minted.navCounter === entry.navCounter &&
      minted.urlHash === shortHash(entry.page.url())
    );
  }

  /**
   * Attach this tab's WebMCP bridge and start tracking its tool set.
   *
   * Idempotent and memoized on the entry: several readers can call it at once
   * (an observation, a revision read, an invoke) and exactly one attach
   * happens. Failures are swallowed into "this tab has no WebMCP", which is the
   * ordinary case — most pages offer nothing and a browser build without the
   * domain offers nothing anywhere.
   */
  private attachWebmcp(tabId: string, entry: TabEntry): Promise<void> {
    entry.webmcp.attaching ??= (async () => {
      const bridge = await entry.page.webmcp().catch(() => null);
      // The tab can be replaced inside that await (a close, a re-create under
      // the same name). Subscribing then would wire a dead page's bridge to a
      // live entry.
      if (!bridge || this.tabs.get(tabId) !== entry) return;
      entry.webmcp.unsubscribe = bridge.subscribe((tools) => {
        entry.webmcp.tools = tools;
        entry.webmcp.supported = bridge.isSupported();
        entry.webmcp.revision += 1;
      });
    })().catch(() => {});
    return entry.webmcp.attaching;
  }

  /**
   * A tab's tool set as `{revision, hash, count}`, read from the cache.
   *
   * The HASH is computed here rather than stored, and that is load-bearing: it
   * folds in `navCounter`, which changes on a path the bridge never reports
   * (`navigateVerb` bumps it AFTER `Page.frameNavigated` has already fired). A
   * hash stamped at announce time would describe the previous generation.
   */
  webmcpToolsSnapshot(tabId?: string): WebMcpToolsRevision | undefined {
    const id = tabId ?? DEFAULT_TAB;
    const entry = this.tabs.get(id);
    if (!entry) return undefined;
    return this.webmcpRevisionFor(entry);
  }

  private webmcpRevisionFor(entry: TabEntry): WebMcpToolsRevision {
    return {
      revision: entry.webmcp.revision,
      hash: declaredToolsHash(declaredToolsFromWebmcp(entry.webmcp.tools), {
        navCounter: entry.navCounter,
      }),
      count: entry.webmcp.tools.length,
      supported: entry.webmcp.supported,
      url: safeUrl(entry.page),
    };
  }

  /** The `webmcpTools` half of a result envelope. */
  private webmcpEnvelope(
    tabId: string,
    entry: TabEntry,
  ): Pick<BrowserCommandResult, "webmcpTools"> {
    void tabId;
    return { webmcpTools: this.webmcpRevisionFor(entry) };
  }

  /** Forget a tab and everything attached to it. */
  private async dropTab(tabId: string): Promise<void> {
    const going = this.tabs.get(tabId);
    // The subscription holds a closure over THIS entry; left attached to a
    // bridge whose page is being replaced, it would keep bumping a revision
    // nothing reads and keep the entry alive with it.
    going?.webmcp.unsubscribe?.();
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      // Chromium shows SOMETHING after a close, and the most recently
      // registered remaining tab is the best answer available without asking
      // the browser — which would be a round trip on a path that runs whenever
      // a tab goes away.
      const remaining = [...this.tabs.keys()];
      this.activeTabId = remaining[remaining.length - 1];
    }
    // Refs name nodes in a page that is going away. Left behind, they would be
    // handed to a recreated tab of the same name and resolve — by role and
    // name — against a document that never issued them.
    this.refs.delete(tabId);
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

/**
 * A page's URL, or an empty string.
 *
 * `page.url()` throws on a closed page, and this runs on a heartbeat that must
 * never take a stream down — a tab that is closing is exactly the case where a
 * snapshot is most likely to be read.
 */
function safeUrl(page: { url(): string }): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}
