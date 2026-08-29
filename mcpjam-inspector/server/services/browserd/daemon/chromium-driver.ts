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
import type { DriverContext, DriverPage } from "./browser-page";
import { computeStateToken } from "./state-token";
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

export interface ChromiumDriverOptions {
  settle?: SettleOptions;
}

export class ChromiumDriver implements BrowserDriver {
  private readonly context: DriverContext;
  private readonly settleOptions: SettleOptions;
  private readonly tabs = new Map<string, TabEntry>();

  constructor(context: DriverContext, options: ChromiumDriverOptions = {}) {
    this.context = context;
    this.settleOptions = options.settle ?? DEFAULT_SETTLE_OPTIONS;
  }

  async execute(command: BrowserCommand): Promise<BrowserCommandResult> {
    const tabId = command.tabId ?? DEFAULT_TAB;
    const action = command.action;
    switch (action.kind) {
      case "navigate":
        // `navigate` is the only verb that may CREATE a tab. `newTab` (open a
        // distinct tab) is multi-tab territory deferred to W3; reject it rather
        // than silently replacing the current tab's page (P2).
        if (action.newTab) {
          return { ok: false, error: "unimplemented_in_w1: navigate/newTab" };
        }
        return this.navigateVerb(tabId, await this.getOrCreateTab(tabId), (page) =>
          page.goto(action.url),
        );
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
      case "webmcp_invoke":
      case "webmcp_cancel":
        return { ok: false, error: `unimplemented_in_w1: ${action.kind}` };
    }
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
    const domSignal = await entry.page.domStructureSignal();
    return {
      ...this.observation(tabId, entry, { url: entry.page.url() }, domSignal),
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
        const domSignal = await entry.page.domStructureSignal();
        return this.observation(tabId, entry, { url: entry.page.url() }, domSignal);
      }
      case "dom": {
        // The token is computed from the SAME read returned as output, so they
        // cannot disagree.
        const domSignal = await entry.page.domStructureSignal();
        return this.observation(tabId, entry, { dom: domSignal }, domSignal);
      }
      case "screenshot":
        return this.observeScreenshot(tabId, entry);
      case "a11y":
      case "console":
      case "webmcp_tools":
        return { ok: false, error: `unimplemented_in_w1: observe/${action.mode}` };
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
      const before = await entry.page.domStructureSignal();
      const screenshot = await entry.page.screenshotBase64();
      const after = await entry.page.domStructureSignal();
      if (before === after) {
        return this.observation(tabId, entry, { screenshot }, after);
      }
    }
    // Would not stabilise within budget: hand back the frame but flag it unsettled
    // so nothing pins an act to a possibly-stale image.
    const screenshot = await entry.page.screenshotBase64();
    const after = await entry.page.domStructureSignal();
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
   * DOM signal the caller captured the output against — passed in, never re-read
   * here, so the token can never describe a different frame than the output (P1).
   */
  private observation(
    tabId: string,
    entry: TabEntry,
    output: Record<string, unknown>,
    domSignal: string,
  ): BrowserCommandResult {
    const stateToken = computeStateToken({
      tabId,
      navCounter: entry.navCounter,
      url: entry.page.url(),
      domSignal,
    });
    return { ok: true, output, stateToken };
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
