/**
 * The WebMCP half of the daemon: page-registered tools, discovered and invoked
 * over Chrome's experimental `WebMCP` CDP domain.
 *
 * This is the cooperation layer, not the drive mechanism — `navigate`/`act`/
 * `observe` are how browserd gets work done; `webmcp_*` is the bonus when a
 * page chooses to expose structured tools. Node, cloud and Electron use this
 * shared state machine, which preserves these browser-specific behaviors:
 *
 *   - identity is `${frameId} ${name}`, the browser's own notion;
 *   - navigation fires NO `toolsRemoved` and the main frame KEEPS its id, so
 *     the navigated frame's tools are dropped on `Page.frameNavigated` or the
 *     registry serves tools that no longer exist;
 *   - a cancel is answered `Canceled` whatever the reason, so WHY we cancelled
 *     is remembered locally — otherwise a timeout is reported as a user
 *     cancellation;
 *   - a cancel that the page never answers still settles, so a caller is never
 *     left waiting on a browser that is gone.
 *
 * MORE THAN ONE CDP SESSION. A cross-origin frame is a separate Chromium
 * target: its tools never reach the page's session and it is not even in that
 * session's `Page.getFrameTree` (pinned in `webmcp-cdp.spike.test.ts`). So the
 * bridge listens on a SET of sessions — the page's, plus one per
 * separately-targeted frame — and merges what they report into the single tool
 * map. CDP frame ids are unique across sessions, so merging changes no
 * identity; what each entry additionally remembers is WHICH session registered
 * it, because a session's teardown may arrive after its replacement has
 * already registered tools for the same frame and cleanup keyed on frame id
 * alone would empty a frame that is working.
 *
 * The bridge never learns what a Playwright `Frame` or an Electron
 * `webContents` is: the provider decides when a frame has its own target and
 * hands over a `CdpLike` through {@link WebMcpBridge.addSession}.
 *
 * Written against an injected `CdpLike`, so all of it is unit-testable with a
 * fake CDP session — no Chromium required. Chromium and Electron adapters
 * supply the same contract; WebMCP inspection reuses the daemon's tab owner.
 */

/** The CDP surface this bridge uses; `chromium-launch.ts` supplies the real one. */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
}

/** A tool as the WebMCP domain reports it. */
export interface WebMcpCdpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    consequential?: boolean;
    autosubmit?: boolean;
  };
  frameId: string;
  backendNodeId?: number;
  stackTrace?: { callFrames: unknown[] };
}

/** A tool as the MODEL sees it (frame identity flattened into origin facts). */
export interface WebMcpToolDescriptor {
  /**
   * CDP frame id, carried so a caller can invoke against the EXACT frame it
   * listed rather than re-resolving the name later.
   *
   * Churns across page loads, so it is never identity — the inspector builds
   * `origin::name` on top of this and resolves back to a frame at invoke time.
   * It is reported anyway because a consumer that never sees it cannot tell two
   * same-named tools apart at all, which is how the hosted provider's tool
   * parser ended up dropping every tool it was handed.
   */
  frameId: string;
  name: string;
  /**
   * Always present, empty string when the page gave none.
   *
   * Non-optional because every consumer has to render something here, and an
   * `undefined` that each one defaults differently is three different
   * placeholder strings for one absent value.
   */
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpCdpTool["annotations"];
  origin: string;
  isMainFrame: boolean;
  /**
   * WHICH REGISTRATION this is, minted here on the `toolsAdded` that carried
   * the tool and never reused.
   *
   * The piece of identity nothing the browser reports can supply. A same-origin
   * reload re-registers the page's tools under the SAME name in the SAME frame
   * (the main frame keeps its id across navigation — see this file's header),
   * so name, origin and frame id together still describe two different
   * documents' tools identically. A consumer that bound a model tool to the
   * first one would invoke it against the second and be told nothing was wrong.
   *
   * Monotone per bridge, so it also orders registrations within one document.
   */
  registrationSeq: number;
  /**
   * How the page registered it. Provenance, not permission.
   *
   * Chromium 151 DOES carry annotation values through for imperative
   * registrations — from the `readOnlyHint` / `untrustedContentHint` keys the
   * page API reads, reported under the CDP `Annotation` type's bare names
   * (`webmcp-cdp.spike.test.ts` asserts each field separately). What it does
   * not carry at this pin is `consequential`, and `autosubmit` only ever comes
   * from markup. None of that changes the rule: every one of these values is a
   * claim the inspected PAGE makes about itself, so the approval classifier
   * does not derive a decision from any of them.
   */
  registrationKind: "declarative" | "imperative" | "unknown";
}

export type WebMcpInvokeFailure =
  /** This browser build does not expose the WebMCP page API. */
  | "webmcp_unsupported"
  /** The page stopped offering the tool (navigation, unregister, frame gone). */
  | "webmcp_tool_gone"
  /** We asked the page to stop, or it never answered in time. */
  | "webmcp_cancelled"
  /** The call reached the page; cancellation cannot establish its effects. */
  | "webmcp_outcome_unknown"
  /** The page's own handler threw. */
  | "webmcp_error";

export class WebMcpBridgeError extends Error {
  constructor(
    readonly failure: WebMcpInvokeFailure,
    message: string,
    /** Present on a cancel: WHY, since the browser's answer never says. */
    readonly cancelReason?: "cancelled" | "timeout",
  ) {
    super(message);
    this.name = "WebMcpBridgeError";
  }
}

interface PendingInvocation {
  resolve: (value: { output: unknown }) => void;
  reject: (error: Error) => void;
  cancelReason?: "cancelled" | "timeout";
  /**
   * The session this invocation was ISSUED on, captured at invoke time.
   *
   * Not re-resolved from the frame later: a cross-origin frame can be replaced
   * underneath a running invocation (its target swaps, or it navigates and a
   * new session attaches), and a cancel routed through whatever session
   * currently owns the frame would be sent to a renderer that never started
   * this invocation.
   */
  cdp: CdpLike;
  /** The invocation deadline. */
  timer?: ReturnType<typeof setTimeout>;
  /**
   * The grace timer that settles a cancel the page never answers. Kept in its
   * OWN field: reusing `timer` would overwrite the invocation deadline's
   * handle on the abort path (where it has not fired yet), leaking a timer
   * that then keeps the event loop alive for its full duration and that
   * neither `settle` nor `dispose` can reach.
   */
  cancelTimer?: ReturnType<typeof setTimeout>;
}

/**
 * One CDP session the bridge listens on: the page's own, plus one per frame
 * that turned out to be a separate target.
 */
