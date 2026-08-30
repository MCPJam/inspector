/**
 * The real browser driver: it fills the `CommandExecutor` seam PR (a)'s queue
 * drives and PR (b)'s control plane authenticates, turning a `BrowserCommand`
 * into operations on a persistent, multi-tab browser context.
 *
 * W1 scope is deliberately the navigation + observation subset the wave's exit
 * criteria need ("browserd navigates + screenshots"): navigate / back / reload /
 * observe. The `act` verbs and the `webmcp_*` invocations arrive in W3 with the
 * six `browser_*` model tools; until then they return an explicit
 * `unimplemented` result rather than silently doing nothing.
 *
 * It is written entirely against the `DriverContext` / `DriverPage` boundary, so
 * every path here is unit-testable with fakes; the live Playwright context is
 * built by `chromium-launch.ts` and validated by a spike-gated integration test.
 * L2 (settle-before-capture) and L3 (state token on every observation) are wired
 * in here from the pure helpers in PR (c1).
 */
import {
  DEFAULT_QUEUE_KEY,
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
  capToolOutput,
  DEFAULT_A11Y_BUDGET,
  DEFAULT_CONSOLE_BUDGET,
  type A11yBudget,
  type ConsoleBudget,
} from "./observation-budget";
import { WebMcpBridgeError } from "./webmcp-bridge";
import { RESUMED_AFTER_HANDOFF_NOTE, type HandoffLease } from "./lease";
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
   * The human-handoff lease, shared with the request handler. The driver only
   * READS it, to make the first observation after a handoff loud (L6) — the
   * blocking itself happens at the handler, before anything is captured.
   */
  lease?: Pick<HandoffLease, "consumeResumedDirty">;
  a11y?: A11yBudget;
  console?: ConsoleBudget;
  /** Byte budget for a WebMCP tool's returned output (L9). */
  webmcpOutputBytes?: number;
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
  private readonly lease: Pick<HandoffLease, "consumeResumedDirty"> | undefined;
  private readonly tabs = new Map<string, TabEntry>();

  constructor(context: DriverContext, options: ChromiumDriverOptions = {}) {
    this.context = context;
    this.settleOptions = options.settle ?? DEFAULT_SETTLE_OPTIONS;
    this.a11yBudget = options.a11y ?? DEFAULT_A11Y_BUDGET;
    this.consoleBudget = options.console ?? DEFAULT_CONSOLE_BUDGET;
    this.webmcpOutputBudgetBytes =
      options.webmcpOutputBytes ?? DEFAULT_WEBMCP_OUTPUT_BYTES;
    this.lease = options.lease;
  }

  async execute(command: BrowserCommand): Promise<BrowserCommandResult> {
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
        return this.navigateVerb(tabId, await this.getOrCreateTab(tabId), (page) =>
          page.goto(action.url),
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
        return this.navigateVerb(tabId, entry, (page) =>
          action.kind === "back" ? page.goBack() : page.reload(),
        );
      }
      case "observe":
        return this.observe(tabId, action);
      case "act":
        return this.act(tabId, action);
      case "webmcp_invoke":
        return this.webmcpInvoke(tabId, action);
      case "webmcp_cancel":
        return this.webmcpCancel(tabId, action);
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
  ): Promise<BrowserCommandResult> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    const page = entry.page;

    // Tab lifecycle verbs do not produce an observation of their own tab.
    if (action.verb === "close_tab") {
      await page.close().catch(() => {});
      this.tabs.delete(tabId);
      return { ok: true, output: { closed: tabId } };
    }
    if (action.verb === "activate_tab") {
      await page.bringToFront();
      const frame = await this.snapshot(page);
      return this.observation(tabId, entry, { url: frame.url }, frame);
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
      const frame = await this.snapshot(page).catch(() => null);
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
    const frame = await this.snapshot(page);
    const screenshot = await page.screenshotBase64().catch(() => undefined);
    return {
      ...this.observation(
        tabId,
        entry,
        { url: frame.url, ...(screenshot ? { screenshot } : {}) },
        frame,
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
    const point = target && "coordinates" in target
      ? { x: target.coordinates[0], y: target.coordinates[1] }
      : null;
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
    try {
      const { invocationId, output } = await bridge.invoke({
        toolName: action.toolKey,
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
  ): Promise<BrowserCommandResult> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    const bridge = await entry.page.webmcp();
    if (!bridge) {
      return { ok: false, error: "webmcp_unsupported: no WebMCP session" };
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
  ): Promise<BrowserCommandResult> {
    await navigate(entry.page);
    entry.navCounter += 1;
    const settled = await this.settle(entry.page);
    const frame = await this.snapshot(entry.page);
    return {
      ...this.observation(tabId, entry, { url: frame.url }, frame),
      settled,
    };
  }

  private async observe(
    tabId: string,
    action: Extract<BrowserAction, { kind: "observe" }>,
  ): Promise<BrowserCommandResult> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.page.isClosed()) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    switch (action.mode) {
      case "url": {
        const frame = await this.snapshot(entry.page);
        return this.observation(tabId, entry, { url: frame.url }, frame);
      }
      case "dom": {
        // The token is computed from the SAME snapshot returned as output, so
        // they cannot disagree.
        const frame = await this.snapshot(entry.page);
        return this.observation(tabId, entry, { dom: frame.domSignal }, frame);
      }
      case "screenshot":
        return this.observeScreenshot(tabId, entry);
      case "a11y": {
        // L9: the tree is reduced by omitting WHOLE subtrees (each replaced by
        // a marker naming the retrieval verb), never by cutting one open.
        const snapshot = await entry.page.a11ySnapshot();
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
          );
        }
        return this.observation(
          tabId,
          entry,
          { webmcpSupported: true, tools: bridge.list() },
          frame,
        );
      }
    }
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
  ): Promise<BrowserCommandResult> {
    const STABLE_ATTEMPTS = 2;
    for (let attempt = 0; attempt < STABLE_ATTEMPTS; attempt++) {
      const before = await this.snapshot(entry.page);
      const screenshot = await entry.page.screenshotBase64();
      const after = await this.snapshot(entry.page);
      // Both the URL and the DOM must be unchanged: a same-skeleton client-side
      // route change moves the URL while `domSignal` holds, and would otherwise
      // bind a new-route token to an old-route image (P1).
      if (before.url === after.url && before.domSignal === after.domSignal) {
        return this.observation(tabId, entry, { screenshot }, after);
      }
    }
    // Would not stabilise within budget: hand back the frame but flag it unsettled
    // so nothing pins an act to a possibly-stale image.
    const screenshot = await entry.page.screenshotBase64();
    const after = await this.snapshot(entry.page);
    return {
      ...this.observation(tabId, entry, { screenshot }, after),
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

  async health(): Promise<DriverHealth> {
    return this.context.isConnected()
      ? { ok: true }
      : { ok: false, detail: "browser context disconnected" };
  }

  async close(): Promise<void> {
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
  private observation(
    tabId: string,
    entry: TabEntry,
    output: Record<string, unknown>,
    frame: FrameSnapshot,
  ): BrowserCommandResult {
    return {
      ok: true,
      output: this.withHandoffNote(output),
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
      ? { ...output, handoffNote: RESUMED_AFTER_HANDOFF_NOTE }
      : output;
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

  private async getOrCreateTab(tabId: string): Promise<TabEntry> {
    const existing = this.tabs.get(tabId);
    if (existing && !existing.page.isClosed()) return existing;
    const page = await this.context.newPage();
    const entry: TabEntry = { page, navCounter: 0 };
    this.tabs.set(tabId, entry);
    return entry;
  }
}
