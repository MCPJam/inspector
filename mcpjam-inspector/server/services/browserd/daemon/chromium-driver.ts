import {
  BROWSER_TAB_CAP,
  tabAfterClose,
} from "../../../../shared/browser-session-state";
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
  DEFAULT_QUEUE_KEY,
  formatBrowserdError,
  type WebMcpToolsRevision,
  wantsFor,
  type BrowserAction,
  type BrowserActTarget,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserdErrorCode,
  type ActObserve,
} from "../protocol";
import {
  capNetwork,
  DEFAULT_NETWORK_BUDGET,
  type NetworkBudget,
} from "./network";
import {
  agentDefaultAccepts,
  dialogRefusal,
  safeUnderDialog,
  type DialogOutcome,
  type DialogPolicy,
} from "./dialogs";
import {
  coveringElementAt,
  focusBackendNodeId,
  pointForBackendNodeId,
  replaceTextInNode,
  resolveRefNode,
  selectOptionOnNode,
  type ResolvedRefNode,
} from "./node-target";
import type { BrowserDriver, DriverHealth } from "./browser-driver";
import type { ActPoint, DriverContext, DriverPage } from "./browser-page";
import { computeStateToken, shortHash } from "./state-token";
import { SessionBarrier } from "./session-barrier";
import { readTabMetadata } from "./tab-metadata";
import {
  advanceViewport,
  negotiateViewport,
  INITIAL_SESSION_VIEWPORT,
  isPointInSessionViewport,
  type SessionViewport,
  type SessionViewportPolicy,
  type ViewportSize,
} from "../../../../shared/browser-viewport";
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
  type RefEntry,
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

/**
 * A failure the driver already knows the CODE for.
 *
 * The `act` catch classifies an unknown throw by matching Playwright's prose,
 * which is the right answer for a page primitive that timed out. It is the
 * wrong one for a failure this file raised itself: a `fill_form_failed: …
 * Timeout …` message matches the regex and would come back re-labelled
 * `target_not_found: fill_form_failed: …` — two codes in one string, and the
 * outer one wrong.
 */
class ActError extends Error {
  constructor(readonly code: BrowserdErrorCode, message: string) {
    super(message);
    this.name = "ActError";
  }
}

/**
 * A person took the browser BETWEEN the steps of a composite verb.
 *
 * Its own type because the answer differs from every other act failure: the
 * refusal must carry `leaseBlocked` (the handler's 423, and the signal the
 * tool layer drops its cached tokens on), and its prose must say that part of
 * the form is already filled — "nothing was run" would be false, and a model
 * told that would fill the same fields again on top of the ones that landed.
 */
class LeaseTakenMidAct extends Error {}

/**
 * An a11y payload minus the ref INDEX, for a result that cannot store one.
 *
 * A ref is a promise the driver has to keep: the model reads `e7` and expects
 * `rootRef:"e7"` to resolve. That promise is only made by `commitRefs`, and a
 * result carrying no state token cannot commit — so handing the index over
 * anyway would advertise names nothing will answer to.
 *
 * The rendered tree keeps its `[ref=eN]` markers, which is deliberate: they
 * read as part of the page's shape, and a model that tries one gets the clean
 * `unknown_ref` refusal that exists for exactly a ref this tab never issued.
 */
function withoutRefIndex(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const { refs: _unstored, ...rest } = fields;
  return rest;
}

/**
 * Did `fillSelector` refuse because the target is a `<select>`?
 *
 * See `fillOneField` for the two real messages this separates. The engines
 * agree on the wording by contract (`DriverPage.fillSelector`), so the test is
 * on the text rather than on a per-engine flag.
 */
function isNotAnInputRefusal(message: string): boolean {
  return /not an <input>/i.test(message) && !/<select>/i.test(message);
}

interface TabEntry {
  page: DriverPage;
  openerId?: string;
  loading?: boolean;
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
  /**
   * The content hash of `tools` at the current generation, stamped whenever
   * `revision` moves.
   *
   * STORED, NOT DERIVED ON READ. It folds in `navCounter`, so it has to be
   * recomputed on the navigation path the bridge never reports — which is why
   * every bump goes through `bumpWebmcpRevision`. Computing it on every read
   * instead put a hash of the full declared set on a heartbeat that beats
   * several times a second, and on every model step's revision check, for a
   * value that changes only when the revision does.
   */
  hash: string;
  supported: boolean;
  tools: WebMcpToolDescriptor[];
  /** Detaches the bridge subscription when the tab goes away. */
  unsubscribe?: () => void;
  /** The in-flight (or completed) eager attach, so it happens once. */
  attaching?: Promise<void>;
}

function webmcpHashFor(
  tools: readonly WebMcpToolDescriptor[],
  navCounter: number,
): string {
  return declaredToolsHash(declaredToolsFromWebmcp(tools), { navCounter });
}