interface BridgeSession {
  /** Unique per ATTACHMENT, never per frame — see {@link WebMcpBridge.addSession}. */
  key: string;
  /** The frame this session was attached for, for routing and replacement. */
  frameId: string;
  cdp: CdpLike;
  /**
   * The page's own session. ONLY this one may say what the main frame is or
   * trigger a support re-probe: a child session's `Page.frameNavigated` also
   * arrives with no `parentId` (its target's root frame IS that frame), so
   * `parentId` cannot tell the two apart and a subframe navigation would
   * otherwise redefine the page's main frame and re-probe on every ad iframe.
   */
  isMain: boolean;
}

/**
 * The page's own session, which has no attachment token because nothing
 * attached it. The NUL prefix keeps it outside the `${frameId}#${n}` space
 * `addSession` mints from, so a caller cannot name it by accident.
 */
const MAIN_SESSION_KEY = "\u0000main";

/** The recursive shape `Page.getFrameTree` answers with. */
interface FrameTreeNode {
  frame?: { id: string; url?: string };
  childFrames?: FrameTreeNode[];
}

interface RespondedPayload {
  invocationId?: string;
  status?: "Completed" | "Canceled" | "Error";
  output?: unknown;
  errorText?: string;
  exception?: { description?: string };
}

/**
 * How many responses-for-unknown-invocations to remember. A page tool can
 * finish before `WebMCP.invokeTool`'s own reply reaches us — we only learn the
 * invocationId FROM that reply, so the response would otherwise be dropped and
 * the caller would wait out the full timeout on an already-finished tool.
 * Bounded because the page's own agent and devtools also invoke tools, and
 * those responses are never claimed.
 */
const MAX_EARLY_RESPONSES = 16;

/**
 * How many just-settled invocation ids to remember, so a SECOND response for
 * one is dropped instead of buffered as an early response for an invocation
 * that will never ask for it.
 *
 * A real shape, not a hypothetical: a tool that returns a value and THEN
 * navigates cross-document (`submit_and_return` in the fixtures) is answered
 * twice — once with its own returned value, once with the destination
 * document's JSON-LD after Blink finishes parsing it. The first answer is the
 * invocation's true outcome and already won; without this, the second would sit
 * in `earlyResponses` evicting genuinely-early responses belonging to other
 * invocations.
 */
const MAX_SETTLED_IDS = 32;

export interface LocalDiscoveryBudget {
  rate?: { tokens: number; at: number };
  entries: Map<
    object,
    { registrations: number; bytes: number; frames: number }
  >;
}
export interface WebMcpBridgeOptions {
  /**
   * How long a page has to answer before we cancel it.
   *
   * Only used for an invocation with NO `signal`. A caller that supplies one
   * owns the deadline — see {@link WebMcpBridge.invoke}.
   */
  localSecurity?: boolean;
  localBudget?: LocalDiscoveryBudget;
  onDiscoveryLimit?: () => void;
  invocationTimeoutMs?: number;
  /** Grace for the browser's own `Canceled` after we ask it to stop. */
  cancelSettleGraceMs?: number;
  /**
   * The COMPLETE current tool set, every time anything changes.
   *
   * A push channel rather than a thing to poll. Snapshots, not deltas, for the
   * reason navigation makes unavoidable: Chromium fires no `toolsRemoved` when
   * a page goes away, so a consumer stitching deltas would serve tools from the
   * previous page forever. A snapshot is correct on arrival no matter what its
   * consumer missed, which also makes a dropped notification harmless.
   */
  onChange?: (tools: WebMcpToolDescriptor[]) => void;
  /**
   * A tool ran that this bridge did not start — the page's own agent, or a
   * devtools panel. Worth surfacing: it explains state changes that would
   * otherwise be attributed to nothing.
   */
  onExternalInvocation?: (toolName: string) => void;
}

/** Unsubscribe a listener registered with {@link WebMcpBridge.subscribe}. */
export type WebMcpUnsubscribe = () => void;

const DEFAULT_INVOCATION_TIMEOUT_MS = 60_000;
const DEFAULT_CANCEL_SETTLE_GRACE_MS = 1_000;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "about:blank";
  }
}

/**
 * Tracks a page's WebMCP tools and runs invocations against them. One bridge
 * per driven tab, created lazily on the first `webmcp_*` action.
 */
