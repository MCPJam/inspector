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
import type {
  BrowserAction,
  BrowserCommand,
  BrowserCommandResult,
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

/** The tab a tab-less (whole-session) command operates on. */
const DEFAULT_TAB = "@default";

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
        return this.afterNavigation(tabId, async (page) => page.goto(action.url));
      case "back":
        return this.afterNavigation(tabId, async (page) => page.goBack());
      case "reload":
        return this.afterNavigation(tabId, async (page) => page.reload());
      case "observe":
        return this.observe(tabId, action);
      case "act":
      case "webmcp_invoke":
      case "webmcp_cancel":
        return { ok: false, error: `unimplemented_in_w1: ${action.kind}` };
    }
  }

  /**
   * Run a navigation, bump the tab's nav counter, settle the page (L2), and
   * return the post-settle observation with its state token (L3). Every W1
   * navigating verb funnels through here so settle + token are never skipped.
   */
  private async afterNavigation(
    tabId: string,
    navigate: (page: DriverPage) => Promise<void>,
  ): Promise<BrowserCommandResult> {
    const entry = await this.getOrCreateTab(tabId);
    await navigate(entry.page);
    entry.navCounter += 1;
    const settled = await this.settle(entry.page);
    const result = await this.observation(tabId, entry, {
      url: entry.page.url(),
    });
    return { ...result, settled };
  }

  private async observe(
    tabId: string,
    action: Extract<BrowserAction, { kind: "observe" }>,
  ): Promise<BrowserCommandResult> {
    const entry = this.tabs.get(tabId);
    if (!entry) {
      return { ok: false, error: `unknown_tab: ${tabId}` };
    }
    switch (action.mode) {
      case "url":
        return this.observation(tabId, entry, { url: entry.page.url() });
      case "screenshot":
        return this.observation(tabId, entry, {
          screenshot: await entry.page.screenshotBase64(),
        });
      case "dom":
        return this.observation(tabId, entry, {
          dom: await entry.page.domStructureSignal(),
        });
      case "a11y":
      case "console":
      case "webmcp_tools":
        return { ok: false, error: `unimplemented_in_w1: observe/${action.mode}` };
    }
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

  /** Build an observation result carrying the tab's fresh L3 state token. */
  private async observation(
    tabId: string,
    entry: TabEntry,
    output: Record<string, unknown>,
  ): Promise<BrowserCommandResult> {
    const stateToken = computeStateToken({
      tabId,
      navCounter: entry.navCounter,
      url: entry.page.url(),
      domSignal: await entry.page.domStructureSignal(),
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
