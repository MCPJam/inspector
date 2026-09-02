import type { DriverContext, DriverPage } from "../browser-page";

/**
 * The fake browser the daemon's unit tests drive.
 *
 * Extracted from `chromium-driver.test.ts` because it is no longer one suite's
 * private helper: the in-process client, the local engine's session registry
 * and (later) the Electron page all need a `DriverContext` that answers without
 * a browser. Keeping a second copy per suite would mean each one drifting from
 * `DriverPage` separately — and the interface grows with every engine.
 *
 * It is deliberately a RECORDER as well as a stub: `calls` is what lets a test
 * assert that a refused command never reached the page at all, which is the
 * only way to prove a privacy gate rather than merely a filtered result.
 */
/** Every act the fake page recorded, in order, as `verb:detail` strings. */
export type ActLog = string[];

export interface FakePage extends DriverPage {
  setUrl(u: string): void;
  /**
   * Called when an act dispatches, before the driver settles and captures.
   *
   * The hook exists for one case that has no other way in: a person taking the
   * browser DURING a command. Nothing else can open that window — by the time
   * a test could acquire the lease itself, the command has already finished.
   */
  onAct?: () => void;
  setDom(d: string): void;
  pushConsole(entry: { type: string; text: string; at: number }): void;
  readonly calls: {
    goto: string[];
    reload: number;
    goBack: number;
    shots: number;
    acts: ActLog;
    front: number;
    a11yRoots: (string | undefined)[];
  };
}

export function fakePage(init: {
  url?: string;
  dom?: string;
  hangNetwork?: boolean;
  /** Called inside screenshotBase64 — used to simulate a shift mid-capture. */
  onScreenshot?: (page: { setDom: (d: string) => void; setUrl: (u: string) => void }) => void;
  /** Make a targeted act fail, as a missing element would. */
  actError?: Error;
  a11y?: unknown;
  /** Subtrees reachable by `rootSelector`; anything else "matches nothing". */
  a11yBySelector?: Record<string, unknown>;
  console?: Array<{ type: string; text: string; at: number }>;
  webmcp?: DriverPage extends { webmcp(): Promise<infer B | null> } ? B | null : never;
} = {}): FakePage {
  let url = init.url ?? "about:blank";
  const consoleEntries = [...(init.console ?? [])];
  let dom = init.dom ?? "0BODY";
  let closed = false;
  const calls = {
    goto: [] as string[],
    reload: 0,
    goBack: 0,
    shots: 0,
    acts: [] as ActLog,
    front: 0,
    a11yRoots: [] as (string | undefined)[],
  };
  const setDom = (d: string) => { dom = d; };
  const setUrl = (u: string) => { url = u; };
  const act = (entry: string) => {
    calls.acts.push(entry);
    page.onAct?.();
    if (init.actError) throw init.actError;
  };
  const page: FakePage = {
    async goto(u) { calls.goto.push(u); url = u; },
    async reload() { calls.reload++; },
    async goBack() { calls.goBack++; },
    async waitForNetworkIdle(signal) {
      if (!init.hangNetwork) return;
      return new Promise<void>((_r, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    },
    async requestAnimationFrame() {},
    async domStructureSignal() { return dom; },
    async screenshotBase64() {
      calls.shots++;
      init.onScreenshot?.({ setDom, setUrl });
      return "BASE64PNG";
    },
    url: () => url,
    close: async () => { closed = true; },
    isClosed: () => closed,
    bringToFront: async () => { calls.front++; },

    async clickAt(point, options) {
      act(`click:${point.x},${point.y}${options?.button ? `:${options.button}` : ""}`);
    },
    async clickSelector(selector) { act(`click:${selector}`); },
    async hoverAt(point) { act(`hover:${point.x},${point.y}`); },
    async hoverSelector(selector) { act(`hover:${selector}`); },
    async typeText(text) { act(`type:${text}`); },
    async fillSelector(selector, text) { act(`fill:${selector}:${text}`); },
    async press(key) { act(`press:${key}`); },
    async scrollBy({ dx, dy }) { act(`scroll:${dx},${dy}`); },
    async dragTo(from, to) { act(`drag:${from.x},${from.y}->${to.x},${to.y}`); },
    async selectOption(selector, value) { act(`select:${selector}:${value}`); },
    async a11ySnapshot(rootSelector?: string) {
      calls.a11yRoots.push(rootSelector);
      // Mirrors the live adapter: an unmatched root selector resolves null,
      // which is what the driver must turn into `unknown_selector`.
      if (rootSelector !== undefined) {
        return (init.a11yBySelector?.[rootSelector] ?? null) as never;
      }
      return (init.a11y ?? null) as never;
    },
    consoleEntries: () => consoleEntries,
    dropConsoleSince: (since: number) => {
      let keep = consoleEntries.length;
      while (keep > 0 && consoleEntries[keep - 1].at >= since) keep -= 1;
      consoleEntries.length = keep;
    },
    async webmcp() { return (init.webmcp ?? null) as never; },

    setUrl,
    setDom,
    pushConsole: (e: { type: string; text: string; at: number }) =>
      consoleEntries.push(e),
    calls,
  };
  return page;
}

export function fakeContext(init: { pages?: FakePage[]; connected?: boolean } = {}) {
  let i = 0;
  let connected = init.connected ?? true;
  let closed = false;
  const created: FakePage[] = [];
  const context: DriverContext = {
    async newPage() {
      const page = init.pages?.[i++] ?? fakePage();
      created.push(page);
      return page;
    },
    isConnected: () => connected,
    close: async () => { closed = true; },
  };
  return { context, created, setConnected: (v: boolean) => (connected = v), wasClosed: () => closed };
}

function cmd(action: BrowserCommand["action"], tabId?: string): BrowserCommand {
  return { commandId: `c-${Math.random()}`, tabId, source: "chat", action };
}

