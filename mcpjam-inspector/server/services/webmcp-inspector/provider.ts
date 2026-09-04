/**
 * The browser boundary for the WebMCP Inspector.
 *
 * Everything above this interface — the session runtime, the registry, the
 * routes — is written against these types and never imports Playwright or
 * speaks CDP. That is deliberate: the hosted stage runs the browser somewhere
 * else (E2B Desktop and friends), and swapping the implementation should not
 * reach into tool identity, invocation queueing, activity, or lifecycle.
 *
 * Providers report RAW BROWSER FACTS: a frame id and the name the page used.
 * Naming policy — stable keys, collision suffixes, model-facing aliases —
 * belongs to the runtime, which is the layer that can see the whole registry
 * at once.
 */
import type {
  WebMcpFrame,
  WebMcpInputEvent,
  WebMcpToolAnnotations,
  WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";

/** A tool as the browser reports it, before identity policy is applied. */
export interface ProviderToolDescriptor {
  /** CDP frame id. Churns across page loads — never persist it as identity. */
  frameId: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  /** Origin of the registering frame, resolved by the provider. */
  origin: string;
  isMainFrame: boolean;
  /** Declarative tools carry a DOM node; imperative ones carry a stack trace. */
  registrationKind: "declarative" | "imperative" | "unknown";
}

export interface WebMcpSessionCallbacks {
  /**
   * The COMPLETE current tool set, every time anything changes. Providers do
   * not emit deltas: navigation fires no removal event in Chromium (see
   * `webmcp-cdp.spike.test.ts`), so a provider that forwarded only the
   * browser's own add/remove signals would leak tools from the previous page
   * forever. Recomputing a snapshot makes that class of bug unrepresentable.
   */
  onToolsChanged(tools: ProviderToolDescriptor[]): void;
  onNavigated(url: string, origin: string): void;
  /**
   * A popup opened. It is deliberately left open and un-driven — closing one or
   * folding it into the main tab breaks OAuth and `window.opener` flows.
   */
  onPopupOpened(url: string): void;
  /** A tool ran that we did not start (e.g. the page's own agent). */
  onExternalInvocation(note: string, toolName?: string): void;
  /**
   * The user did something in the browser. Drives the idle clock, so a session
   * being actively used through its own window is not reaped as idle.
   */
  onActivityObserved(): void;
  onCrashed(message: string): void;
  /**
   * A painted frame of the page, for the `frame-stream` viewport.
   *
   * Deliberately NOT routed through `onActivityObserved`. A page with a CSS
   * spinner paints forever, so a frame that ticked the idle clock would make an
   * abandoned session unreapable — the browser would sit open until its hard
   * lifetime ran out, holding a capacity slot nobody is using.
   */
  onFrame(frame: WebMcpFrame): void;
  /**
   * The stream is now encoding at a different quality.
   *
   * OPTIONAL, because only a provider with an adaptive stream has anything to
   * say here — the hosted browser paints in a datacenter and the embedded
   * surface is already on the viewer's screen. The runtime republishes the
   * session so the picture getting worse is visible as a fact rather than a
   * mystery.
   */
  onStreamQualityChanged?(quality: number): void;
}

export interface WebMcpInvokeRequest {
  frameId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Aborting cancels the browser-side invocation, not just our wait for it. */
  signal: AbortSignal;
  /**
   * This invocation's stable id, for providers that can de-duplicate on it.
   *
   * The hosted provider carries it to the daemon's at-most-once queue, so a
   * retry of the same logical invocation — a dropped connection, a request
   * re-sent onto a different replica — returns the original outcome instead of
   * running a side-effecting page tool twice. Local providers ignore it: they
   * cannot receive a retry, because the browser is in this process.
   */
  invokeId?: string;
}

export interface WebMcpBrowserSession {
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  invokeTool(request: WebMcpInvokeRequest): Promise<{ output: unknown }>;
  /** Best-effort thumbnail; resolves undefined rather than throwing. */
  captureScreenshot(): Promise<string | undefined>;
  currentUrl(): string;
  viewportTransport(): WebMcpViewportTransport;
  /**
   * The remote machine this session drives, for callers that must keep it
   * awake. Absent on providers whose browser is local — there is nothing to
   * keep awake, and nothing that bills for being awake.
   */
  hostedTarget?(): { computerId: string; sessionId: string } | undefined;
  /**
   * Start or stop streaming frames, reporting whether frames are now flowing.
   *
   * The RETURN VALUE is what lets the client fall back. A provider with no
   * screencast (the hosted one drives its own stream) answers `false`, and so
   * does one whose browser refused `Page.startScreencast` — and the client
   * polls screenshots instead of sitting on "Waiting for the first frame…"
   * forever. Reporting a failed start as success is the same bug as not having
   * a fallback at all.
   *
   * Idempotent: the client asks on every pane mount and every visibility
   * change, so "already on" is a no-op rather than a second encoder. Must
   * never throw — the client asks unconditionally, and a throw would surface as
   * a failed command on a session whose viewport may be working fine.
   */
  setScreencast(enabled: boolean): Promise<boolean>;
  /**
   * Apply a batch of input to the page, in order.
   *
   * A batch rather than one event at a time because pointer movement floods:
   * the transport above coalesces moves and flushes on a short interval, and
   * ordering within a batch is what makes a down-move-up sequence a drag rather
   * than three unrelated events.
   *
   * A provider that cannot be driven this way (the hosted one, whose viewport
   * is driven through the Browser panel instead) logs and returns.
   */
  dispatchInput(events: WebMcpInputEvent[]): Promise<void>;
  /**
   * A frame could not be handed to a viewer, and was replaced by a newer one.
   *
   * The transport's report that the link is behind — the one thing a provider
   * cannot observe for itself, since it publishes into a fan-out and never
   * learns what happened afterwards. Called on the HOT PATH, once per dropped
   * frame, so it must be cheap and MUST NOT THROW.
   *
   * OPTIONAL: a provider whose stream is not adaptive has nothing to do with
   * this, and should not have to carry an empty method to say so.
   */
  noteFramePressure?(): void;
  /** Idempotent, and must not hang: teardown races a timeout internally. */
  dispose(): Promise<void>;
}

/**
 * WHERE the person looks at, and drives, the page.
 *
 * `window` is the original behaviour: a real Chrome window on the developer's
 * own machine, which they drive directly with their own devtools open. The
 * inspector streams a view of it, but the window is the surface.
 *
 * `embedded` has no window at all. The browser runs headless and the streamed
 * pane is the only way to see or touch the page, which is why an embedded
 * session starts its screencast without being asked: a headless browser with no
 * stream is a session with no viewport, and nothing would ever turn it on.
 */
export type WebMcpViewportMode = "window" | "embedded";

export interface CreateWebMcpSessionOptions {
  url: string;
  /**
   * `false` ⇒ adopt the page the browser is ALREADY on instead of driving it
   * to `url`.
   *
   * For a remote browser being re-hydrated by a replica that did not start it.
   * The session is live and a person may be mid-flow on it; navigating would
   * reload the page under them, once per replica that ever serves a request.
   * Omitted means navigate, which is what every local caller wants.
   */
  navigate?: boolean;
  /** False only in tests; a user-facing session always opens a real window. */
  headless?: boolean;
  /**
   * Defaults to `window`, so a caller that omits it gets exactly the V1
   * behaviour. `embedded` implies headless regardless of the flag above.
   */
  viewportMode?: WebMcpViewportMode;
  /**
   * Device pixels per CSS pixel the page should be RENDERED at.
   *
   * The viewer's own ratio, forwarded by the client, because that is the only
   * place it is known: a browser running headless on a server has no display to
   * ask. Omitted means 1, which is what every caller older than this field
   * gets and what a provider with no notion of it can ignore.
   *
   * Fixed for the life of the session on purpose. It is the browser context's
   * `deviceScaleFactor`, set once at creation rather than emulated later — a
   * second device-metrics override fights the one Playwright re-applies on
   * every navigation, and last-writer-wins between two of them is a session
   * whose scale depends on timing.
   */
  devicePixelRatio?: number;
  callbacks: WebMcpSessionCallbacks;
}

export interface WebMcpBrowserProvider {
  createSession(
    options: CreateWebMcpSessionOptions,
  ): Promise<WebMcpBrowserSession>;
}

/**
 * The browser started, but it has no WebMCP support — so the page loads and
 * nothing is inspectable. Distinct from a crash: the session is usable for
 * navigation, and the UI says exactly what is wrong instead of showing an
 * empty tool list that looks like the page's fault.
 */
export class WebMcpUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpUnsupportedError";
  }
}

