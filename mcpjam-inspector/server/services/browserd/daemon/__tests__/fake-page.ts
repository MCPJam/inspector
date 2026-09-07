import type { DriverContext, DriverPage } from "../browser-page";
import type { CdpLike } from "../webmcp-bridge";

/**
 * A CDP session that records what was sent and answers from a table.
 *
 * The fixture has one by default because a page nobody can WATCH is not a
 * useful stand-in any more: the viewport, and everything the pane does through
 * it, is written against `cdp()`. It ANSWERS because the accessibility tree is
 * read over CDP too — a session that returned `{}` for everything could only
 * ever model a page with no tree, which is the one case a11y tests do not care
 * about.
 *
 * A reply may be a value or a function of the params, so a test can model
 * `DOM.resolveNode` failing for one node and succeeding for another — the
 * difference between a stale ref and a live one.
 */
export type CdpReplies = Record<
  string,
  unknown | ((params?: Record<string, unknown>) => unknown)
>;

export function fakeCdpSession(replies: CdpReplies = {}): CdpLike & {
  sent: Array<{ method: string; params?: Record<string, unknown> }>;
  emit(event: string, payload: unknown): void;
  replies: CdpReplies;
} {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const session = {
    sent,
    replies,
    async send(method: string, params?: Record<string, unknown>) {
      sent.push({ method, ...(params ? { params } : {}) });
      const reply = session.replies[method];
      if (typeof reply === "function") {
        return (reply as (p?: Record<string, unknown>) => unknown)(params) as never;
      }
      return (reply ?? {}) as never;
    },
    on(event: string, handler: (payload: unknown) => void) {
      handlers.set(event, handler);
    },
    emit(event: string, payload: unknown) {
      handlers.get(event)?.(payload);
    },
  };
  return session as never;
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

  };
}

export function fakePage(init: {
  url?: string;
  dom?: string;
  hangNetwork?: boolean;
  /** Called inside screenshotBase64 — used to simulate a shift mid-capture. */
  onScreenshot?: (page: { setDom: (d: string) => void; setUrl: (u: string) => void }) => void;
  /**
   * Called when the a11y tree is read over CDP, and inside `webmcp`, before
   * the driver builds its result. Same purpose as `onScreenshot`: they are the
   * only way to open the window in which a person takes the browser WHILE a
   * read is in flight, which is the window every permit re-check exists to
   * close.
   */
  onA11y?: () => void;
  onWebmcp?: () => void;
  /** Make a targeted act fail, as a missing element would. */
  actError?: Error;

  /** What `observe {mode:"text"}` reads off this page. */
  text?: string;
  /**
   * Called inside `pageText`, for the same reason `onA11y` exists: it is the
   * only way to open the window in which a person takes the browser WHILE a
   * read is in flight.
   */
  onText?: () => void;
  /** What this page's CDP session answers (the a11y tree is read over it). */
  cdpReplies?: CdpReplies;
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

  };
  const defaultCdp = fakeCdpSession({
    ...(init.cdpReplies ?? {}),
    // Wrapped so `onA11y` fires at the moment the tree is READ — the window a
    // person taking the browser mid-observation has to be caught in.
    ...(init.cdpReplies?.["Accessibility.getFullAXTree"] !== undefined ||
    init.onA11y
      ? {
          "Accessibility.getFullAXTree": (params?: Record<string, unknown>) => {
            init.onA11y?.();
            const reply = init.cdpReplies?.["Accessibility.getFullAXTree"];
            return typeof reply === "function"
              ? (reply as (p?: Record<string, unknown>) => unknown)(params)
              : (reply ?? {});
          },
        }
      : {}),
  });
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

/**
 * An `Accessibility.getFullAXTree` reply, written as a tree rather than as the
 * flat id-joined list CDP actually returns.
 *
 * The flat form is unreadable in a test — every assertion about nesting would
 * be an assertion about `childIds` bookkeeping — and getting that bookkeeping
 * wrong by hand produces a tree that is subtly not the one the test meant.
 */
export interface AxSpec {
  role: string;
  name?: string;
  /** The backend node id, i.e. what a ref resolves to. Auto-assigned if absent. */
  id?: number;
  ignored?: boolean;
  props?: Record<string, string | number | boolean>;
  children?: AxSpec[];
}

export function axTree(root: AxSpec): { nodes: unknown[] } {
  const nodes: unknown[] = [];
  let nextNodeId = 1;
  let nextBackendId = 1000;
  const walk = (spec: AxSpec): string => {
    const nodeId = String(nextNodeId++);
    const backendDOMNodeId = spec.id ?? nextBackendId++;
    const childIds = (spec.children ?? []).map(walk);
    nodes.push({
      nodeId,
      backendDOMNodeId,
      ...(spec.ignored ? { ignored: true } : {}),
      role: { type: "role", value: spec.role },
      ...(spec.name !== undefined
        ? { name: { type: "computedString", value: spec.name } }
        : {}),
      properties: Object.entries(spec.props ?? {}).map(([name, value]) => ({
        name,
        // CDP types these by what they are; the reader ignores `type` today,
        // and a fixture that mislabels what it claims to model is a trap for
        // whoever writes the code that stops ignoring it.
        value: { type: typeof value, value },
      })),
      childIds,
    });
    return nodeId;
  };
  walk(root);
  // CDP lists the root first; `readAxTree` relies on that.
  const rootNode = nodes.find((n) => (n as { nodeId: string }).nodeId === "1");
  return { nodes: [rootNode, ...nodes.filter((n) => n !== rootNode)] };
}
