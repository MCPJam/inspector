import type { DriverContext, DriverPage } from "../browser-page";
import type { CdpLike } from "../webmcp-bridge";

/**
 * A CDP session that records and never answers anything interesting.
 *
 * The fixture has one by default because a page nobody can WATCH is not a
 * useful stand-in any more: the viewport, and everything the pane does through
 * it, is written against `cdp()`. Tests that care what was sent pass their own.
 */
export function fakeCdpSession(): CdpLike & {
  sent: Array<{ method: string; params?: Record<string, unknown> }>;
  emit(event: string, payload: unknown): void;
} {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    sent,
    async send(method, params) {
      sent.push({ method, ...(params ? { params } : {}) });
      return {};
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      handlers.get(event)?.(payload);
    },
  };
}

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
  /** The CDP session the viewport attaches to. Set `null` to model a page
   *  that cannot be watched at all. */
  cdpSession?: CdpLike | null;
  setDom(d: string): void;
  setText(t: string): void;
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
  /**
   * Called inside `a11ySnapshot` / `webmcp`, before the driver builds its
   * result. Same purpose as `onScreenshot`: they are the only way to open the
   * window in which a person takes the browser WHILE a read is in flight,
   * which is the window every permit re-check exists to close.
   */
  onA11y?: () => void;
  onWebmcp?: () => void;
  /** Make a targeted act fail, as a missing element would. */
  actError?: Error;
  a11y?: unknown;
  /** What `observe {mode:"text"}` reads off this page. */
  text?: string;
  /**
   * Called inside `pageText`, for the same reason `onA11y` exists: it is the
   * only way to open the window in which a person takes the browser WHILE a
   * read is in flight.
   */
  onText?: () => void;
  /** Subtrees reachable by `rootSelector`; anything else "matches nothing". */
  a11yBySelector?: Record<string, unknown>;
  console?: Array<{ type: string; text: string; at: number }>;
  webmcp?: DriverPage extends { webmcp(): Promise<infer B | null> } ? B | null : never;
} = {}): FakePage {
  let url = init.url ?? "about:blank";
  const consoleEntries = [...(init.console ?? [])];
  let dom = init.dom ?? "0BODY";
  let text = init.text ?? "";
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
  const defaultCdp = fakeCdpSession();
  const setDom = (d: string) => { dom = d; };
  const setText = (t: string) => { text = t; };
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
      init.onA11y?.();
      // Mirrors the live adapter: an unmatched root selector resolves null,
      // which is what the driver must turn into `unknown_selector`.
      if (rootSelector !== undefined) {
        return (init.a11yBySelector?.[rootSelector] ?? null) as never;
      }
      return (init.a11y ?? null) as never;
    },
    async pageText() {
      init.onText?.();
      return text;
    },
    consoleEntries: () => consoleEntries,
    dropConsoleSince: (since: number) => {
      let keep = consoleEntries.length;
      while (keep > 0 && consoleEntries[keep - 1].at >= since) keep -= 1;
      consoleEntries.length = keep;
    },
    async webmcp() {
      init.onWebmcp?.();
      return (init.webmcp ?? null) as never;
    },
    async cdp() {
      return page.cdpSession === undefined ? defaultCdp : page.cdpSession;
    },

    setUrl,
    setDom,
    setText,
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