/**
 * Chromium is missing and could not be installed.
 *
 * Declared here rather than imported from `mcp-app-browser-harness.ts`, which
 * exports an equivalent: that module inlines an ~850 KiB generated host-page
 * bundle, and importing it for one error class would drag the whole widget
 * harness into the import graph of every WebMCP session.
 */
export class WebMcpChromiumNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpChromiumNotInstalledError";
  }
}

/**
 * The browser could not open a window because there is no display.
 *
 * Its own class because the fix is specific and the raw Playwright text is a
 * wall: someone over SSH, in a container, or on a bare WSL install needs to be
 * told to run headless, not handed browser logs.
 */
export class WebMcpNoDisplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpNoDisplayError";
  }
}

/** A tool name that is no longer registered (usually: the page navigated). */
export class WebMcpToolGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpToolGoneError";
  }
}

/**
 * A person has taken control of the browser, so nothing ran and — the point of
 * enforcing it at the daemon — nothing was observed either.
 *
 * Its own type because it is a normal, expected condition with a specific
 * remedy ("hand control back"), not a failure. As a bare `Error` it reached
 * the route's catch-all and became a 500 plus a Sentry event, every time
 * somebody used the take-control button the feature ships with.
 */
export class WebMcpLeaseBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpLeaseBlockedError";
  }
}

/**
 * The invocation ran, and what it did is no longer knowable.
 *
 * The honest terminal state for a remote invocation whose result the browser
 * retained and then evicted. Neither "succeeded" nor "failed" is true, and
 * re-running to find out is exactly what must not happen to a tool that may
 * have charged a card. The timeline shows it as `unknown`.
 */
export class WebMcpOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpOutcomeUnknownError";
  }
}

/** The invocation was cancelled — by the user, or by the timeout. */
export class WebMcpInvocationCancelledError extends Error {
  constructor(
    message: string,
    readonly reason: "cancelled" | "timeout",
  ) {
    super(message);
    this.name = "WebMcpInvocationCancelledError";
  }
}
