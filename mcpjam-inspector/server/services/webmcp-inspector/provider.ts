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
}

export interface WebMcpInvokeRequest {
  frameId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Aborting cancels the browser-side invocation, not just our wait for it. */
  signal: AbortSignal;
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
  /** Idempotent, and must not hang: teardown races a timeout internally. */
  dispose(): Promise<void>;
}

export interface CreateWebMcpSessionOptions {
  url: string;
  /** False only in tests; a user-facing session always opens a real window. */
  headless?: boolean;
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