function emptyWebmcpState(): TabWebmcpState {
  return {
    revision: 0,
    hash: webmcpHashFor([], 0),
    supported: false,
    tools: [],
  };
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
  maxTabs?: number;
  onExternalInvocation?: (tabId: string, toolName: string) => void;
  onPopupOpened?: (url: string) => void;
  onTabLimit?: () => void;
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
  /** How many network rows one observation returns. */
  network?: NetworkBudget;
  /**
   * What an UNANSWERED dialog means. `auto` (default) applies the safe
   * defaults so a tab can never wedge; `ask` decides nothing and refuses the
   * command instead, leaving the choice to a client that has its own rules.
   * The explicit answer verbs work under both.
   */
  dialogPolicy?: DialogPolicy;
  /** Byte budget for a WebMCP tool's returned output (L9). */
  webmcpOutputBytes?: number;
  /** Byte budget for one `observe {mode:"text"}` (L9). */
  pageTextBytes?: number;
  /**
   * How big this session's page is, and whether it may change.
   *
   * Absent means the old behaviour exactly: a `fixed` session at 1024x768 that
   * refuses every resize. Every existing caller — evals, swarms, the CLI, the
   * v1 bridge — gets that without being touched, which is the point: a run
   * recorded last month and one recorded today stay comparable frame for
   * frame, and only a caller that asked for a responsive session gets one.
   */
  viewport?: {
    policy: SessionViewportPolicy;
    allowPaneResize?: boolean;
    initial?: ViewportSize;
    /**
     * Told whenever the session's size actually changes.
     *
     * AFTER the change has been applied to every page, never before: a
     * listener that heard about a size the pages had not taken would publish
     * dimensions that disagree with the picture, which is the one thing the
     * whole responsive path must not do.
     */
    onChange?: (viewport: SessionViewport) => void;
    /** Test seam for the barrier's debounce. */
    debounceMs?: number;
    /**
     * Take the box's DISPLAY to the new size too, on an engine that has one.
     *
     * Hosted only. There, "the display IS the page" is literally true —
     * Chromium fills the X screen in kiosk mode and the encoder grabs that
     * screen — so a page resized without the display behind it paints past the
     * edge of what is captured, and the missing strip is on the right where
     * nothing looks obviously wrong. On a local Chromium there is no display
     * to move: the page is a window, and resizing it is the whole job.
     *
     * Returns whether it landed. A false ABORTS the viewport change, so the
     * published number never runs ahead of the picture.
     */
    resizeDisplay?: (
      next: ViewportSize,
      previous: ViewportSize,
    ) => Promise<boolean>;
  };
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
  private readonly networkBudget: NetworkBudget;
  private readonly dialogPolicy: DialogPolicy;
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
   * What was decided about a dialog, waiting to ride the next observation.
   *
   * Carried rather than returned because the dialog is answered at the top of
   * `execute`, before the command that will produce the result has run — the
   * same shape as the handoff note, and read out in the same funnel.
   */
  private readonly dialogNotes = new Map<string, DialogOutcome>();
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
  /**
   * How big this session's page is, and its revision.
   *
   * The DRIVER owns it rather than the launch args, because it is the thing
   * that knows every open tab and can therefore be the one place that
   * guarantees they all agree. A per-tab answer would let two tabs in one
   * session render at different sizes while one number was published for both.
   */
  private sessionViewport: SessionViewport;
  /** Monotonic per boot, so two snapshots in one millisecond still order. */
  private stateSeq = 0;
  private stopPageCreated?: () => void;
  private nextPopupId = 0;
  private readonly maxTabs: number;
  private readonly onExternalInvocation?: (
    tabId: string,
    toolName: string,
  ) => void;
  private readonly allowPaneResize: boolean;
  private viewportPolicy: SessionViewportPolicy;
  private latestViewportRequest?: import("../../../../shared/browser-viewport").PaneViewportRequest;
  private readonly onViewportChange:
    | ((viewport: SessionViewport) => void)
    | undefined;
  private readonly barrier: SessionBarrier;
  private readonly resizeDisplay:
    | ((next: ViewportSize, previous: ViewportSize) => Promise<boolean>)
    | undefined;
  constructor(context: DriverContext, options: ChromiumDriverOptions = {}) {
    this.context = context;
    this.onExternalInvocation = options.onExternalInvocation;
    this.maxTabs = Math.max(1, options.maxTabs ?? BROWSER_TAB_CAP);
    this.stopPageCreated = context.onPageCreated?.(
      ({ page, opener, background }) => {
        const openerId = [...this.tabs].find(
          ([, entry]) => entry.page === opener,
        )?.[0];
        if (
          this.closing ||
          !openerId ||
          this.tabs.size + this.pendingTabs.size >= this.maxTabs
        ) {
          void page.close().catch(() => {});
          return;
        }
        let id: string;
        do {
          id = `popup-${++this.nextPopupId}`;
        } while (this.tabs.has(id) || this.pendingTabs.has(id));
        void this.registerTab(id, page, openerId, background)
          .then(() => options.onPopupOpened?.(safeUrl(page)))
          .catch(() => page.close().catch(() => {}));
      },
    );
    this.settleOptions = options.settle ?? DEFAULT_SETTLE_OPTIONS;
    this.a11yBudget = options.a11y ?? DEFAULT_A11Y_BUDGET;
    this.consoleBudget = options.console ?? DEFAULT_CONSOLE_BUDGET;
    this.dialogPolicy = options.dialogPolicy ?? "auto";
    this.networkBudget = options.network ?? DEFAULT_NETWORK_BUDGET;
    this.webmcpOutputBudgetBytes =
      options.webmcpOutputBytes ?? DEFAULT_WEBMCP_OUTPUT_BYTES;
    this.pageTextMaxBytes =
      options.pageTextBytes ?? DEFAULT_PAGE_TEXT_MAX_BYTES;
    this.lease = options.lease;
    this.viewportPolicy = options.viewport?.policy ?? "fixed";
    this.allowPaneResize = options.viewport?.allowPaneResize === true;
    const initial = options.viewport?.initial;
    this.sessionViewport = initial
      ? { width: initial.width, height: initial.height, revision: 0 }
      : INITIAL_SESSION_VIEWPORT;
    this.onViewportChange = options.viewport?.onChange;
    this.resizeDisplay = options.viewport?.resizeDisplay;
    this.barrier = new SessionBarrier(
      (size) => this.applyViewport(size),
      options.viewport?.debounceMs !== undefined
        ? { debounceMs: options.viewport.debounceMs }
        : {},
    );
  }

  /** This session's page size and revision, for everything that publishes it. */
  sessionViewportState(): SessionViewport {
    return this.sessionViewport;
  }

  /**
   * Ask for a new size, and resolve once the request has been dealt with.
   *
   * "Dealt with" rather than "applied": a burst of measurements from a drag
   * collapses into one transition, and every caller in the burst resolves when
   * that transition lands, whatever size it carried. A `fixed` session
   * resolves immediately, having changed nothing.
   */
  sessionViewportPolicy(): SessionViewportPolicy {
    return this.viewportPolicy;
  }

  async requestViewport(
    size: import("../../../../shared/browser-viewport").PaneViewportRequest,
  ): Promise<SessionViewport> {
    if (size.policy === "followPane" && this.allowPaneResize)
      this.viewportPolicy = "followPane";
    if (this.viewportPolicy === "fixed") return this.sessionViewport;
    const request =
      size.policy === "fixed" ? { ...size, width: 1024, height: 768 } : size;
    this.latestViewportRequest = request;
    await this.barrier.request(request);
    return this.sessionViewport;
  }

  /** Is a resize waiting or transitioning? Surfaces as the pane's affordance. */
  viewportSettling(): boolean {
    return this.barrier.busy;
  }

  /** Resize an attached capture together with its page, including rollback. */
  private async resizePage(
    page: DriverPage,
    size: { width: number; height: number },
  ): Promise<void> {
    const tab = [...this.tabs].find(([, entry]) => entry.page === page);
    const capture = tab ? await this.viewports.get(tab[0]) : undefined;
    const apply = async () => {
      await page.setViewportSize?.({ width: size.width, height: size.height });
    };
    if (capture) await capture.resize(size, apply);
    else await apply();
  }

  /**
   * Take every tab to a new size, or leave every tab where it was.
   *
   * ALL OR NOTHING, and rolled back by hand rather than left half-applied. A
   * session whose tabs render at two different sizes has no honest number to
   * publish for either — and the pane would draw the one that was written
   * last, over a page that is not that size. The rollback is best-effort
   * because a page that just refused a resize may refuse the way back too; what
   * matters is that `sessionViewport` is not advanced unless every page took
   * the new size, so the published number never runs ahead of the picture.
   */
  private async applyViewport(
    size: import("../../../../shared/browser-viewport").PaneViewportRequest,
  ): Promise<void> {
    const next = advanceViewport(this.sessionViewport, size, "followPane");
    if (next === this.sessionViewport) {
      if (size.policy === "fixed" && this.latestViewportRequest === size)
        this.viewportPolicy = "fixed";
      return;
    }
    const pages = [...this.tabs.values()]
      .map((entry) => entry.page)
      .filter((page) => !page.isClosed());
    // An engine that cannot resize must not be told it did. Refusing here is
    // what makes `setViewportSize` genuinely optional on `DriverPage` rather
    // than a method every engine has to pretend to have.
    const unable = pages.find(
      (page) => typeof page.setViewportSize !== "function",
    );
    if (unable) {
      throw new Error(
        "viewport_unsupported: this engine cannot resize its pages",
      );
    }
    const previous = this.sessionViewport;
    // THE DISPLAY FIRST, on a box that has one. A kiosk window told to fill a
    // screen that has not grown yet fills the old one, and every page resized
    // underneath it would then be describing a rectangle the capture cannot
    // reach. @see display-resize.ts
    if (this.resizeDisplay) {
      const moved = await this.resizeDisplay(
        { width: next.width, height: next.height },
        { width: previous.width, height: previous.height },
      );
      if (!moved) {
        throw new Error(
          "display_resize_failed: the box would not change its display size",
        );
      }
    }
    const applied: DriverPage[] = [];
    try {
      for (const page of pages) {
        await this.resizePage(page, next);
        applied.push(page);
      }
    } catch (error) {
      for (const page of applied) {
        await this.resizePage(page, previous).catch(() => {});
      }
      // THE DISPLAY COMES BACK TOO. It moved first, and on a hosted box it
      // took the kiosk window and the encoder with it — so a page refusing
      // afterwards left the screen at `next` while the pages and the published
      // `sessionViewport` were at `previous`. `resizeHostedDisplay` cannot
      // undo this on its own: its own rollback covers failures inside its own
      // call, and it is not given a `resizePage` dependency here precisely
      // because the driver owns the pages.
      //
      // Best-effort, and the throw below is unconditional either way: the
      // caller's job on a failed resize is to keep publishing the last size
      // everything agreed on, which is `previous`, and a display that would
      // not come back is a bad picture rather than a lying coordinate space.
      if (this.resizeDisplay) {
        await this.resizeDisplay(
          { width: previous.width, height: previous.height },
          { width: next.width, height: next.height },
        ).catch(() => false);
      }
      throw error;
    }
    this.sessionViewport = next;
    if (size.policy === "fixed" && this.latestViewportRequest === size)
      this.viewportPolicy = "fixed";
    // ANYTHING THAT APPEARED WHILE WE RAN. `pages` above is a snapshot, and a
    // `navigate {newTab: true}` can register a page inside the awaits below it
    // — external browser events can still create pages while the barrier
    // defers commands during a transition. Such a page
    // sized itself from `sessionViewport` on creation, which was `previous`
    // until the line above; sweeping here is what closes the window rather
    // than leaving one tab a different size from the rest.
    for (const entry of this.tabs.values()) {
      if (applied.includes(entry.page) || entry.page.isClosed()) continue;
      await this.resizePage(entry.page, next).catch(() => {});
    }
    try {
      this.onViewportChange?.(next);
    } catch {
      // A listener that throws must not undo a resize that landed.
    }
  }

  /**
   * Is this coordinate on the page?
   *
   * The SESSION's numbers, not the module constant. The two agree exactly when
   * the session is `fixed`, which is every caller that predates this — so the
   * refusals a caller sees today do not move, and a resized session refuses
   * the coordinates that are genuinely off ITS page rather than off a 1024x768
   * one it is not.
   */
  private inViewport(x: number, y: number): boolean {
    return isPointInSessionViewport(x, y, this.sessionViewport);
  }

  /** How this session's size reads in an error a caller has to act on. */
  private get viewportLabel(): string {
    return `${this.sessionViewport.width}x${this.sessionViewport.height}`;
  }

  /**
   * Run one command, never across a resize.
   *
   * The barrier is here rather than around the queue because the queue is
   * per-TAB and a resize is per-SESSION: two tabs' FIFOs can each be mid-act
   * while the display changes underneath both. Wrapping the one place every
   * verb passes through is what makes "never resize midway through an action"
   * true for all of them at once — including the ones added later.
   */
  async execute(command: BrowserCommand): Promise<BrowserCommandResult> {
    return this.barrier.run(() => this.executeInBarrier(command));
  }

  private async executeInBarrier(
    command: BrowserCommand,
  ): Promise<BrowserCommandResult> {
    // Recheck after waiting for a resize, not only at queue admission.
    if (
      command.source !== "manual" &&
      command.action.kind !== "webmcp_cancel" &&
      !negotiateViewport(this.viewportPolicy, command).ok
    ) {
      return {
        ok: false,
        error:
          "responsive_viewport_required: read the session viewport before acting",
      };
    }
    // W4/L6 — before ANYTHING can read, discard what a person's handoff left
    // behind. The 423 gate stops an agent observing DURING a handoff, but the
    // console ring fills from an eager page listener that knows nothing about
    // leases, so a token or a form value the page logged while someone signed
    // in would otherwise be readable the instant they hand back. Doing it here
    // rather than in the console branch covers every future reader too.
    this.purgeHandoffRings();
    // The third and last gate (handler → dequeue → here). A command that got
    // this far while a person holds the browser must not run: `execute` is
    // where the page is actually touched.
    const permit = this.permitFor(command);
    if (!permit()) {
      return this.leaseBlockedResult(
        "a person took control of this browser before this action ran; nothing was run and nothing was observed",
      );
    }
    const tabId = command.tabId ?? this.activeTabId ?? DEFAULT_TAB;
    const action = command.action;
    // A DIALOG STOPS THE RENDERER, so it is dealt with before anything reaches
    // the page. Placed here rather than in each verb because every one of them
    // would otherwise hang against a blocked page and report it as "unsettled".
    const blocked = await this.answerOrRefuseDialog(
      tabId,
      action,
      permit,
      command.source,
    );
    if (blocked) return blocked;
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
        // The pane's + button only needs a blank tab. newPage already made
        // one, so navigating it again would unnecessarily await WebMCP setup,
        // network quiet and a rendered frame (up to the full settle timeout).
        // Agent navigations still take the observation/token path below.
        if (
          command.source === "manual" &&
          action.newTab &&
          action.url === "about:blank" &&
          action.observe === "none" &&
          safeUrl(entry.page) === "about:blank"
        ) {
          return permit()
            ? { ok: true }
            : this.leaseBlockedResult(
                "browser control changed while opening the tab; nothing was observed",
              );
        }
        return this.navigateVerb(
          tabId,
          entry,
          (page) => page.goto(action.url),
          permit,
          action.observe,
        );
      }
      case "back":
      case "forward":
      case "reload": {
        // back/forward/reload act on an EXISTING tab only — an unknown tabId is
        // an error, not a reason to conjure a fresh about:blank page (P2).
        const entry = this.tabs.get(tabId);
        if (!entry || entry.page.isClosed()) {
          return { ok: false, error: `unknown_tab: ${tabId}` };
        }
        const kind = action.kind;
        return this.navigateVerb(
          tabId,
          entry,
          (page) =>
            kind === "back"
              ? page.goBack()
              : kind === "forward"
              ? page.goForward()
              : page.reload(),
          permit,
          action.observe,
        );
      }
      case "observe":
        return this.observe(tabId, action, permit);
      case "act":
        return this.act(tabId, action, permit, command.source);
      case "webmcp_invoke":
        return this.webmcpInvoke(tabId, action, permit, command.commandId);
      case "webmcp_cancel":
        return this.webmcpCancel(tabId, action, permit);
    }
  }

  /**
   * Run one act verb, then FOLD THE OBSERVATION IN (L1): every act settles and
   * returns what the page BECAME — its URL, the tree of what can be acted on
   * next (with refs), a screenshot, or whichever of those `observe` asked for
   * — with a fresh state token, so the model never has to spend a turn asking
   * "what happened?" and the token it gets back is the one its NEXT act should
   * be pinned to.
   *
   * The a11y half is what closes the last round trip: an act used to hand back
   * a picture, and a model that wanted to know what was now CLICKABLE had to
   * observe again. `afterAct` is the funnel every one of these paths — success,
   * failure, and the stale refusal above — leaves through.
   *
   * L3 staleness is enforced upstream by `guardStaleness`, which compares the
   * act's `expectedState` before this runs.
   */
  private async act(
    tabId: string,
    action: Extract<BrowserAction, { kind: "act" }>,
    permit: () => boolean,
    source: BrowserCommand["source"],
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
      if (!this.closing && this.tabs.size === 0)
        await this.getOrCreateTab(DEFAULT_TAB);
      return { ok: true, output: { closed: tabId } };
    }
    if (action.verb === "accept_dialog" || action.verb === "dismiss_dialog") {
      // ALWAYS AVAILABLE, under either policy. The policy decides what happens
      // to an UNANSWERED dialog; answering one is the capability, and a client
      // that has its own rules needs it whatever the fallback is.
      const pending = page.pendingDialog?.();
      if (!pending) {
        return {
          ok: false,
          error: formatBrowserdError(
            "act_failed",
            "there is no dialog open on this page to answer",
          ),
        };
      }
      const accept = action.verb === "accept_dialog";
      await page.resolveDialog?.(
        accept,
        accept && action.value !== undefined ? action.value : undefined,
      );
      // Recorded like an automatic answer, minus `auto`: a reader of the
      // transcript should be able to tell what the page asked and who decided.
      this.dialogNotes.set(tabId, {
        kind: pending.kind,
        message: pending.message,
        choice: accept ? "accepted" : "dismissed",
      });
      const settledAfter = await this.settle(page);
      const observed = await this.afterAct(
        tabId,
        entry,
        permit,
        wantsFor(action.observe),
      );
      return observed.ok ? { settled: settledAfter, ...observed } : observed;
    }
    if (action.verb === "activate_tab") {
      await page.bringToFront();
      this.activeTabId = tabId;
      const frame = await this.snapshot(page);
      return this.observation(tabId, entry, { url: frame.url }, frame, permit);
    }

    const wants = wantsFor(action.observe);
    // ONE extra `domStructureSignal` evaluate, taken here so `previousUrl` can
    // say whether the act moved the page. Read before the verb runs, because
    // afterwards there is nothing left that remembers where the page was.
    const before = await this.snapshot(page).catch(() => undefined);
    // AND THE LEASE AGAIN, because the line above is an AWAIT.
    //
    // `execute` checks the permit and, on this path, used to reach
    // `dispatchVerb` with nothing to yield on in between — so its check was
    // the last word right up to the click. The snapshot changed that: it
    // evaluates in the page, and a person taking control while it runs would
    // otherwise get the agent's click or keystroke in their own browser a beat
    // later. Discarding the observation afterwards does not help; `afterAct`
    // can decline to LOOK at the page, it cannot un-type a password into it.
    if (!permit()) {
      return this.leaseBlockedResult(
        "a person took control of this browser before this action ran; nothing was run and nothing was observed",
      );
    }
    try {
      // RESOLVED HERE, not in `dispatchVerb`, because a ref is only meaningful
      // against the tab that issued it: the token check needs `tabId` and the
      // live entry, and `dispatchVerb` is handed a page. Throws `ActError`, so
      // the classifier below reports `stale_ref` / `unknown_ref` as themselves
      // rather than matching prose and landing on `act_failed`.
      const refNode = await this.resolveActRef(
        tabId,
        entry,
        action.target,
        permit,
      );
      // AND THE LEASE AGAIN, because resolving a ref is several awaits: a
      // node lookup, sometimes a whole AX tree re-read for the recovery, then
      // a scroll and a box measurement. The check above was the last word only
      // while nothing yielded between it and the click; it no longer is.
      if (!permit()) {
        return this.leaseBlockedResult(
          "a person took control of this browser while its target was being " +
            "resolved; nothing was run and nothing was observed",
        );
      }
      await this.dispatchVerb(page, action, permit, refNode);
    } catch (error) {
      // A target that cannot be resolved is a NORMAL answer the model must be
      // able to act on ("the button isn't there"), not a daemon fault — and
      // Playwright's own timeout prose would just confuse it.
      if (error instanceof LeaseTakenMidAct) {
        // NOT an act failure. Said precisely, because a composite stops
        // halfway: the fields before the handoff are in the page, and a model
        // told "nothing was run" would fill them a second time.
        return this.leaseBlockedResult(
          "a person took control of this browser partway through this action; " +
            "any earlier steps of it have already been applied to the page — " +
            "re-observe after they hand it back rather than repeating it",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      // A failure THIS FILE raised already carries its code; only an unknown
      // throw from a page primitive is classified by matching prose.
      const kind =
        error instanceof ActError
          ? error.code
          : /timeout|not found|no element|strict mode/i.test(message)
          ? "target_not_found"
          : "act_failed";
      // Same rule as the success path: the act may have failed, but the page
      // it failed on can still be someone's now. `afterAct` asks `permit()`
      // before it reads anything, and `observation` asks again on the way out,
      // because the read is an await and a handoff can land inside it.
      //
      // A FAILED ACT CARRIES THE FRESH TREE TOO: "your selector matched
      // nothing" plus the list of what the page DOES offer is one turn; the
      // bare refusal is two.
      const fresh = await this.afterAct(tabId, entry, permit, wants, before);
      // A HANDOFF DURING THAT READ WINS, exactly as it does on the success
      // path above. Keeping the act's own error instead would drop the
      // `leaseBlocked` flag, and that flag is not decoration: the handler maps
      // it to 423 and the tool layer forgets its cached tokens off it, so a
      // person taking the browser here would be reported to the model as "your
      // selector matched nothing" and the turn would go on pinning acts to a
      // page they have since navigated. The flag cannot simply be merged onto
      // the act error either — the handler reads the refusal CODE out of that
      // string, and `target_not_found` under a 423 reads to the client codec
      // as an unknown refusal.
      if (fresh.leaseBlocked) return fresh;
      return {
        ok: false,
        error: `${kind}: ${message.split("\n")[0]}`,
        // Hand back the CURRENT state anyway: a failed act still moves the
        // model forward if it can see what the page actually looks like. It
        // carries the handoff note too — an act that failed right after a
        // person used the browser most likely failed BECAUSE the page is now
        // somewhere else, and "your click missed" would be the wrong lesson.
        ...(fresh.ok
          ? {
              ...(fresh.stateToken ? { stateToken: fresh.stateToken } : {}),
              ...(fresh.output !== undefined ? { output: fresh.output } : {}),
            }
          : {}),
      };
    }

    // THE ACT'S OWN DIALOG. A click that calls `confirm()` blocks the renderer
    // before this line, and settling against a blocked renderer burns the full
    // 10s budget to report a page "unsettled" — which is true and useless.
    // Answered here so the settle below runs against a page that is running.
    const stillBlocked = await this.answerOrRefuseDialog(
      tabId,
      action,
      permit,
      source,
    );
    if (stillBlocked) {
      // The dialog was NOT answered — a person raised it with their own
      // command, and it is theirs. Returning here rather than pressing on is
      // the whole point: the settle and the capture below would each spend
      // their full budget against a stopped renderer and then describe the
      // frame from before the dialog, which reads as an action that quietly
      // did nothing.
      //
      // `ok: true`, because the act RAN. The refusal shape would promise that
      // nothing did, and a caller told that would do it again.
      const pending = entry.page.pendingDialog?.();
      return {
        ok: true,
        settled: false,
        output: {
          ...(pending
            ? {
                dialog: {
                  kind: pending.kind,
                  message: pending.message,
                  pending: true,
                },
              }
            : {}),
          note:
            "the action ran and the page is now blocked on a dialog; it is " +
            "waiting for whoever holds this browser to answer it",
        },
      };
    }
    const settled = await this.settle(page);
    const observed = await this.afterAct(
      tabId,
      entry,
      permit,
      wants,
      before,
      "the action ran, but a person took control of this browser before its result could be observed; re-observe after they hand it back",
    );
    // `settled` describes the page the act ran on. A refusal describes no page
    // at all, and stapling a load flag to it would suggest one was looked at.
    // `observed` is spread LAST so an observation that could not be taken keeps
    // its own `settled: false` rather than being overwritten with the settle
    // result of a page it never managed to read.
    return observed.ok ? { settled, ...observed } : observed;
  }

  /**
   * Map an act verb onto the page primitives.
   *
   * `permit` is threaded in for the COMPOSITE verbs only. A single-step verb is
   * one dispatch and the caller's check immediately precedes it; `fill_form` is
   * a loop of awaited page writes, so a person taking the browser after the
   * first field would otherwise have the rest of the form — and the Enter —
   * typed into it. The check is between steps because there is no way to take
   * back the ones already made.
   */
  /**
   * Turn an `a11yRef` target into a live node, or refuse in the model's terms.
   *
   * Three refusals, and they send the model three different places:
   *
   *   - `stale_ref` for a ref minted against a page this tab has since left.
   *     Checked against the state token BEFORE anything is resolved, because a
   *     backend node id is only unique within a document: a new page can reuse
   *     the number, and resolving it would click a stranger with confidence.
   *   - `unknown_ref` for a ref this tab's last observation never issued —
   *     a model quoting a ref from an older turn, or inventing one.
   *   - `stale_ref` again when the id is dead AND no node still carries that
   *     exact role and name (`resolveRefNode` does the recovery).
   */
  private async resolveActRef(
    tabId: string,
    entry: TabEntry,
    target: BrowserActTarget | undefined,
    permit: () => boolean = () => true,
  ): Promise<ResolvedRefNode | undefined> {
    if (!target || !("a11yRef" in target)) return undefined;
    const raw = target.a11yRef;
    const map = this.refs.get(tabId);
    if (map && !this.refsStillDescribe(tabId, entry, map)) {
      this.refs.delete(tabId);
      throw new ActError(
        "stale_ref",
        `${raw} was issued for a page this tab has since left; observe again ` +
          "and use a ref from the new page",
      );
    }
    const parsed = parseRef(raw);
    const known = parsed ? map?.entries.get(parsed) : undefined;
    if (!known) {
      throw new ActError(
        "unknown_ref",
        `${raw} is not a ref from this tab's last observation; observe again ` +
          "and use a ref it names",
      );
    }
    const cdp = await entry.page.cdp();
    if (!cdp) {
      // An engine with no CDP session can still be driven by selector and
      // coordinates, so this is a capability answer rather than a fault.
      throw new ActError(
        "unsupported_target",
        "this browser cannot resolve refs; use a selector or coordinates",
      );
    }
    try {
      // The recovery path RE-READS THE PAGE's accessibility tree, which is an
      // observation — and the lease forbids observing as firmly as it forbids
      // acting. Asked here because the lookup above is an await.
      return await resolveRefNode(cdp, parsed!, known, permit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ActError("stale_ref", message.replace(/^stale_ref:\s*/, ""));
    }
  }

  /**
   * Where to aim for a resolved ref, refusing when something is on top of it.
   *
   * The occlusion check is HERE and not on the selector path because the two
   * are not in the same position: Playwright's own actionability already
   * refuses a selector click whose element cannot receive the event, which is
   * why those fail as timeouts rather than landing somewhere else. A ref is
   * clicked by coordinate, so nothing else is checking — and a coordinate that
   * lands on a consent banner reports a click that "worked".
   */
  private async pointForRef(
    page: DriverPage,
    refNode: ResolvedRefNode,
    label: string,
    check: "occlusion" | "none",
  ): Promise<ActPoint> {
    const cdp = await page.cdp();
    if (!cdp) {
      throw new ActError(
        "unsupported_target",
        "this browser cannot resolve refs; use a selector or coordinates",
      );
    }
    const point = await pointForBackendNodeId(
      cdp,
      refNode.backendNodeId,
      label,
    );
    if (!this.inViewport(point.x, point.y)) {
      // Scrolled and still outside: a fixed-position element parked off-screen,
      // or a box the layout put beyond the viewport. Clicking those pixels
      // would hit nothing.
      throw new ActError(
        "target_not_found",
        `${label} is at (${point.x}, ${point.y}), outside the ` +
          `${this.viewportLabel} ` +
          "viewport even after scrolling; observe again to see where it is now",
      );
    }
    if (check === "occlusion") {
      const covering = await coveringElementAt(cdp, refNode.backendNodeId);
      if (covering) {
        throw new ActError(
          "target_covered",
          `${label} is covered by ${covering} at its click point, so the ` +
            "input would land on that element instead. Dismiss or interact " +
            "with the covering element first (it is often a dialog, banner, " +
            "or sticky header).",
        );
      }
    }
    return point;
  }

  private async dispatchVerb(
    page: DriverPage,
    action: Extract<BrowserAction, { kind: "act" }>,
    permit: () => boolean = () => true,
    refNode?: ResolvedRefNode,
  ): Promise<void> {
    /** Refuse the NEXT page write when the browser changed hands. */
    const stillOurs = () => {
      if (!permit()) throw new LeaseTakenMidAct("lease taken mid-act");
    };
    const target = action.target;
    const point =
      target && "coordinates" in target
        ? { x: target.coordinates[0], y: target.coordinates[1] }
        : null;
    if (point && !this.inViewport(point.x, point.y)) {
      // Refuse rather than dispatch. Chromium delivers a mouse event outside
      // the viewport quite happily; it hits nothing, and the caller reads an
      // ordinary post-act observation that looks exactly like a click landing
      // on empty space. The daemon is the authority on the coordinate space,
      // so the refusal lives here and not only in the tool schema — the panel
      // and the v1 bridge reach this same path.
      throw new Error(
        `out_of_viewport: (${point.x}, ${point.y}) is outside the ` +
          `${this.viewportLabel} ` +
          "observation viewport; coordinates are CSS pixels with (0, 0) at the " +
          "top-left of the last screenshot",
      );
    }
    const selector = target && "selector" in target ? target.selector : null;
    // Resolved by the caller (`resolveActRef`), which is the only place with
    // the tab identity a ref is scoped to. Here it is just a live node id.
    const refLabel =
      target && "a11yRef" in target ? target.a11yRef : "the target";
    const needCdp = async () => {
      const cdp = await page.cdp();
      if (!cdp) {
        throw new ActError(
          "unsupported_target",
          "this browser cannot resolve refs; use a selector or coordinates",
        );
      }
      return cdp;
    };

    switch (action.verb) {
      case "click":
        if (refNode) {
          const at = await this.pointForRef(
            page,
            refNode,
            refLabel,
            "occlusion",
          );
          // IMMEDIATELY BEFORE THE WRITE. Measuring the target is three round
          // trips, and a person can take the browser inside them.
          stillOurs();
          return page.clickAt(at);
        }
        if (point) return page.clickAt(point);
        if (selector) return page.clickSelector(selector);
        throw new Error(
          "no element: click needs a ref, coordinates or a selector",
        );
      case "hover":
        if (refNode) {
          const at = await this.pointForRef(
            page,
            refNode,
            refLabel,
            "occlusion",
          );
          stillOurs();
          return page.hoverAt(at);
        }
        if (point) return page.hoverAt(point);
        if (selector) return page.hoverSelector(selector);
        throw new Error(
          "no element: hover needs a ref, coordinates or a selector",
        );
      case "type": {
        const text = action.value ?? "";
        // With a ref or a selector, REPLACE the field's value; without either,
        // type into whatever has focus (the model's previous click).
        if (refNode) {
          await replaceTextInNode(await needCdp(), refNode.backendNodeId, text);
        } else if (selector) await page.fillSelector(selector, text);
        else await page.typeText(text);
        // ONE settle and ONE observation for what was two commands. The submit
        // is also the half a model most often cannot pin: it acts on the page
        // its own typing produced, which nothing has observed yet.
        if (action.submit) {
          stillOurs();
          await page.press("Enter");
        }
        return;
      }
      case "fill_form": {
        // Validated HERE because the handler does not: `isValidCommand` checks
        // the envelope and passes the action through untouched, so a
        // `fill_form` with no fields would otherwise reach `for (const field
        // of undefined)`.
        const fields = action.fields;
        if (
          !Array.isArray(fields) ||
          fields.length === 0 ||
          fields.some(
            (field) =>
              typeof field?.selector !== "string" ||
              !field.selector ||
              typeof field?.value !== "string",
          )
        ) {
          throw new ActError(
            "act_failed",
            "fill_form needs fields: [{selector, value}]",
          );
        }
        for (const [index, field] of fields.entries()) {
          stillOurs();
          await this.fillOneField(page, field, index, stillOurs);
        }
        if (action.submit) {
          stillOurs();
          await page.press("Enter");
        }
        return;
      }
      case "press":
        if (!action.value) throw new Error("press needs a key in `value`");
        // A ref makes the key land somewhere named rather than wherever focus
        // happened to be — the difference between Enter submitting the form
        // the model meant and Enter submitting whatever it clicked last.
        if (refNode) {
          const cdp = await needCdp();
          stillOurs();
          await focusBackendNodeId(cdp, refNode.backendNodeId);
          stillOurs();
        }
        return page.press(action.value);
      case "scroll": {
        // Default to one viewport-ish step down, the overwhelmingly common
        // intent, so a bare `scroll` does something useful.
        const [dx, dy] = parseScrollDelta(action.value);
        return page.scrollBy({ dx, dy });
      }
      case "drag": {
        const from = refNode
          ? await this.pointForRef(page, refNode, refLabel, "occlusion")
          : point;
        if (refNode) stillOurs();
        if (!from) throw new Error("drag needs a ref or start coordinates");
        const to = parsePoint(action.value);
        if (!to) {
          throw new Error(
            'drag needs a destination in `value` as "x,y" (viewport coordinates)',
          );
        }
        if (!this.inViewport(to.x, to.y)) {
          // The destination rides in a string and so bypasses the check above;
          // a drag ending off-viewport drops its payload on nothing.
          throw new Error(
            `out_of_viewport: drag destination (${to.x}, ${to.y}) is outside the ` +
              `${this.viewportLabel} observation viewport`,
          );
        }
        return page.dragTo(from, to);
      }
      case "select":
        if (action.value === undefined) {
          throw new Error("select needs the option value in `value`");
        }
        if (refNode) {
          const cdp = await needCdp();
          stillOurs();
          return selectOptionOnNode(
            cdp,
            refNode.backendNodeId,
            action.value,
            refLabel,
          );
        }
        if (!selector) throw new Error("select needs a ref or a selector");
        return page.selectOption(selector, action.value);
      case "close_tab":
      case "activate_tab":
        // Handled by the caller before dispatch.
        return;
      default:
        // UNREACHABLE for this build's own union, and the reason it is here
        // anyway: a verb arrives off the WIRE. A newer inspector talking to
        // this daemon (the lazy-upgrade path reuses a running one) would send
        // a verb this switch has no case for, fall straight through, and be
        // told `ok: true` for something that never happened — a form reported
        // filled with every field still empty. `BROWSERD_PROTOCOL_VERSION`
        // exists to stop that pairing; this is what it costs if one slips
        // through.
        throw new ActError(
          "act_failed",
          `this browser daemon does not support the "${
            (action as { verb: string }).verb
          }" verb; it is running an older build`,
        );
    }
  }

  /**
   * One field of a `fill_form`, with the `<select>` fallback.
   *
   * A model should not have to know what KIND of control it is filling: it
   * read "Size" off a tree or a screenshot and wants "L" in it, so the
   * fallback is driven by Playwright's own refusal rather than by a per-field
   * hint the model would have to get right.
   *
   * WHICH refusal, measured against a real Chromium rather than guessed —
   * the two messages differ by one item in the same list:
   *
   *   <select>  "Element is not an <input>, <textarea> or [contenteditable]
   *              element"
   *   <button>  "Element is not an <input>, <textarea>, <select> or
   *              [contenteditable] and does not have a role allowing
   *              [aria-readonly]"
   *
   * So "names <input>" alone is NOT the discriminator: it matches both, and
   * matching the second sent a `fill` at a button off to `selectOption`, which
   * failed for its own unrelated reason and reported that instead of "this
   * element cannot be filled". The `<select>` case is the one whose message
   * does not offer `<select>` as an alternative.
   *
   * Any OTHER failure stops the form. Half a filled form is a state the page
   * is in and the model cannot see, so the error names the field that failed
   * AND the ones that went in before it.
   */
  private async fillOneField(
    page: DriverPage,
    field: { selector: string; value: string },
    index: number,
    stillOurs: () => void,
  ): Promise<void> {
    try {
      await page.fillSelector(field.selector, field.value);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNotAnInputRefusal(message)) {
        throw new ActError(
          "fill_form_failed",
          `field ${index + 1} (${field.selector}): ${message.split("\n")[0]}` +
            (index > 0 ? `; fields 1..${index} were filled` : ""),
        );
      }
      // OUTSIDE the try below, and re-asked at all because the fill we just
      // waited on can take the whole act timeout — long enough for someone to
      // take the browser, after which `selectOption` is a page write into
      // their hands. Outside, because the catch turns everything it sees into
      // `fill_form_failed`, and a handoff relabelled as a field failure loses
      // the flag that makes it a 423 and drops the turn's cached tokens.
      stillOurs();
      try {
        await page.selectOption(field.selector, field.value);
      } catch (selectError) {
        const detail =
          selectError instanceof Error
            ? selectError.message
            : String(selectError);
        throw new ActError(
          "fill_form_failed",
          `field ${index + 1} (${field.selector}): ${detail.split("\n")[0]}` +
            (index > 0 ? `; fields 1..${index} were filled` : ""),
        );
      }
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
      const stale = this.bindingRefusal(
        tabId,
        entry,
        bridge,
        action.toolKey,
        binding,
      );
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
      const frame = await this.snapshot(entry.page).catch(() => undefined);
      // The tool's own result is authoritative even if it navigated away.
      // Failure to sample the destination must not turn completed work into a failure.
      if (!frame)
        return permit()
          ? {
              ok: true,
              output: {
                invocationId,
                result: capped,
                ...(omitted ? { omitted } : {}),
              },
            }
          : this.leaseBlockedResult(
              "The tool ran, but control changed before its result could be read.",
            );
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
            : `webmcp_error: ${
                error instanceof Error ? error.message : String(error)
              }`,
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
      //
      // AND NO TAB IS RESOLVED FIRST. The latch is keyed by COMMAND, not by
      // page, so it needs no live tab — and the command it names may be queued
      // behind a `navigate {newTab: true}` whose tab does not exist yet.
      // Resolving one here answered `unknown_tab` and dropped the Stop on the
      // floor, and the page tool then ran a moment later under a cancellation
      // the user had already made. A tab is required only to reach a BRIDGE,
      // which is required only when there is an id to hand it — below.
      if (action.commandId) this.latchCancel(action.commandId);
      return { ok: true, output: { cancelled: false, known: false } };
    }
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
    return {
      ok: true,
      output: { cancelled: known, known: true, invocationId },
    };
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
    observe?: ActObserve,
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
    this.bumpWebmcpRevision(entry);
    const settled = await this.settle(entry.page);
    const blockedDetail =
      "the navigation ran, but a person took control of this browser before the page could be observed; re-observe after they hand it back";
    // THE SAME PATH AN ACT TAKES. A navigation folding in its own observation
    // through a second mechanism would be the one thing `wantsFor` exists to
    // prevent — two files disagreeing about what a mode means.
    //
    // `wantsFor`'s wire default is a screenshot, which is right for an act and
    // wrong here: a navigation has always answered with its URL and nothing
    // else, so absent maps to `none` before the shared mapping is applied.
    const observed = await this.afterAct(
      tabId,
      entry,
      permit,
      wantsFor(observe ?? "none"),
      undefined,
      blockedDetail,
    );
    // Spread order as in `act`: an observation that could not be taken keeps
    // its own `settled: false` rather than the settle result of a page it
    // never read.
    return observed.ok ? { settled, ...observed } : observed;
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
        const rendered = await this.renderA11y(tabId, entry, action);
        if (!rendered.ok) return rendered.error;
        // The tree FIRST, then the frame the token is minted from: a snapshot
        // taken before the walk would describe a page the tree may already
        // have moved past.
        const frame = await this.snapshot(entry.page);
        const result = this.observation(
          tabId,
          entry,
          rendered.fields,
          frame,
          permit,
        );
        this.commitRefs(tabId, result, rendered.refMap);
        return result;
      }
      case "dialog": {
        // Touches no page, which is the property that makes it answerable
        // while a dialog has the renderer stopped — and reading it is how a
        // caller learns what it is about to decide.
        const pending = entry.page.pendingDialog?.() ?? null;
        const frame = await this.snapshot(entry.page);
        return this.observation(
          tabId,
          entry,
          { dialog: pending },
          frame,
          permit,
        );
      }
      case "network": {
        const all = entry.page.networkEntries?.();
        if (!all) {
          // "This browser cannot tell you" and "this page made no requests"
          // are different facts, and a model acts differently on each — an
          // empty array for the first would send it looking for a cause that
          // was never captured.
          return {
            ok: false,
            error: formatBrowserdError(
              "a11y_unavailable",
              "this browser build does not record network requests",
            ),
          };
        }
        if (action.requestId) {
          const one = entry.page
            .networkEntries?.()
            .find((row) => row.requestId === action.requestId);
          const frame = await this.snapshot(entry.page);
          return this.observation(
            tabId,
            entry,
            one
              ? { network: [one] }
              : {
                  network: [],
                  // Named rather than left as an empty list: the ring is
                  // bounded, and "it scrolled off" is the answer.
                  omitted: 1,
                },
            frame,
            permit,
          );
        }
        const { entries: rows, omitted } = capNetwork(all, this.networkBudget);
        const frame = await this.snapshot(entry.page);
        return this.observation(
          tabId,
          entry,
          { network: rows, ...(omitted > 0 ? { omitted } : {}) },
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
          {
            webmcpSupported: true,
            tools: bridge.list(),
            ...(bridge.discoveryLimitReached?.()
              ? {
                  notice:
                    "Page tool discovery exceeded its security budget. Reduce registrations and reload the page; browsing remains available.",
                }
              : {}),
          },
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
    const entry = this.tabs.get(tabId ?? this.activeTabId ?? DEFAULT_TAB);
    if (!entry) return undefined;
    return computeStateToken({
      tabId: tabId ?? this.activeTabId ?? DEFAULT_TAB,
      navCounter: entry.navCounter,
      url: entry.page.url(),
      domSignal: await entry.page.domStructureSignal(),
      viewportRevision: this.sessionViewport.revision,
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
  /**
   * The whole truth about this browser, for the pane's shell.
   *
   * A SEPARATE READ from `tabsSnapshot`, not a richer version of it, and the
   * two are kept apart on purpose. `tabsSnapshot` rides the frame heartbeat:
   * it is synchronous, budgeted to a few kilobytes, and drops tabs from the
   * end when a session has more than fit — which is exactly right for a
   * caption over a video and exactly wrong for a tab strip, where the tab that
   * got dropped is the one somebody is looking for.
   *
   * This one is asynchronous (it asks each tab's CDP session for its title,
   * icon and history), complete, and fetched on its own endpoint. Nothing is
   * truncated: a browser with thirty tabs has thirty tabs, and a strip that
   * silently showed sixteen of them would be lying about a thing the person
   * can count.
   *
   * `seq` is a monotonic counter rather than a timestamp: two snapshots taken
   * inside the same millisecond are ordinary on a fast box, and a reducer that
   * cannot order them would drop one at random.
   */
  interactionAnchor():
    | import("../../../../shared/browser-pane-command").InteractionAnchor
    | undefined {
    const tabId = this.activeTabId;
    const entry = tabId ? this.tabs.get(tabId) : undefined;
    if (!tabId || !entry || entry.page.isClosed()) return undefined;
    return {
      tabId,
      url: safeUrl(entry.page),
      navCounter: entry.navCounter,
      viewportRevision: this.sessionViewport.revision,
    };
  }

  async stateSnapshot(): Promise<{
    seq: number;
    tabs: Array<{
      id: string;
      url: string;
      title: string;
      faviconUrl?: string;
      navCounter: number;
      loading: boolean;
      openerId?: string;
    }>;
    activeTabId: string | null;
    canGoBack: boolean;
    canGoForward: boolean;
    viewport: SessionViewport;
    policy: SessionViewportPolicy;
  }> {
    const hadTabs = this.tabs.size > 0;
    for (const [id, entry] of [...this.tabs]) {
      if (entry.page.isClosed()) await this.dropTab(id);
    }
    if (hadTabs && this.tabs.size === 0 && !this.closing)
      await this.getOrCreateTab(DEFAULT_TAB);
    const live = [...this.tabs.entries()];
    // IN PARALLEL. Serially, a browser with a dozen tabs would spend a dozen
    // CDP round trips per heartbeat, and the strip would lag the browser by
    // more than the interval that refreshes it.
    const read = await Promise.all(
      live.map(async ([id, entry]) => {
        const cdp = await entry.page.cdp().catch(() => null);
        const meta = await readTabMetadata(cdp, safeUrl(entry.page));
        return { id, meta, entry };
      }),
    );
    const activeTabId =
      this.activeTabId && read.some(({ id }) => id === this.activeTabId)
        ? this.activeTabId
        : read[0]?.id ?? null;
    const active = read.find(({ id }) => id === activeTabId);
    this.stateSeq += 1;
    return {
      seq: this.stateSeq,
      tabs: read.map(({ id, meta, entry }) => ({
        id,
        navCounter: entry.navCounter,
        ...(entry.openerId ? { openerId: entry.openerId } : {}),
        url: meta.url,
        title: meta.title,
        ...(meta.faviconUrl ? { faviconUrl: meta.faviconUrl } : {}),
        loading: entry.loading ?? false,
      })),
      activeTabId,
      // The ACTIVE tab's history, which is what the two buttons act on.
      canGoBack: active?.meta.canGoBack ?? false,
      canGoForward: active?.meta.canGoForward ?? false,
      viewport: this.sessionViewport,
      policy: this.viewportPolicy,
    };
  }

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

  /**
   * The viewport this tab already has, without ever creating one.
   *
   * `viewport()` below opens the tab and attaches a CDP session on a miss.
   * That is right for a person opening the pane and wrong for the frame-rate
   * boost after an agent command, which only wants to nudge a picture someone
   * is ALREADY watching: on a box with no pane open, going through
   * `viewport()` would attach a screencast and start encoding JPEGs for
   * nobody, on the same two cores the agent is using.
   *
   * Returns the map's promise rather than awaiting it, so a viewport that is
   * still being created counts as watched — somebody asked for it.
   */
  viewportIfWatched(tabId?: string): Promise<TabViewport | null> | null {
    return this.viewports.get(tabId ?? DEFAULT_TAB) ?? null;
  }

  async viewport(tabId?: string): Promise<TabViewport | null> {
    const key = tabId ?? this.activeTabId ?? DEFAULT_TAB;
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
      // The SESSION's size, read at attach time. A pane opening on a session
      // that has already been resized has to letterbox against the picture it
      // is actually being sent, not against the size the session launched at.
      return createTabViewport(cdp, {
        surface: {
          width: this.sessionViewport.width,
          height: this.sessionViewport.height,
        },
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
    this.stopPageCreated?.();
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
    const cursors = entry.page.consoleCursor?.();
    return {
      ok: true,
      // ON EVERY OBSERVATION, at the funnel, so no mode can forget it. A change
      // the model's OWN action caused — a navigation, a click that mounted a
      // component that registers a tool — is then visible in the result the
      // model already paid for, and costs no extra round trip.
      ...this.webmcpEnvelope(tabId, entry),
      // Beside `stateToken`, never inside `output`: `output` is the payload
      // that goes to the model through the untrusted-content fence, and our own
      // ring accounting has no business in there. The ledger lifts them out.
      ...(cursors ? { cursors } : {}),
      // WHERE this came from, on every observation without exception. The
      // unattended origin allowlist is enforced against the result's `url`
      // (`enforceResultOrigin` in built-in-tools/browser.ts), and a result
      // carrying none fails that check OPEN — a screenshot of an off-allowlist
      // page would reach the model unfiltered. Stamped at the funnel so no
      // future observation mode can forget it. An explicit `url` in `output`
      // still wins; today it is the same value.
      output: this.withDialogNote(
        tabId,
        this.withHandoffNote({
          url: frame.url,
          // THE SIZE THIS WAS SEEN AT, on every observation without exception.
          // It is what the model's coordinates are read in, and on a session
          // that can be resized it is the only honest way to know: the tool
          // schema states a range rather than a size, precisely so that it
          // does not have to be regenerated — and its hash rotated — every
          // time somebody drags a panel.
          //
          // In `output` rather than beside it, unlike `stateToken` and
          // `cursors`, because this one IS for the model: it is the number it
          // has to compute against.
          viewport: {
            width: this.sessionViewport.width,
            height: this.sessionViewport.height,
          },
          ...output,
        }),
      ),
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
  /**
   * Fold in what was decided about a dialog, once, on the next observation.
   *
   * Consumed like the handoff note and for the same reason: it describes one
   * moment, and repeating it on every later result would tell the model a
   * dialog keeps appearing.
   */
  private withDialogNote(
    tabId: string,
    output: Record<string, unknown>,
  ): Record<string, unknown> {
    const note = this.dialogNotes.get(tabId);
    if (!note) return output;
    this.dialogNotes.delete(tabId);
    return { ...output, dialog: note };
  }

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
  /**
   * Answer a pending dialog, or refuse the command that cannot run past one.
   *
   * Returns a refusal when the command must not proceed, and `undefined` when
   * the page is clear — either it always was, or this call just made it so.
   *
   * WHO ANSWERS depends on the lease, and that is the whole reason the page
   * wrapper captures dialogs instead of answering them. With the browser free,
   * an agent-driven dialog is answered here on the agent's behalf and the
   * choice is recorded for the model to read. With a person holding it, the
   * dialog is THEIRS — dismissing it out from under someone signing in is
   * exactly the surprise the handoff exists to prevent — so it stays open and
   * the agent is told why its command cannot run.
   */
  private async answerOrRefuseDialog(
    tabId: string,
    action: BrowserAction,
    permit: () => boolean,
    source: BrowserCommand["source"],
  ): Promise<BrowserCommandResult | undefined> {
    const entry = this.tabs.get(tabId);
    const dialog = entry?.page.pendingDialog?.();
    if (!entry || !dialog) return undefined;
    // WHO GETS TO DECIDE, and the three ways the answer is "not us":
    //
    //   - `manual` is the pane. A person's own command never answers their own
    //     dialog: answering it from under one of their reads would take the
    //     decision away at the exact moment they were making it.
    //   - Somebody else holds the lease, so the dialog is theirs.
    //   - The client asked to decide for itself (`dialogPolicy: "ask"`). A
    //     default is a guess at what a client meant, and one with its own
    //     interaction rules — ask the person, always confirm a known flow —
    //     needs that guess not to be made. It answers with `accept_dialog` /
    //     `dismiss_dialog`, which work under either policy.
    //
    // In all three the reads that do not touch the blocked page still pass,
    // which is how anyone sees the dialog they are being asked about.
    // A COMMAND THAT DOES NOT NEED THE PAGE UNBLOCKED IS NEVER A REASON TO
    // ANSWER. Checked first, above every policy: a screenshot, the URL, the
    // console, and the dialog read itself are precisely how a caller looks at
    // the dialog before deciding — and answering one in order to serve them
    // destroys the thing they were looking at. Answering it is also on this
    // list, which is what stops the fallback from consuming the dialog before
    // the explicit verb can reach it.
    if (safeUnderDialog(action)) return undefined;
    const decideForCaller =
      source !== "manual" && permit() && this.dialogPolicy === "auto";
    if (!decideForCaller) {
      return { ok: false, error: dialogRefusal(dialog) };
    }
    const accept = agentDefaultAccepts(dialog.kind);
    const answered = await entry.page
      .resolveDialog?.(accept)
      .catch(() => false);
    if (!answered) {
      // Nothing there to answer after all (the page closed it, or a race).
      // Proceeding is right: the renderer is running again either way.
      return undefined;
    }
    // RECORDED, not merely handled. "I clicked Delete and nothing happened"
    // and "I clicked Delete, a confirmation appeared, and it was cancelled on
    // your behalf" lead the model to completely different next moves.
    this.dialogNotes.set(tabId, {
      kind: dialog.kind,
      message: dialog.message,
      choice: accept ? "accepted" : "dismissed",
      auto: true,
    });
    return undefined;
  }

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
  private purgeHandoffRings(): void {
    const since = this.lease?.consumeResumedHeldSince?.();
    if (since === undefined) return;
    for (const entry of this.tabs.values()) {
      if (entry.page.isClosed()) continue;
      try {
        entry.page.dropConsoleSince(since);
        // THE NETWORK RING TOO, and for a stronger reason than the console:
        // it records the URLs a person visited while they held the browser and
        // the requests their signing-in produced. Purging one ring and not the
        // other would make the lease's promise "you must wait to read it"
        // rather than "it is private".
        entry.page.dropNetworkSince?.(since);
      } catch {
        // A page that cannot be purged must not take the command down; the
        // budgeted reads that follow are capped either way.
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
      // The revision AT THE MOMENT OF THE OBSERVATION, which is what makes the
      // comparison mean anything: an act decided from this token is refused
      // once the layout has been re-flowed underneath it, even when the DOM
      // came out structurally identical.
      viewportRevision: this.sessionViewport.revision,
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

  private async registerTab(
    tabId: string,
    page: DriverPage,
    openerId?: string,
    background = false,
  ): Promise<TabEntry> {
    const entry: TabEntry = {
      page,
      ...(openerId ? { openerId } : {}),
      navCounter: 0,
      webmcp: emptyWebmcpState(),
    };
    this.tabs.set(tabId, entry);
    void page
      .cdp()
      .then(async (cdp) => {
        if (!cdp || this.tabs.get(tabId) !== entry) return;
        const frames = new Set<string>();
        cdp.on("Page.frameStartedLoading", (raw) => {
          if (this.tabs.get(tabId) !== entry) return;
          frames.add((raw as { frameId: string }).frameId);
          entry.loading = true;
        });
        cdp.on("Page.frameStoppedLoading", (raw) => {
          if (this.tabs.get(tabId) !== entry) return;
          frames.delete((raw as { frameId: string }).frameId);
          entry.loading = frames.size > 0;
        });
        await cdp.send("Page.enable");
      })
      .catch(() => {});
    // THE SESSION'S SIZE, not the launch size.
    //
    // A page opens at whatever the browser was launched with, and on a
    // `followPane` session that stops being the right answer the first time
    // somebody drags the panel. Without this, every tab opened after a resize
    // laid out at 1024x768 while the session published the panel's size — so
    // the model read one rectangle and clicked in another, on the tab it had
    // just opened.
    //
    // Registered BEFORE this await, and re-checked by `applyViewport` after
    // its own loop: between those two, a page created while a resize is
    // transitioning is picked up by whichever of them runs second.
    await entry.page
      .setViewportSize?.({
        width: this.sessionViewport.width,
        height: this.sessionViewport.height,
      })
      .catch(() => {
        // A page that cannot be sized is not a reason to fail opening the
        // tab: the engine may not support it at all, which is exactly what
        // `applyViewport` refuses on and this path must tolerate.
      });
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
    if (!background) {
      this.activeTabId = tabId;
      if (openerId) await page.bringToFront?.().catch(() => {});
    } else if (this.activeTabId) {
      await this.tabs
        .get(this.activeTabId)
        ?.page.bringToFront?.()
        .catch(() => {});
    }
    return entry;
  }

  /** `null` means teardown has begun and no new page will be opened. */
  private async getOrCreateTab(tabId: string): Promise<TabEntry | null> {
    const existing = this.tabs.get(tabId);
    if (existing && !existing.page.isClosed()) return existing;
    const inFlight = this.pendingTabs.get(tabId);
    if (inFlight) return inFlight;
    if (this.closing) return null;
    if (this.tabs.size + this.pendingTabs.size >= this.maxTabs) {
      throw new Error(
        `not found: this browser is at its limit of ${this.maxTabs} tabs — close one first`,
      );
    }
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
      return this.registerTab(tabId, page);
    })();
    this.pendingTabs.set(tabId, creating);
    try {
      return await creating;
    } finally {
      this.pendingTabs.delete(tabId);
    }
  }

  /**
   * Read, filter, cap, number and render one a11y tree — everything between
   * "ask the page" and "here are the fields", for BOTH readers of a tree.
   *
   * filter → cap → number → render, in that order, and the order is
   * load-bearing. Filtering first keeps the budget from being spent on prose
   * the interactive view will not show; numbering after the cap keeps every
   * ref in the map reachable in the text (a ref stamped on a node the budget
   * then dropped would be a name for something the model cannot see);
   * rendering last means the map and the text were built from one pass over
   * one tree.
   *
   * IT DOES NOT TAKE THE FRAME SNAPSHOT. The caller does, after this returns,
   * so the token an observation carries describes the page as it was once the
   * tree had been walked — never before it.
   */
  private async renderA11y(
    tabId: string,
    entry: TabEntry,
    action: {
      rootSelector?: string;
      rootRef?: string;
      filter?: "interactive" | "all";
    },
  ): Promise<
    | {
        ok: true;
        fields: Record<string, unknown>;
        refMap: Map<string, RefEntry>;
      }
    | { ok: false; error: BrowserCommandResult }
  > {
    const raw = await this.readA11y(tabId, entry, action);
    if (!raw.ok) return raw;
    const filtered =
      raw.filter === "interactive" && raw.tree
        ? filterInteractive(raw.tree)
        : raw.tree;
    const { tree, omittedSubtrees, totalNodes } = capA11yTree(
      filtered,
      this.a11yBudget,
    );
    const refs = assignRefs(tree);
    const rendered = renderA11yTree(tree, {
      interactiveOnly: raw.filter === "interactive",
    });
    return {
      ok: true,
      fields: {
        a11y: rendered,
        refs: Object.fromEntries(
          [...refs].map(([ref, entryValue]) => [
            ref,
            { role: entryValue.role, name: entryValue.name },
          ]),
        ),
        ...(omittedSubtrees > 0 ? { omittedSubtrees, totalNodes } : {}),
      },
      refMap: refs,
    };
  }

  /**
   * Store (or discard) the refs an observation just minted.
   *
   * COMMITTED ONLY IF THE OBSERVATION WAS HANDED OVER. A handoff landing
   * mid-read discards the result — and refs stored anyway would be names for a
   * page the model was never shown, guessable afterwards by a model that never
   * received them. On that path the old map goes too: it described a page this
   * tab may no longer be on.
   *
   * A commit REPLACES the per-tab map wholesale: refs are valid for exactly
   * one observation, and leaving an older map merged underneath is how `e7`
   * comes to mean two things at once. Bound to the token the observation
   * carries, so a ref used after the page moved is refused rather than
   * resolved by name against whatever is there now.
   */
  private commitRefs(
    tabId: string,
    result: BrowserCommandResult,
    refMap: Map<string, RefEntry> | undefined,
  ): void {
    if (!result.ok || !refMap) {
      this.refs.delete(tabId);
      return;
    }
    this.refs.set(tabId, { stateToken: result.stateToken, entries: refMap });
  }

  /**
   * THE ONE FUNNEL for "what does the page look like now that something
   * happened to it" — the post-act observation (L1), the observation a failed
   * act still owes, and the fresh page a `stale_observation` refusal hands
   * back.
   *
   * Every caller reaches `observation` through here, so `withHandoffNote` and
   * the final permit re-check are inherited rather than repeated, and the refs
   * an act's tree hands out are committed with the same semantics an `observe`
   * gives them — which is what makes `rootRef` zoom work off an act result.
   *
   * `before` is the frame captured just before the verb ran; `previousUrl` is
   * reported only when the act actually moved the page, because a URL repeated
   * on every result is noise the model has to read past.
   */
  private async afterAct(
    tabId: string,
    entry: TabEntry,
    permit: () => boolean,
    wants: { a11y: boolean; screenshot: boolean },
    before?: FrameSnapshot,
    blockedDetail?: string,
  ): Promise<BrowserCommandResult> {
    // Before ANY read, the same rule `observe` opens with: a person holding
    // the browser is not shown to the model, and the cheap refusal comes
    // before the expensive read rather than after it.
    if (!permit()) {
      return this.leaseBlockedResult(
        blockedDetail ??
          "a person has taken control of this browser; nothing was observed",
      );
    }
    const page = entry.page;
    // THE FRAME THE CAPTURES ARE TAKEN AGAINST, sampled before them and again
    // after, exactly as `observeScreenshot` does — and for the same P1.
    //
    // A token minted AFTER an image describes a page the image may not show.
    // That is the dangerous direction: an act chosen from the stale image and
    // pinned to that token MATCHES the live tab and sails through
    // `guardStaleness`, which is precisely the stale targeting L3 exists to
    // refuse. (Minting it before, as this path used to, errs the other way —
    // the token is older than the image, so the guard REFUSES. Safe, but only
    // by accident.) Sampling both sides lets the result say which it is.
    //
    // Skipped when nothing is captured: with `observe:"none"` there is no
    // image and no tree to bind, so the one snapshot below is the whole story.
    const captures = wants.a11y || wants.screenshot;
    const pre = captures
      ? await this.snapshot(page).catch(() => undefined)
      : undefined;
    let a11yFields: Record<string, unknown> = {};
    let refMap: Map<string, RefEntry> | undefined;
    if (wants.a11y) {
      // `.catch` as well as the `ok:false` arm: `renderA11y` READS the page
      // (a CDP attach, an AX tree walk), and a navigation or a closing tab
      // rejects rather than answering. An act that RAN must not come back as
      // a command failure because the aftermath could not be described.
      const rendered = await this.renderA11y(tabId, entry, {
        filter: "interactive",
      }).catch(() => ({ ok: false as const, error: undefined }));
      if (rendered.ok) {
        a11yFields = rendered.fields;
        refMap = rendered.refMap;
      } else {
        // NON-FATAL, deliberately. A page that cannot answer a tree — a PDF, a
        // page whose CDP session went away, a `chrome://` surface — must not
        // turn a click that WORKED into a failed act. Say the tree is missing
        // and hand back everything else.
        a11yFields = { a11yUnavailable: true };
      }
    }
    const screenshot = wants.screenshot
      ? await page.screenshotBase64().catch(() => undefined)
      : undefined;
    // AFTER both reads: the token must describe the state the output was
    // captured against, and a snapshot taken first would describe the page as
    // it was before a tree walk that can take a moment.
    //
    // AND IT CAN REJECT. `domStructureSignal` is an in-page evaluate, and a
    // navigation destroys the execution context it runs in — which a submitted
    // form does as a matter of course. Letting that escape would report a
    // COMPLETED act as a failed command, and the obvious next move for a model
    // reading a failure is to try again: the form gets submitted twice.
    const frame = await this.snapshot(page).catch(() => undefined);
    if (!frame) {
      if (!permit()) {
        return this.leaseBlockedResult(
          blockedDetail ??
            "a person has taken control of this browser; nothing was observed",
        );
      }
      // The act ran; we cannot say what it produced. NO STATE TOKEN, which is
      // the honest answer and also the safe one: the tool layer keeps the
      // token it already had, the next act pins to that, and `guardStaleness`
      // refuses it with a fresh look rather than acting on a page nobody has
      // seen. `settled: false` tells the model to look again.
      //
      // AND NO CAPTURE WITHOUT A URL TO ATTRIBUTE IT TO. This return does not
      // pass through `observation`, so it has to keep that funnel's promise
      // itself: the unattended origin allowlist is enforced against a result's
      // `url` and fails OPEN without one, so a tree or a screenshot handed back
      // here unnamed would reach the model past a boundary it was never
      // checked against. `page.url()` throws on a closed page — the very case
      // that brought us here — and then there is nothing to check, so the
      // captures go rather than the check.
      //
      // AND NO REFS, minted or remembered. There is no token to bind a fresh
      // map to, and whatever this tab held describes a page we have just
      // failed to read — so the index goes out of the result and the stored
      // map goes with it.
      this.refs.delete(tabId);
      const url = safeUrl(page);
      return {
        ok: true,
        output: this.withHandoffNote(
          url
            ? {
                url,
                ...withoutRefIndex(a11yFields),
                ...(screenshot ? { screenshot } : {}),
                observationFailed: true,
              }
            : { observationFailed: true },
        ),
        settled: false,
      };
    }
    const output = {
      // Only when it MOVED. `url` is on every observation already; a
      // `previousUrl` equal to it teaches the model nothing and costs a line
      // on every act.
      ...(before && before.url !== frame.url
        ? { previousUrl: before.url }
        : {}),
      ...a11yFields,
      ...(screenshot ? { screenshot } : {}),
    };
    // Both must hold, as in `observeScreenshot`: a same-skeleton client-side
    // route change moves the URL while `domSignal` does not.
    const held =
      !captures ||
      (pre !== undefined &&
        pre.url === frame.url &&
        pre.domSignal === frame.domSignal);
    if (!held) {
      // The page moved WHILE it was being captured, so no token here can
      // honestly describe what came back. Sending none is what keeps the next
      // act safe: the tool layer keeps the token it had, that act is pinned to
      // it, and the guard refuses it with a fresh look rather than admitting
      // one aimed at an image of a page that has already changed.
      //
      // No retry, unlike `observeScreenshot`: the act has already run, so
      // there is nothing to take again — only the description, and a second
      // tree walk buys a guess at what is by definition still moving.
      if (!permit()) {
        return this.leaseBlockedResult(
          blockedDetail ??
            "a person has taken control of this browser; nothing was observed",
        );
      }
      // UNCONDITIONALLY, not only when this act read a tree. The page moved
      // under the capture, so a map minted by some earlier observation is
      // describing a state nobody has been shown since — and `refsStillDescribe`
      // would not catch it, because it compares page IDENTITY (which
      // navigation, which URL) rather than shape. Cheap to lose: one
      // `observe {mode:"a11y"}` mints a fresh set.
      this.refs.delete(tabId);
      // `url` explicitly, for the same reason as above: `observation` is what
      // normally stamps it, and skipping that funnel must not also skip the
      // field the origin allowlist is enforced against.
      return {
        ok: true,
        output: this.withHandoffNote({
          url: frame.url,
          ...withoutRefIndex(output),
        }),
        settled: false,
      };
    }
    const result =
      blockedDetail === undefined
        ? this.observation(tabId, entry, output, frame, permit)
        : this.observation(tabId, entry, output, frame, permit, blockedDetail);
    // `wants.a11y`, not `refMap`. An act that ASKED for a tree and could not
    // get one (`a11yUnavailable`) leaves `refMap` undefined, and the
    // conditional then skipped the commit entirely — so the previous
    // observation's map stayed live and answered for a page this act has since
    // changed and failed to describe. `commitRefs` with no map deletes, which
    // is the right answer there. An act that never asked about the tree keeps
    // whatever the tab held: refs are meant to survive a DOM mutation, and
    // this capture proved stable.
    if (wants.a11y) this.commitRefs(tabId, result, refMap);
    return result;
  }

  /**
   * The observation that rides a refusal — `guardStaleness`'s recovery read.
   *
   * Public because the guard sits ABOVE the driver (it is pure, and testable
   * with a fake), so the one thing it cannot do for itself is look at the
   * page. Without this the refusal says "re-read the page" and the model
   * spends the very round trip the state token exists to save.
   */
  async observeForRefusal(
    command: BrowserCommand,
    wants: { a11y: boolean; screenshot: boolean },
  ): Promise<BrowserCommandResult> {
    const tabId = command.tabId ?? this.activeTabId ?? DEFAULT_TAB;
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    // No `before`: nothing ran, so there is no previous URL to report.
    return this.afterAct(tabId, entry, this.permitFor(command), wants);
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
      const unsubscribeTools = bridge.subscribe((tools) => {
        entry.webmcp.tools = tools;
        entry.webmcp.supported = bridge.isSupported();
        this.bumpWebmcpRevision(entry);
      });
      const unsubscribeExternal = bridge.subscribeExternalInvocation?.((name) =>
        this.onExternalInvocation?.(tabId, name),
      );
      entry.webmcp.unsubscribe = () => {
        unsubscribeTools();
        unsubscribeExternal?.();
      };
    })().catch(() => {});
    return entry.webmcp.attaching;
  }

  /**
   * The ONE way a tab's tool generation moves.
   *
   * Two callers: the bridge's change events, and `navigateVerb` — which bumps
   * `navCounter` on a path the bridge never reports (`Page.frameNavigated` has
   * already fired by then). The hash folds `navCounter` in, so it is re-stamped
   * here, on every bump, rather than at announce time (which would describe the
   * previous generation) or on every read (which cost a full hash per
   * heartbeat).
   */
  private bumpWebmcpRevision(entry: TabEntry): void {
    entry.webmcp.revision += 1;
    entry.webmcp.hash = webmcpHashFor(entry.webmcp.tools, entry.navCounter);
  }

  /**
   * A tab's tool set as `{revision, hash, count}`, read from the cache.
   *
   * TOUCHES NO PAGE and computes nothing: both fields are stamped when the
   * generation moves. That is what lets this ride a heartbeat several times a
   * second and be asked before every model step.
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
      hash: entry.webmcp.hash,
      count: entry.webmcp.tools.length,
      supported: entry.webmcp.supported,
      // BOUNDED, like the tab list's URL. This rides an 8 KiB heartbeat record
      // beside up to sixteen tabs' URLs, and a page can make its URL as long
      // as it likes.
      url: safeUrl(entry.page).slice(0, TAB_URL_MAX),
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
    const next = tabAfterClose(
      [...this.tabs].map(([id, tab]) => ({ id, openerId: tab.openerId })),
      tabId,
      this.activeTabId ?? null,
    );
    this.tabs.delete(tabId);
    this.activeTabId = next ?? undefined;
    if (!this.closing && next)
      await this.tabs
        .get(next)
        ?.page.bringToFront?.()
        .catch(() => {});
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