export class WebMcpBridge {
  private readonly externalSubscribers = new Set<(toolName: string) => void>();
  subscribeExternalInvocation(
    listener: (toolName: string) => void,
  ): () => void {
    this.externalSubscribers.add(listener);
    return () => {
      this.externalSubscribers.delete(listener);
    };
  }
  /**
   * Tools keyed `${frameId} ${name}` — the browser's own notion of identity —
   * each carrying the registration sequence minted when it arrived.
   */
  private readonly tools = new Map<
    string,
    {
      tool: WebMcpCdpTool;
      registrationSeq: number;
      /**
       * WHICH session reported this registration.
       *
       * Load-bearing for teardown ordering: a session's removal can arrive
       * after its replacement has already registered tools for the same frame,
       * and cleanup keyed on frame id alone would delete the live session's
       * tools and leave a working frame looking empty.
       */
      sessionKey: string;
      bytes?: number;
    }
  >();
  /**
   * The next registration sequence to hand out. Bumped ONCE per `toolsAdded`
   * event, so tools registered together share a sequence and a
   * re-registration (reload, unregister/register) always gets a fresh one.
   */
  private nextRegistrationSeq = 1;
  /** frameId → last known URL, for origin labelling. */
  private readonly frames = new Map<string, string>();
  /** Every session this bridge listens on, keyed by its attachment token. */
  private readonly sessions = new Map<string, BridgeSession>();
  /**
   * frameId → the token of the session that owns that frame.
   *
   * The routing table for invocation: `WebMCP.invokeTool` rejects a frame id
   * that belongs to another target ("FrameId does not belong to current
   * target"), so the session is part of addressing a tool, not an optimisation.
   */
  private readonly frameSessions = new Map<string, string>();
  private readonly pending = new Map<string, PendingInvocation>();
  /** Responses that arrived before their invocation was registered. */
  private readonly earlyResponses = new Map<string, RespondedPayload>();
  /** Invocation ids already settled, so a duplicate response is dropped. */
  private readonly settledIds = new Set<string>();
  /** Next attachment number, so no two attachments ever share a key. */
  private nextSessionSeq = 1;
  private mainFrameId = "";
  /** `WebMCP.invokeTool` calls whose reply has not come back yet. See `wire`. */
  private outstandingSends = 0;
  private readonly invocationTimeoutMs: number;
  private readonly cancelSettleGraceMs: number;
  private supported = false;
  /**
   * The domain half of `supported`, remembered so a RE-probe can recombine
   * without re-enabling anything: `WebMCP.enable` is per session, not per
   * document, so a navigation cannot take the domain away — only the page's
   * `document.modelContext` can change.
   */
  private domainEnabled = false;
  /**
   * The page-side probe, kept so main-frame navigation can re-run it.
   *
   * WHY THE CACHED PROBE WAS A BUG. `start()` set `supported` once and nothing
   * ever revisited it, so a tab that opened on a page without WebMCP reported
   * "this browser has no WebMCP" for the rest of its life — including after
   * navigating to a page whose whole point is the tools it registers. The
   * probe is a page question and has to be re-asked of each page.
   */
  private probe: (() => Promise<boolean>) | undefined;
  /**
   * The in-flight re-probe, so a reader arriving between a navigation and its
   * answer can wait for the truth instead of reading the previous page's.
   */
  private probing: Promise<void> | null = null;
  /**
   * Which re-probe is current. A slow probe for the page we LEFT must not
   * overwrite the answer for the page we are on, and navigations can outrun a
   * `Runtime.evaluate`.
   */
  private probeGeneration = 0;
  private readonly subscribers = new Set<
    (tools: WebMcpToolDescriptor[]) => void
  >();
  private disposed = false;
  private localSecurity = false;
  private localBudget?: LocalDiscoveryBudget;
  private updateBudget(): void {
    if (!this.localBudget) return;
    if (this.disposed) {
      this.localBudget.entries.delete(this);
      return;
    }
    let bytes = 0;
    for (const entry of this.tools.values()) bytes += entry.bytes ?? 0;
    this.localBudget.entries.set(this, {
      registrations: this.tools.size,
      bytes,
      frames: Math.max(
        this.frames.size,
        this.sessions.size,
        this.frameSessions.size,
      ),
    });
  }
  private otherBudget(): {
    registrations: number;
    bytes: number;
    frames: number;
  } {
    const total = { registrations: 0, bytes: 0, frames: 0 };
    for (const [owner, entry] of this.localBudget?.entries ?? [])
      if (owner !== this) {
        total.registrations += entry.registrations;
        total.bytes += entry.bytes;
        total.frames += entry.frames;
      }
    return total;
  }
  private discoveryBlocked = false;
  private onDiscoveryLimit?: () => void;
  private changeTokens = 2048;
  private changeAt = Date.now();
  discoveryLimitReached(): boolean {
    return this.discoveryBlocked;
  }
  private blockDiscovery(): false {
    if (!this.discoveryBlocked) {
      this.discoveryBlocked = true;
      this.tools.clear();
      for (const [id, waiter] of this.pending) {
        void waiter.cdp
          .send("WebMCP.cancelInvocation", { invocationId: id })
          .catch(() => {});
        this.settle(id);
        waiter.reject(
          new WebMcpBridgeError(
            "webmcp_tool_gone",
            "Page tool discovery exceeded its security budget. Reload the page after reducing its registrations.",
          ),
        );
      }
      this.onDiscoveryLimit?.();
      this.announce();
    }
    return false;
  }
  private allowChanges(count: number): boolean {
    if (!this.localSecurity) return true;
    if (this.discoveryBlocked) return false;
    const now = Date.now();
    const rate = this.localBudget
      ? (this.localBudget.rate ??= { tokens: 2048, at: now })
      : { tokens: this.changeTokens, at: this.changeAt };
    rate.tokens = Math.min(
      2048,
      rate.tokens + Math.max(0, now - rate.at) * 1.024,
    );
    rate.at = now;
    if (count > rate.tokens) return this.blockDiscovery();
    rate.tokens -= count;
    this.changeTokens = rate.tokens;
    this.changeAt = now;
    return true;
  }
  private allowTool(tool: WebMcpCdpTool): boolean {
    if (!this.localSecurity) return true;
    // Bound traversal before stringify/retention. CDP supplies JSON, but never
    // trust the page's size or nesting to be inexpensive to process.
    let bytes = 0,
      nodes = 0;
    const stack: Array<[unknown, number]> = [[tool, 0]];
    while (stack.length) {
      const [value, depth] = stack.pop()!;
      if (++nodes > 65536 || depth > 32) return this.blockDiscovery();
      if (typeof value === "string") {
        if (value.length > 65536) return this.blockDiscovery();
        bytes += new TextEncoder().encode(value).byteLength;
      } else if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
          bytes += key.length * 3;
          if (stack.length >= 65536) return this.blockDiscovery();
          stack.push([(value as Record<string, unknown>)[key], depth + 1]);
        }
      } else bytes += 8;
      if (bytes > 65536) return this.blockDiscovery();
    }
    const others = this.otherBudget();
    if (
      this.tools.size + others.registrations >= 1024 &&
      !this.tools.has(this.key(tool.frameId, tool.name))
    )
      return this.blockDiscovery();
    let retained = bytes;
    for (const entry of this.tools.values()) retained += entry.bytes ?? 0;
    if (retained + others.bytes > 8 * 1024 * 1024) return this.blockDiscovery();
    if (
      !this.frameSessions.has(tool.frameId) &&
      this.frameSessions.size + others.frames >= 64
    )
      return this.blockDiscovery();
    this.nextToolBytes = bytes;
    return true;
  }
  private nextToolBytes = 0;

  private readonly onChange:
    | ((tools: WebMcpToolDescriptor[]) => void)
    | undefined;
  private readonly onExternalInvocation:
    | ((toolName: string) => void)
    | undefined;

  constructor(
    private readonly cdp: CdpLike,
    options: WebMcpBridgeOptions = {},
  ) {
    this.localSecurity = options.localSecurity ?? false;
    this.localBudget = options.localBudget;
    this.onDiscoveryLimit = options.onDiscoveryLimit;
    this.sessions.set(MAIN_SESSION_KEY, {
      key: MAIN_SESSION_KEY,
      frameId: "",
      cdp,
      isMain: true,
    });
    this.invocationTimeoutMs =
      options.invocationTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS;
    this.cancelSettleGraceMs =
      options.cancelSettleGraceMs ?? DEFAULT_CANCEL_SETTLE_GRACE_MS;
    this.onChange = options.onChange;
    this.onExternalInvocation = options.onExternalInvocation;
  }

  /**
   * Announce the current tool set.
   *
   * Every mutation path funnels through here so no path can forget. A throwing
   * subscriber is swallowed: it is the consumer's own reaction to a browser
   * event, and letting it escape would take down the CDP handler that is also
   * responsible for the bridge's own bookkeeping.
   */
  private announce(): void {
    this.updateBudget();
    // Nothing is published after dispose. `subscribers` is cleared there, but
    // `onChange` is the CONSTRUCTOR's callback and is not — so without this a
    // late event would still reach the provider, on a session it has closed.
    if (this.disposed) return;
    if (!this.onChange && this.subscribers.size === 0) return;
    const tools = this.list();
    for (const listener of [this.onChange, ...this.subscribers]) {
      if (!listener) continue;
      try {
        listener(tools);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Watch the tool set, alongside the constructor's `onChange`.
   *
   * A second channel because the two consumers arrive at different times: the
   * bridge is constructed by the page adapter (which knows how to probe the
   * page) while the DRIVER — the one that has to keep a per-tab revision — only
   * meets the bridge once it has resolved one. Handing the adapter the driver's
   * callback would make the adapter know about tab bookkeeping; this way each
   * side subscribes to what it needs.
   *
   * The listener is called with the CURRENT set immediately, so a subscriber
   * that attached after the page had already registered its tools does not
   * have to wait for the next change to learn about them — the exact gap that
   * makes an eagerly-attached bridge worth having.
   */
  subscribe(
    listener: (tools: WebMcpToolDescriptor[]) => void,
  ): WebMcpUnsubscribe {
    this.subscribers.add(listener);
    try {
      listener(this.list());
    } catch {
      /* ignore */
    }
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /**
   * Enable the domains and wire the events. `probeSupported` is the page-side
   * check for `document.modelContext`: `WebMCP.enable` RESOLVES even on a
   * browser with the feature off (it just never reports a tool), so the domain
   * is never the probe.
   */
  async start(probeSupported: () => Promise<boolean>): Promise<void> {
    this.wireSession(this.mainSession());
    await this.cdp.send("Page.enable").catch(() => {});
    // BOTH halves have to hold. The page probe alone would accept a browser
    // that exposes `document.modelContext` while the CDP domain is unavailable
    // — a session that can never be told about a tool, reported as healthy and
    // showing an empty registry that looks like the page's fault.
    let domainEnabled = true;
    await this.cdp.send("WebMCP.enable").catch(() => {
      domainEnabled = false;
    });
    this.domainEnabled = domainEnabled;
    // Run the probe REGARDLESS of the domain, then combine. `&&` would
    // short-circuit past it, and the callback is the caller's only hook for
    // work that has to happen inside `start` — the inspector navigates the
    // page there, between the domains being enabled and the page being asked
    // about itself. Skipping it leaves the page on `about:blank`, which an
    // embedded session then streams, under an error that says the page loaded
    // normally.
    const probed = await probeSupported().catch(() => false);
    this.supported = domainEnabled && probed;
  }

  isSupported(): boolean {
    return this.supported;
  }

  /**
   * Re-ask this probe of every page the main frame goes to.
   *
   * Separate from `start()`'s argument because support is a property of the
   * PAGE, not of the session: `start()` answers it for the document that
   * happened to be open, and a bridge that stopped there tells a caller "this
   * browser has no WebMCP" about a page that registered five tools a moment
   * ago. Opt-in so a consumer that cannot cheaply re-probe (a test fake) is
   * unchanged.
   */
  resupport(probe: () => Promise<boolean>): void {
    this.probe = probe;
  }

  /**
   * Resolve once no re-probe is outstanding.
   *
   * `Page.frameNavigated` is a synchronous event and the probe is a round trip
   * into the page, so there is a window in which `isSupported()` still answers
   * for the page we LEFT. A reader that has just navigated (the driver, about
   * to list tools) waits here rather than reporting the previous page's answer
   * as this page's.
   */
  async probeSettled(): Promise<void> {
    await this.probing;
  }

  /** Re-run the page probe for the document the main frame just committed. */
  private reprobe(): void {
    const probe = this.probe;
    if (!probe || this.disposed) return;
    const generation = ++this.probeGeneration;
    this.probing = (async () => {
      const probed = await probe().catch(() => false);
      // A slow probe for the page we left must never overwrite the answer for
      // the page we are on: navigations outrun a `Runtime.evaluate` routinely
      // (a redirect chain fires several).
      if (generation !== this.probeGeneration || this.disposed) return;
      const next = this.domainEnabled && probed;
      if (next === this.supported) return;
      this.supported = next;
      // Support IS part of what a consumer renders ("this page offers no
      // tools" vs "this browser cannot"), so a flip is a change like any
      // other — and on the false→true edge the tools are usually already here.
      this.announce();
    })().finally(() => {
      if (generation === this.probeGeneration) this.probing = null;
    });
  }

  private mainSession(): BridgeSession {
    // Always present: the constructor registers it and nothing removes it.
    return this.sessions.get(MAIN_SESSION_KEY)!;
  }

  /**
   * Whether events from this session still count.
   *
   * `CdpLike` has deliberately no `off`, so nothing can UNSUBSCRIBE a session's
   * handlers — `removeSession` and `dispose` drop the bridge's bookkeeping and
   * leave the wiring in place. Without this check a `toolsAdded` arriving after
   * either one would find the frame unowned, claim it, re-populate the map the
   * teardown just cleared, and publish it: tools resurrected for a session the
   * provider has already closed.
   *
   * Identity, not just presence: a replacement attachment for the same frame is
   * a DIFFERENT session object under a different key, so a stale one must not
   * pass by having a live namesake.
   */
  private live(session: BridgeSession): boolean {
    if (this.disposed) return false;
    return this.sessions.get(session.key) === session;
  }

  /**
   * Subscribe one session's events. Every handler closes over the session it
   * belongs to, because almost every one of them has to answer "whose?" —
   * which frames this session owns, whose tools a removal may delete, and
   * whether a navigation is the PAGE's or a subframe target's.
   */
  private wireSession(session: BridgeSession): void {
    session.cdp.on("WebMCP.toolsAdded", (payload) => {
      if (!this.live(session)) return;
      const { tools } = (payload ?? {}) as { tools?: WebMcpCdpTool[] };
      // ONE sequence for the whole event, minted before the loop: tools a page
      // registers together belong to one registration, and a per-tool counter
      // would make the identity of a tool depend on how many siblings the page
      // happened to declare beside it.
      if (!Array.isArray(tools) || !this.allowChanges(tools.length)) return;
      const registrationSeq = this.nextRegistrationSeq++;
      for (const tool of tools ?? []) {
        if (!this.allowTool(tool)) return;
        // A session speaks for a frame only while it OWNS that frame. A
        // retiring session can still emit for a frame its replacement has
        // taken over, and honouring that would both re-route invocations to a
        // dying renderer and re-stamp the live registration with the dead
        // session's key — the exact ordering the token scheme exists to
        // survive. An unowned frame is claimed here, which is how the page's
        // own session picks up its same-process subframes.
        const owner = this.frameSessions.get(tool.frameId);
        if (owner !== undefined && owner !== session.key) continue;
        this.tools.set(this.key(tool.frameId, tool.name), {
          tool,
          registrationSeq,
          sessionKey: session.key,
          bytes: this.nextToolBytes,
        });
        this.frameSessions.set(tool.frameId, session.key);
        this.updateBudget();
      }
      this.announce();
    });

    session.cdp.on("WebMCP.toolsRemoved", (payload) => {
      if (!this.live(session)) return;
      const { tools } = (payload ?? {}) as {
        tools?: Array<{ name: string; frameId: string }>;
      };
      if (!Array.isArray(tools) || !this.allowChanges(tools.length)) return;
      for (const tool of tools ?? []) {
        // SCOPED. A stale session can still be delivering events after a
        // replacement has taken over the same frame; its removals describe the
        // document IT saw, not the one now registered under that key.
        const key = this.key(tool.frameId, tool.name);
        if (this.tools.get(key)?.sessionKey !== session.key) continue;
        this.tools.delete(key);
      }
      this.announce();
    });

    session.cdp.on("WebMCP.toolInvoked", (payload) => {
      const invoked = (payload ?? {}) as {
        invocationId?: string;
        toolName?: string;
      };
      if (!invoked.invocationId) return;
      if (this.pending.has(invoked.invocationId)) return;
      // An id we do not know is USUALLY someone else's — the page's own agent,
      // or a devtools panel. But we only learn our OWN id from `invokeTool`'s
      // reply, and this event can be dispatched before that reply's
      // continuation runs, so an id is genuinely ambiguous while a send of ours
      // is outstanding. Stay quiet then: a false "someone else drove your page"
      // actively misleads whoever reads the timeline, while a missed note is a
      // gap in an advisory one.
      if (this.outstandingSends > 0) return;
      this.onExternalInvocation?.(invoked.toolName ?? "");
      for (const listener of this.externalSubscribers)
        listener(invoked.toolName ?? "");
    });

    // NOT guarded by `live`. A response settles a PENDING INVOCATION, and a
    // caller waiting on one is owed its answer even if the session it was
    // issued on has since been removed — refusing it here would strand that
    // caller until its deadline. `dispose` rejects the waiters itself, and an
    // id nobody is waiting for goes no further than the bounded early-response
    // buffer.
    session.cdp.on("WebMCP.toolResponded", (payload) => {
      const responded = (payload ?? {}) as RespondedPayload;
      const id = responded.invocationId;
      if (!id) return;
      const waiter = this.pending.get(id);
      if (!waiter) {
        // A SECOND answer to an invocation we already settled. The platform
        // sends one when a tool returns a value and then navigates
        // cross-document: Blink answers again with the destination document's
        // JSON-LD once it has finished parsing. The first answer was the
        // invocation's true outcome and already won, so this one is dropped
        // rather than buffered — buffering it would evict genuinely-early
        // responses belonging to OTHER invocations.
        if (this.settledIds.has(id)) return;
        // Either a tool someone ELSE invoked (the page's own agent, devtools)
        // or ours finishing before `invokeTool`'s reply told us its id. Both
        // land here; `invoke` claims the latter once it knows the id.
        if (this.earlyResponses.size >= MAX_EARLY_RESPONSES) {
          const oldest = this.earlyResponses.keys().next().value;
          if (oldest !== undefined) this.earlyResponses.delete(oldest);
        }
        this.earlyResponses.set(id, responded);
        return;
      }
      this.settle(id);
      this.deliver(waiter, responded);
    });

    session.cdp.on("Page.frameNavigated", (payload) => {
      if (!this.live(session)) return;
      const { frame } = (payload ?? {}) as {
        frame?: { id: string; url: string; parentId?: string };
      };
      if (!frame) return;
      if (this.localSecurity && session.isMain && !frame.parentId) {
        this.discoveryBlocked = false;
        this.changeTokens = 2048;
        this.changeAt = Date.now();
        this.tools.clear();
        this.frames.clear();
        this.frameSessions.clear();
      }
      if (
        this.localSecurity &&
        !this.frames.has(frame.id) &&
        this.frames.size + this.otherBudget().frames >= 64
      ) {
        this.blockDiscovery();
        return;
      }
      this.frames.set(frame.id, frame.url);
      // Navigation fires NO toolsRemoved and the main frame KEEPS its id, so
      // nothing the browser says separates "tools of the page we left" from
      // "tools of the page we are on". Dropping them here is what stops the
      // registry serving tools that no longer exist.
      //
      // Scoped to this session for the same reason removals are: a stale
      // session still reporting the frame it used to own must not clear the
      // registration its replacement just published.
      this.dropFrame(frame.id, session.key);
      // A child session's root frame ALSO arrives with no `parentId`, so the
      // page's own session — not the payload — is what says "main frame".
      if (session.isMain && !frame.parentId) {
        this.mainFrameId = frame.id;
        // A NEW DOCUMENT is a new answer to "does this page speak WebMCP?".
        // Only the main frame: a subframe navigating says nothing about the
        // top-level page's `document.modelContext`, and re-probing on every
        // ad iframe would be a round trip per frame per page.
        this.reprobe();
      }
      this.announce();
    });

    session.cdp.on("Page.frameDetached", (payload) => {
      if (!this.live(session)) return;
      const { frameId, reason } = (payload ?? {}) as {
        frameId?: string;
        reason?: string;
      };
      if (!frameId) return;
      // `swap` is a TARGET MOVING, not a frame going away: it is what the
      // page's session reports the moment a frame becomes cross-origin and
      // Chromium hands it to its own renderer. The frame is still on the page
      // and another session is about to speak for it, so only what THIS
      // session registered goes — anything else would delete the tools of the
      // frame that just started working.
      if (reason === "swap") {
        this.dropFrame(frameId, session.key);
        if (this.frameSessions.get(frameId) === session.key) {
          this.frameSessions.delete(frameId);
        }
        this.announce();
        return;
      }
      // `remove` (and any build that names no reason) is the frame itself
      // going away, so every session's tools for it go with it — including a
      // child session's, which the page's session is the only one to hear
      // about.
      this.frames.delete(frameId);
      this.frameSessions.delete(frameId);
      this.dropFrame(frameId);
      this.announce();
    });
  }

  /**
   * Listen on one more CDP session — a frame that turned out to be its own
   * Chromium target — and answer with the TOKEN that names this attachment.
   *
   * The token is per attachment, not per frame, and that is the whole point.
   * A frame keeps its id across a cross-origin navigation (measured: an OOPIF
   * navigated cross-origin reports the same CDP frame id), so a frame id names
   * the FRAME, never one particular session on it. Teardown quotes the token,
   * so a removal that arrives after the frame has already been re-attached
   * names an attachment that is gone and does nothing — instead of emptying a
   * frame that is working.
   *
   * Attaching again for the same frame RETIRES the previous attachment first,
   * so a replaced frame is never listened to twice.
   *
   * The domains are enabled here rather than by the caller so a provider only
   * has to know how to open a session, and the frame tree is read back so a
   * frame that finished navigating BEFORE we attached still has an origin —
   * `Page.frameNavigated` has already been and gone for it.
   */
  async addSession(frameId: string, cdp: CdpLike): Promise<string> {
    const key = `${frameId}#${this.nextSessionSeq++}`;
    if (this.disposed) return key;
    if (
      this.localSecurity &&
      (this.discoveryBlocked ||
        this.sessions.size + this.otherBudget().frames >= 64)
    ) {
      this.blockDiscovery();
      return key;
    }
    for (const existing of [...this.sessions.values()]) {
      if (!existing.isMain && existing.frameId === frameId) {
        this.removeSession(existing.key);
      }
    }
    const session: BridgeSession = { key, frameId, cdp, isMain: false };
    this.sessions.set(key, session);
    this.updateBudget();
    this.frameSessions.set(frameId, key);
    this.wireSession(session);
    await cdp.send("Page.enable").catch(() => {});
    await cdp.send("WebMCP.enable").catch(() => {});
    await this.seedFrames(cdp).catch(() => {});
    // Three round trips have passed. A `dispose`, or a replacement attachment
    // for this frame, may have retired this session in that window — and
    // publishing here would announce a session nobody is listening on. The
    // handlers are already inert (`live`); this stops the announcement too.
    if (!this.live(session)) return key;
    this.announce();
    return key;
  }

  /**
   * Stop listening on one attachment and drop what IT registered.
   *
   * Takes the token {@link addSession} answered with, never a frame id: a
   * removal can arrive after the frame has been re-attached, and anything
   * scoped to the frame would delete the live session's tools.
   */
  removeSession(sessionKey: string): void {
    if (sessionKey === MAIN_SESSION_KEY) return;
    if (!this.sessions.delete(sessionKey)) return;
    for (const [toolKey, entry] of [...this.tools]) {
      if (entry.sessionKey === sessionKey) this.tools.delete(toolKey);
    }
    for (const [frameId, owner] of [...this.frameSessions]) {
      if (owner === sessionKey) this.frameSessions.delete(frameId);
    }
    this.announce();
  }

  /** Frame ids with their own attached session. Exists for tests and logging. */
  attachedFrameIds(): string[] {
    return [...this.sessions.values()]
      .filter((session) => !session.isMain)
      .map((session) => session.frameId);
  }

  /**
   * The attached child-frame sessions (never the main one), for the a11y
   * reader, which needs them to see iframe content. Never triggers an attach.
   */
  attachedFrameSessions(): ReadonlyArray<{ frameId: string; cdp: CdpLike }> {
    return [...this.sessions.values()]
      .filter((session) => !session.isMain)
      .map((session) => ({ frameId: session.frameId, cdp: session.cdp }));
  }

  /** Record a session's frame URLs, for origins we missed by attaching late. */
  private async seedFrames(cdp: CdpLike): Promise<void> {
    const tree = (await cdp.send("Page.getFrameTree")) as {
      frameTree?: FrameTreeNode;
    };
    let visited = 0;
    const walk = (node: FrameTreeNode | undefined): void => {
      if (this.localSecurity && (++visited > 64 || this.discoveryBlocked)) {
        this.blockDiscovery();
        return;
      }
      if (!node?.frame) return;
      // Never overwrite: a `Page.frameNavigated` that already arrived on this
      // session describes a LATER document than the tree we are catching up on.
      if (!this.frames.has(node.frame.id)) {
        this.frames.set(node.frame.id, node.frame.url ?? "");
      }
      for (const child of node.childFrames ?? []) {
        if (this.localSecurity && this.discoveryBlocked) break;
        walk(child);
      }
    };
    walk(tree?.frameTree);
  }

  /**
   * The session that can run a tool in this frame.
   *
   * No fallback to the page's session. `WebMCP.invokeTool` rejects a frame id
   * belonging to another target ("FrameId does not belong to current target"),
   * so a plausible-looking default is not a degraded call — it is a call to the
   * wrong renderer, which for a same-named tool would run something the caller
   * never named.
   */
  private sessionForFrame(frameId: string, toolName: string): CdpLike {
    const key = this.frameSessions.get(frameId);
    const session = key ? this.sessions.get(key) : undefined;
    if (!session) {
      throw new WebMcpBridgeError(
        "webmcp_tool_gone",
        `The frame that offered "${toolName}" is no longer attached to this session.`,
      );
    }
    return session.cdp;
  }

  private key(frameId: string, name: string): string {
    return `${frameId} ${name}`;
  }

  /**
   * Forget a frame's tools. With `sessionKey`, only the ones THAT session
   * registered — the ordering-safe form, for anything a single session says
   * about a frame it may no longer own.
   */
  private dropFrame(frameId: string, sessionKey?: string): void {
    for (const [key, entry] of [...this.tools]) {
      if (!key.startsWith(`${frameId} `)) continue;
      if (sessionKey !== undefined && entry.sessionKey !== sessionKey) continue;
      this.tools.delete(key);
    }
  }

  /**
   * The ONE terminal transition for an invocation: clear its timers, stop
   * tracking it, and remember that it is done so a later duplicate response
   * cannot be mistaken for an early one.
   */
  private settle(invocationId: string): void {
    const waiter = this.pending.get(invocationId);
    if (waiter?.timer) clearTimeout(waiter.timer);
    if (waiter?.cancelTimer) clearTimeout(waiter.cancelTimer);
    this.pending.delete(invocationId);
    if (this.settledIds.size >= MAX_SETTLED_IDS) {
      const oldest = this.settledIds.values().next().value;
      if (oldest !== undefined) this.settledIds.delete(oldest);
    }
    this.settledIds.add(invocationId);
  }

  /** Resolve or reject a waiter from the page's response. */
  private deliver(
    waiter: PendingInvocation,
    responded: RespondedPayload,
  ): void {
    if (responded.status === "Completed") {
      waiter.resolve({ output: responded.output });
      return;
    }
    if (responded.status === "Canceled") {
      const reason = waiter.cancelReason ?? "cancelled";
      waiter.reject(
        new WebMcpBridgeError(
          "webmcp_outcome_unknown",
          reason === "timeout"
            ? "Stopped waiting for the page tool after a timeout. Execution may continue; verify the page state before retrying."
            : "Cancellation requested. Page execution may continue; verify the page state before retrying.",
          reason,
        ),
      );
      return;
    }
    // On Error, `errorText` is empty in practice and the usable message is
    // the exception's description.
    waiter.reject(
      new WebMcpBridgeError(
        "webmcp_error",
        responded.exception?.description?.split("\n")[0] ||
          responded.errorText ||
          "The page tool failed without a message.",
      ),
    );
  }

  /** The tools currently on offer, as the model should see them. */
  list(): WebMcpToolDescriptor[] {
    return [...this.tools.values()].map(({ tool, registrationSeq }) => ({
      frameId: tool.frameId,
      name: tool.name,
      description: tool.description ?? "",
      ...(tool.inputSchema !== undefined
        ? { inputSchema: tool.inputSchema }
        : {}),
      ...(tool.annotations !== undefined
        ? { annotations: tool.annotations }
        : {}),
      origin: originOf(this.frames.get(tool.frameId) ?? ""),
      isMainFrame: tool.frameId === this.mainFrameId,
      registrationSeq,
      registrationKind:
        tool.backendNodeId !== undefined
          ? ("declarative" as const)
          : tool.stackTrace
          ? ("imperative" as const)
          : ("unknown" as const),
    }));
  }

  /**
   * Resolve a tool NAME to the frame currently offering it, preferring the
   * main frame. Frame ids churn across navigations, so this happens at invoke
   * time rather than being carried around as identity.
   */
  private resolveFrame(toolName: string): string {
    for (const { tool } of this.tools.values()) {
      if (tool.name === toolName && tool.frameId === this.mainFrameId) {
        return tool.frameId;
      }
    }
    for (const { tool } of this.tools.values()) {
      if (tool.name === toolName) return tool.frameId;
    }
    throw new WebMcpBridgeError(
      "webmcp_tool_gone",
      `The page no longer offers a tool named "${toolName}".`,
    );
  }

  /**
   * Pick the frame to invoke in: the caller's, when it still offers the tool.
   *
   * A frame id the caller listed a moment ago can be gone (the page navigated,
   * the subframe detached), so an id that no longer matches falls back to
   * resolution rather than being sent to the browser to fail obscurely.
   */
  private frameFor(
    frameId: string | undefined,
    toolName: string,
    strict = false,
  ): string {
    if (frameId && this.tools.has(this.key(frameId, toolName))) return frameId;
    // STRICT callers named a frame as part of an identity they already
    // validated, so falling back would invoke a DIFFERENT tool than the one
    // approved — a same-named main-frame tool standing in for the subframe's.
    // Silent substitution is exactly the failure the caller's binding exists
    // to prevent, so an unmatched frame is `webmcp_tool_gone` instead.
    if (strict) {
      throw new WebMcpBridgeError(
        "webmcp_tool_gone",
        `The frame that offered "${toolName}" no longer offers it.`,
      );
    }
    return this.resolveFrame(toolName);
  }

  /** The registration sequence for one (frame, name), or undefined if gone. */
  registrationSeqFor(frameId: string, toolName: string): number | undefined {
    return this.tools.get(this.key(frameId, toolName))?.registrationSeq;
  }

  /**
   * Invoke a page tool and wait for the page's own response.
   *
   * TIMEOUT OWNERSHIP. With no `signal`, this bridge owns the deadline and
   * cancels the page after `invocationTimeoutMs`. With a `signal`, the CALLER
   * owns it and the internal deadline is not armed at all — two deadlines on
   * one invocation means whichever fires first decides what the failure is
   * called, and the caller's is the one whose reason the user will read. The
   * reason is taken from `signal.reason` for the same purpose: a caller that
   * aborts with `"timeout"` gets a timeout, and naive adoption of this bridge
   * would otherwise report every caller-side timeout as a user cancellation.
   */
  async invoke(args: {
    toolName: string;
    input: unknown;
    /**
     * Invoke against THIS frame rather than re-resolving the name.
     *
     * For a caller that listed the tools and is acting on one it saw: name
     * resolution prefers the main frame, so a subframe's tool would otherwise
     * be shadowed by a same-named main-frame one. Falls back to resolution when
     * omitted, and when the frame given no longer offers the tool.
     */
    frameId?: string;
    /**
     * Refuse rather than re-resolve when `frameId` no longer offers the tool.
     *
     * For a caller invoking against an identity it has already validated: a
     * fallback would run a same-named tool in another frame under an approval
     * that named this one.
     */
    strictFrame?: boolean;
    /**
     * The registration this invocation was approved against.
     *
     * Checked at the LAST possible moment — the line before the CDP send —
     * because everything between a caller validating a binding and the browser
     * being told to run something is time in which the page can unregister the
     * tool and register a new one under the same name in the same frame. The
     * driver checks this too, one layer up; that check answers "was this
     * binding valid when we decided", and this one answers "is it still valid
     * now that we are about to act", which is the only question the page cannot
     * invalidate behind our back.
     */
    expectedRegistrationSeq?: number;
    /**
     * The invocation id, the moment the browser hands it back.
     *
     * The whole reason a cancel could not reach the page before: `invoke` is
     * synchronous from the caller's side and only RETURNS the id once the tool
     * has settled, so nothing upstream could name the thing it wanted stopped
     * while it was still running.
     */
    onStarted?: (invocationId: string) => void;
    signal?: AbortSignal;
  }): Promise<{ invocationId: string; output: unknown }> {
    if (this.disposed) {
      throw new WebMcpBridgeError(
        "webmcp_cancelled",
        "The browser tab was closed.",
        "cancelled",
      );
    }
    if (!this.supported) {
      throw new WebMcpBridgeError(
        "webmcp_unsupported",
        "This browser build does not expose the WebMCP page API, so the page's tools cannot be invoked.",
      );
    }
    // BEFORE the CDP round trip, not after. A caller that aborted while this
    // invocation was queued behind another would otherwise have its tool
    // started anyway, and then immediately cancelled — a page mutated by a call
    // the user had already stopped.
    if (args.signal?.aborted) {
      const reason = args.signal.reason === "timeout" ? "timeout" : "cancelled";
      throw new WebMcpBridgeError(
        "webmcp_cancelled",
        reason === "timeout"
          ? "The page tool did not respond in time."
          : "Cancelled before it started.",
        reason,
      );
    }
    const frameId = this.frameFor(
      args.frameId,
      args.toolName,
      args.strictFrame === true,
    );
    // RE-ASKED AT THE SEND BOUNDARY. `frameFor` proves the frame still offers
    // SOMETHING by this name; it cannot prove it is the same registration the
    // caller's approval named, and a page that unregisters and re-registers
    // between the driver's check and this line would otherwise run its
    // replacement under that approval.
    if (args.expectedRegistrationSeq !== undefined) {
      const live = this.registrationSeqFor(frameId, args.toolName);
      if (live !== args.expectedRegistrationSeq) {
        throw new WebMcpBridgeError(
          "webmcp_tool_gone",
          `"${args.toolName}" was re-registered by the page after it was listed.`,
        );
      }
    }

    // RESOLVED HERE, once, and carried on the pending entry. A cross-origin
    // frame's session can be replaced while its tool runs, and a cancel that
    // looked the session up again afterwards would reach a renderer that never
    // started this invocation.
    const owner = this.sessionForFrame(frameId, args.toolName);

    let invocationId: string;
    try {
      // Counted around the await with try/finally rather than a `.finally()`
      // on the promise: chaining would insert an extra microtask between the
      // browser's reply and this invocation being registered as pending, and a
      // dispose or a response landing in that gap would find nothing to settle.
      this.outstandingSends += 1;
      let result: { invocationId?: string };
      try {
        result = (await owner.send("WebMCP.invokeTool", {
          frameId,
          toolName: args.toolName,
          input: args.input,
        })) as { invocationId?: string };
      } finally {
        this.outstandingSends -= 1;
      }
      if (!result?.invocationId) {
        throw new WebMcpBridgeError(
          "webmcp_error",
          "The browser accepted the invocation but returned no invocation id.",
        );
      }
      invocationId = result.invocationId;
      if (this.localSecurity && (this.discoveryBlocked || this.disposed)) {
        void owner
          .send("WebMCP.cancelInvocation", { invocationId })
          .catch(() => {});
        throw new WebMcpBridgeError(
          "webmcp_tool_gone",
          "Page tool discovery is no longer available; earlier effects may already have occurred.",
        );
      }
      // BEFORE the await below, so a cancel arriving while the page's handler
      // is still running has an id to name. A throwing subscriber must not
      // fail the invocation it is only observing.
      try {
        args.onStarted?.(invocationId);
      } catch {
        /* ignore */
      }
    } catch (error) {
      if (error instanceof WebMcpBridgeError) throw error;
      // An unknown tool rejects HERE rather than settling as a response.
      const message = error instanceof Error ? error.message : String(error);
      if (/tool not found/i.test(message)) {
        throw new WebMcpBridgeError(
          "webmcp_tool_gone",
          `The page no longer offers a tool named "${args.toolName}".`,
        );
      }
      throw error;
    }

    const output = await new Promise<{ output: unknown }>((resolve, reject) => {
      const waiter: PendingInvocation = { resolve, reject, cdp: owner };
      // Claim a response that beat `invokeTool`'s own reply here — otherwise
      // an instant tool would be waited out to the full timeout.
      const early = this.earlyResponses.get(invocationId);
      if (early) {
        this.earlyResponses.delete(invocationId);
        // Terminal without ever having been pending, so the settled record is
        // written by hand: a return-then-navigate tool answers twice, and the
        // second answer must be dropped rather than buffered.
        this.settle(invocationId);
        this.deliver(waiter, early);
        return;
      }
      this.pending.set(invocationId, waiter);

      let cancelling = false;
      const cancel = (reason: "cancelled" | "timeout") => {
        // Idempotent: reachable from the abort listener AND the timeout AND
        // the already-aborted re-check below.
        if (cancelling) return;
        cancelling = true;
        waiter.cancelReason = reason;
        // The invocation deadline is moot once we have asked the page to stop;
        // the grace timer below is what settles this waiter now.
        if (waiter.timer) clearTimeout(waiter.timer);
        void Promise.resolve(
          owner.send("WebMCP.cancelInvocation", { invocationId }),
        ).catch(() => {});
        // Settle even if the page never answers our cancel — a dead page must
        // not leave the caller waiting forever. Through `settle` like every
        // other terminal transition, so the id is remembered and a late answer
        // to this invocation is dropped rather than buffered.
        waiter.cancelTimer = setTimeout(() => {
          if (!this.pending.has(invocationId)) return;
          this.settle(invocationId);
          reject(
            new WebMcpBridgeError(
              "webmcp_outcome_unknown",
              reason === "timeout"
                ? "Stopped waiting for the page tool after a timeout. Execution may continue; verify the page state before retrying."
                : "Cancellation requested. Page execution may continue; verify the page state before retrying.",
              reason,
            ),
          );
        }, this.cancelSettleGraceMs);
      };

      // Armed ONLY when nobody else owns the deadline. Two deadlines on one
      // invocation means whichever fires first decides what the failure is
      // called, and the caller's reason is the one the user reads.
      if (!args.signal) {
        waiter.timer = setTimeout(
          () => cancel("timeout"),
          this.invocationTimeoutMs,
        );
      }
      args.signal?.addEventListener(
        "abort",
        () =>
          cancel(args.signal?.reason === "timeout" ? "timeout" : "cancelled"),
        { once: true },
      );
      // The listener is registered only after `invokeTool` resolved, so an
      // abort during that round trip has already fired and would never reach
      // it — leaving the page running a tool nobody will cancel.
      if (args.signal?.aborted) {
        cancel(args.signal.reason === "timeout" ? "timeout" : "cancelled");
      }
    });

    return { invocationId, output: output.output };
  }

  /**
   * Cancel an in-flight invocation by id (the `webmcp_cancel` action). The
   * browser is told to stop either way — a caller may hold an id whose
   * invocation this bridge no longer tracks — and the boolean reports whether
   * we had a waiter to mark, so the caller can say "already finished".
   */
  async cancel(invocationId: string): Promise<boolean> {
    const waiter = this.pending.get(invocationId);
    // Mark BEFORE awaiting: the page can answer `Canceled` inside the send,
    // and a reason set afterwards would arrive too late to be reported.
    if (waiter) waiter.cancelReason = "cancelled";
    // The session that STARTED it, when we know — no other one can stop it.
    // For an id this bridge does not track (a caller holding one across a
    // reconnect) every session is asked, rather than guessing at the page's:
    // the contract is that the browser is told to stop either way, and a
    // renderer that never heard of the id simply rejects.
    const targets = waiter
      ? [waiter.cdp]
      : [...this.sessions.values()].map((session) => session.cdp);
    await Promise.all(
      targets.map((cdp) =>
        Promise.resolve(
          cdp.send("WebMCP.cancelInvocation", { invocationId }),
        ).catch(() => {}),
      ),
    );
    return Boolean(waiter);
  }

  /** Reject every waiter; called when the tab or daemon goes away. */
  dispose(): void {
    this.localBudget?.entries.delete(this);
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    this.externalSubscribers.clear();
    this.probe = undefined;
    // Child sessions are the provider's to close; what the bridge drops is its
    // own bookkeeping. It cannot UNSUBSCRIBE them — `CdpLike` has no `off` —
    // so the handlers stay wired and `live()` is what makes them inert. Without
    // that, a `toolsAdded` from a target still detaching would repopulate this
    // map and publish it through `onChange`, which `subscribers.clear()` does
    // not cover.
    for (const key of [...this.sessions.keys()]) {
      if (key !== MAIN_SESSION_KEY) this.sessions.delete(key);
    }
    this.frameSessions.clear();
    this.tools.clear();
    for (const [id, waiter] of this.pending) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.cancelTimer) clearTimeout(waiter.cancelTimer);
      waiter.reject(
        new WebMcpBridgeError(
          "webmcp_outcome_unknown",
          "The browser session ended before the page tool's outcome was known. Verify the page state before retrying.",
          "cancelled",
        ),
      );
      this.pending.delete(id);
    }
  }
}
