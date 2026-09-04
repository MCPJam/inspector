/**
 * A `WebMcpBrowserProvider` backed by browserd (the hosted stage).
 *
 * SCAFFOLD GRADE — honest about what it is. The V1 provider interface was
 * written so the browser could move off the viewer's machine, and this is that
 * move: the same session runtime, registry and routes, driving Chromium inside
 * an E2B Desktop instead of a Playwright window on the user's laptop. The
 * local `playwright-provider.ts` is untouched and stays the default.
 *
 * Two gaps, deliberate and specced rather than papered over:
 *
 * 1. TOOL DISCOVERY IS POLLED, not pushed. This provider asks for a snapshot
 *    on an interval and after every command. That is correct but laggy: a tool
 *    registered by a page's own script shows up within one poll rather than
 *    instantly.
 *
 *    HALF of that gap is now closed: `daemon/webmcp-bridge.ts` has an
 *    `onChange` push channel emitting complete snapshots, which is exactly what
 *    this provider wants and what the local inspector already consumes. What is
 *    still missing is the TRANSPORT — an SSE (or long-poll) endpoint on the
 *    daemon forwarding that channel out of the sandbox. When it exists, this
 *    provider swaps its interval for a subscription and nothing above it
 *    changes, because snapshot semantics are already what the interface wants:
 *    `onToolsChanged` takes the COMPLETE set every time, so a missed event
 *    cannot leak a stale tool.
 *
 * 2. NO ACTIVITY OR POPUP SIGNAL. `onActivityObserved` and `onPopupOpened`
 *    need the same push channel. Until then a hosted session relies on
 *    command traffic for its idle clock, so a session a person is only
 *    WATCHING through the panel can be reaped as idle. The panel's own
 *    keepalive covers the computer; wiring it to the V1 idle clock is part of
 *    the same follow-up.
 *
 * What it does do properly: it is the first constructor of the
 * `remote-interactive-url` viewport transport — the type V1 reserved for
 * exactly this and never built — so the UI can embed the desktop's stream
 * instead of claiming a browser opened on the viewer's machine.
 */
import type {
  CreateWebMcpSessionOptions,
  ProviderToolDescriptor,
  WebMcpBrowserProvider,
  WebMcpBrowserSession,
  WebMcpInvokeRequest,
} from "./provider";
import type {
  WebMcpInputEvent,
  WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";
import type { BrowserSessionHandle } from "../browserd/browser-session";
import type {
  BrowserAction,
  BrowserCommand,
  BrowserCommandResult,
} from "../browserd/protocol";
import {
  WebMcpInvocationCancelledError,
  WebMcpLeaseBlockedError,
  WebMcpOutcomeUnknownError,
} from "./provider";
import { logger } from "../../utils/logger.js";
import { randomUUID } from "node:crypto";

/** How often to re-read the page's tool set while a session is open. */
const TOOL_POLL_MS = 2_000;

/** The daemon calls this provider needs; narrowed so tests need no E2B. */
export interface BrowserdSessionTransport {
  sendCommand(
    command: BrowserCommand,
    expectedBootId?: string,
    options?: { timeoutMs?: number },
  ): Promise<{ status: string; result?: BrowserCommandResult; bootId: string }>;
}

export interface BrowserdProviderDeps {
  /**
   * The daemon this session drives, ALREADY established.
   *
   * Resolved by the caller rather than lazily here. Establishing it reserves
   * (and bills for) a machine, and doing that inside `createSession` meant it
   * happened after the session registry had taken a capacity slot, with no
   * abort signal reaching it — so a caller who gave up mid-provision could
   * neither stop the machine nor free the slot. It also put the failure where
   * no route could map it to a status.
   */
  handle: BrowserSessionHandle;
  /** Overridable for tests; defaults to the handle's own client. */
  transportFor?(handle: BrowserSessionHandle): BrowserdSessionTransport;
  /** Poll cadence; 0 disables polling (tests, and the future push path). */
  toolPollMs?: number;
  /**
   * Called after every command this session sends to the daemon. The hosted
   * runtime's idle clocks live outside the provider — the session row's, and
   * the computer's — and this is the only place that sees the traffic.
   */
  onCommand?: (info: { computerId: string; sessionId: string }) => void;
  /**
   * Does anyone currently want tool updates? The poll is suspended while this
   * returns false: every `observe` is a command the daemon must remember for
   * the life of its boot, so polling with nobody watching burns a bounded
   * budget for nothing. Omitted ⇒ always poll (the local default).
   */
  hasWatchers?: () => boolean;
}

interface BrowserdSessionOptions {
  pollMs: number;
  onCommand?: (info: { computerId: string; sessionId: string }) => void;
  hasWatchers?: () => boolean;
}

/**
 * How long after the last command the poll stays at its fast cadence.
 *
 * A page someone is actively driving changes its tools as it navigates, and
 * one poll of lag is already the worst part of this transport. A page nobody
 * has touched for a minute is being watched, not driven, and ten seconds of
 * lag on a tool list that is not changing costs nothing — while five times
 * fewer commands is the difference between a daemon that lasts a working week
 * and one that hits its per-boot ceiling overnight.
 */
const POLL_FAST_WINDOW_MS = 60_000;
const TOOL_POLL_IDLE_MS = 10_000;

/**
 * How long a lease refusal quiets the poll. Long enough that a person working
 * in the browser is not probed at the poll cadence, short enough that the tool
 * list is current again soon after they hand control back.
 */
const LEASE_BLOCKED_BACKOFF_MS = 15_000;

/**
 * Ceiling for one hosted `webmcp_invoke` round trip.
 *
 * Comfortably above the 60s the runtime gives an invocation and the 60s the
 * daemon's own bridge gives it, so the SLOWEST clock is the one with the
 * best answer. Under the daemon's, an invocation that ran long was reported
 * as a transport failure by whichever timer fired first — "the browser
 * rejected the command" for a tool that was simply still working.
 */
const WEBMCP_INVOKE_TIMEOUT_MS = 75_000;

class BrowserdWebMcpSession implements WebMcpBrowserSession {
  private url: string;
  private disposed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastToolsJson = "";
  private lastCommandAt = 0;
  /**
   * When the poll may next probe after a lease refusal.
   *
   * A TIMESTAMP rather than a flag, because a flag only a successful command
   * could clear was a deadlock: the poll skipped itself, so nothing ran, so
   * nothing cleared it, and the tool list stayed stale for as long as nobody
   * happened to invoke anything after control came back.
   */
  private leaseBlockedUntil = 0;
  /**
   * The in-flight "cancel it once we know its id" chain from an aborted
   * invocation. Held only so tests can await it; production never needs to.
   */
  cancelWhenIdentified: Promise<void> = Promise.resolve();
  private readonly pollMs: number;
  private readonly onCommand?: (info: {
    computerId: string;
    sessionId: string;
  }) => void;
  private readonly hasWatchers: () => boolean;

  constructor(
    private readonly handle: BrowserSessionHandle,
    private readonly transport: BrowserdSessionTransport,
    private readonly options: CreateWebMcpSessionOptions,
    sessionOptions: BrowserdSessionOptions,
  ) {
    this.url = options.url;
    this.pollMs = sessionOptions.pollMs;
    this.onCommand = sessionOptions.onCommand;
    this.hasWatchers = sessionOptions.hasWatchers ?? (() => true);
    if (this.pollMs > 0) this.schedulePoll();
  }

  /**
   * Self-rescheduling rather than a fixed interval, so the cadence can back
   * off — and so a slow poll can never stack on top of the previous one, which
   * a `setInterval` would happily do against an unresponsive daemon.
   */
  private schedulePoll(): void {
    if (this.disposed) return;
    const idle = Date.now() - this.lastCommandAt > POLL_FAST_WINDOW_MS;
    const delay = idle ? Math.max(this.pollMs, TOOL_POLL_IDLE_MS) : this.pollMs;
    this.pollTimer = setTimeout(() => {
      void this.pollOnce().finally(() => this.schedulePoll());
    }, delay);
    // Never hold the process open for a polling timer.
    this.pollTimer.unref?.();
  }

  private async pollOnce(): Promise<void> {
    if (this.disposed) return;
    // Nobody is watching this page and nothing is driving it, so a fresh tool
    // list has no reader. Every `observe` is an id the daemon must remember
    // for its whole boot; spending that budget on an unobserved answer is how
    // a long-lived session eventually wedges the daemon at capacity.
    if (!this.hasWatchers()) return;
    // A person is holding the browser. The daemon refuses to observe while
    // they do — deliberately, so a password being typed cannot reach a trace —
    // so a refusal buys a quiet window rather than one refusal per tick. The
    // window EXPIRES: the lease can be handed back without any command being
    // sent, and the tool list has to catch up on its own.
    if (Date.now() < this.leaseBlockedUntil) return;
    await this.refreshTools();
  }

  /**
   * Learn where the browser already is, without touching it.
   *
   * The re-hydration counterpart to `navigate`. Another replica opened this
   * page; this one is adopting a live session, and the person may be
   * mid-checkout on it. Reading the URL is the most this may do.
   */
  async adoptCurrentPage(): Promise<void> {
    const result = await this.run({ kind: "observe", mode: "url" });
    const current = readString(result.output, "url");
    if (current) {
      this.url = current;
      this.options.callbacks.onNavigated(current, originOf(current));
    }
    await this.refreshTools();
  }

  async navigate(url: string): Promise<void> {
    await this.run({ kind: "navigate", url });
    this.url = url;
    this.options.callbacks.onNavigated(url, originOf(url));
    await this.refreshTools();
  }

  async reload(): Promise<void> {
    await this.run({ kind: "reload" });
    await this.refreshTools();
  }

  async goBack(): Promise<void> {
    const result = await this.run({ kind: "back" });
    const next = readString(result.output, "url");
    if (next) {
      this.url = next;
      this.options.callbacks.onNavigated(next, originOf(next));
    }
    await this.refreshTools();
  }

  async invokeTool(request: WebMcpInvokeRequest): Promise<{ output: unknown }> {
    // Aborting must cancel the invocation IN THE BROWSER, not merely stop our
    // wait for it — a tool left running after the user hit stop keeps acting
    // on the page. The daemon reports its invocation id on the way back, but
    // an abort can land before that, so record it as soon as it is known and
    // let the abort listener fire whenever it fires.
    let aborted = request.signal.aborted;
    /** Settles the caller's wait on abort; see the race below. */
    let onAborted: (() => void) | undefined;
    const onAbort = () => {
      aborted = true;
      onAborted?.();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const sent = this.run(
        {
          kind: "webmcp_invoke",
          // The TOOL'S OWN NAME, and the frame beside it — not a composite.
          // The daemon resolves `toolKey` by name against the live page, so
          // `frameId::name` looked for a tool literally called that, matched
          // nothing, and answered `webmcp_tool_gone` for every hosted
          // invocation. `frameId` is what disambiguates a subframe's tool from
          // a same-named one in the main frame; the daemon falls back to name
          // resolution if that frame has since gone.
          toolKey: request.toolName,
          frameId: request.frameId,
          input: request.input,
        },
        {
          // The IDEMPOTENCY key, supplied by the caller and carried all the way
          // to the daemon's at-most-once queue. A retry of the same logical
          // invocation — after a dropped connection, or onto a different
          // replica — is recognised there and returns the original outcome
          // instead of running a side-effecting page tool a second time.
          commandId: request.invokeId
            ? `hosted:${request.invokeId}`
            : undefined,
          timeoutMs: WEBMCP_INVOKE_TIMEOUT_MS,
        },
      );

      // STOPPING THE PAGE and STOPPING OUR WAIT are two different things, and
      // an abort has to do both. They are separated here because the daemon's
      // `webmcp_invoke` is synchronous — it answers only once the tool has
      // settled — so the id needed to cancel the invocation does not exist
      // until the invocation is already over.
      //
      // So: the cancel is chained onto the daemon's eventual reply and runs
      // whenever that lands, while the caller's wait is raced against the
      // signal and ends immediately. Without the race, "stop" could not
      // settle anything until the very thing being stopped finished. Without
      // the chained cancel, a stopped tool would keep acting on the page.
      this.cancelWhenIdentified = sent
        .then((result) => {
          const invocationId = readString(result.output, "invocationId");
          if (aborted && invocationId) {
            return this.cancel(invocationId).then(
              () => {},
              () => {},
            );
          }
        })
        .catch(() => {});

      const result = await new Promise<BrowserCommandResult>(
        (resolve, reject) => {
          onAborted = () =>
            reject(
              new WebMcpInvocationCancelledError(
                request.signal.reason === "timeout"
                  ? "The page tool did not respond in time."
                  : "The invocation was cancelled.",
                request.signal.reason === "timeout" ? "timeout" : "cancelled",
              ),
            );
          if (aborted) onAborted();
          sent.then(resolve, reject);
        },
      );
      return { output: result.output };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Cancel by the DAEMON's invocation id (the V1 id is mapped by the caller). */
  async cancel(invocationId: string): Promise<boolean> {
    const result = await this.run({ kind: "webmcp_cancel", invocationId });
    return (
      result.output !== undefined && readBoolean(result.output, "cancelled")
    );
  }

  async captureScreenshot(): Promise<string | undefined> {
    try {
      const result = await this.run({ kind: "observe", mode: "screenshot" });
      return readString(result.output, "screenshot");
    } catch {
      // Best effort by contract: a thumbnail is never worth failing a session.
      return undefined;
    }
  }

  currentUrl(): string {
    return this.url;
  }

  hostedTarget(): { computerId: string; sessionId: string } {
    return {
      computerId: this.handle.computerId,
      sessionId: this.handle.sessionId,
    };
  }

  viewportTransport(): WebMcpViewportTransport {
    // The first real constructor of the type V1 reserved for a hosted browser.
    // Saying `native-window` here would tell the UI a window opened on the
    // viewer's machine, which is the one thing that is definitely not true.
    return { kind: "remote-interactive-url", url: this.handle.streamUrl };
  }

  /**
   * Always `false`: the hosted browser publishes its own viewport, as
   * `remote-interactive-url`, and there is no CDP screencast to start on this
   * side of the daemon.
   *
   * Reported rather than thrown, per the interface contract. The client asks
   * unconditionally when its pane is visible, and `false` is exactly what tells
   * it to poll screenshots instead of waiting for frames that will never come.
   */
  async setScreencast(enabled: boolean): Promise<boolean> {
    logger.debug("[webmcp] hosted sessions have no screencast to toggle", {
      enabled,
    });
    return false;
  }

  /**
   * No-op: the hosted browser is driven through the Browser panel's own
   * take-control path, which holds a lease. Replaying pane input here would
   * drive the same desktop from a second direction with nothing arbitrating
   * between them.
   */
  async dispatchInput(events: WebMcpInputEvent[]): Promise<void> {
    logger.debug("[webmcp] hosted sessions are driven through the panel", {
      events: events.length,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    // The daemon outlives the V1 session on purpose: the browser belongs to
    // the computer, not to this inspector tab, and killing it here would close
    // a browser a chat turn may still be driving.
  }

  /** Read the page's current tool set and report it if it changed. */
  private async refreshTools(): Promise<void> {
    if (this.disposed) return;
    try {
      const result = await this.run({ kind: "observe", mode: "webmcp_tools" });
      const tools = parseTools(result.output);
      // Snapshot semantics: the interface takes the COMPLETE set each time, so
      // comparing serialized snapshots is both the change check and the guard
      // against a missed event leaving a dead tool advertised.
      const json = JSON.stringify(tools);
      if (json === this.lastToolsJson) return;
      this.lastToolsJson = json;
      this.options.callbacks.onToolsChanged(tools);
    } catch (error) {
      if (this.disposed) return;
      logger.warn("[webmcp] hosted tool poll failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async run(
    action: BrowserAction,
    options: { commandId?: string; timeoutMs?: number } = {},
  ): Promise<BrowserCommandResult> {
    if (this.disposed) throw new Error("session disposed");
    this.lastCommandAt = Date.now();
    const response = await this.transport.sendCommand(
      {
        // A fresh id per send is right for everything EXCEPT an invocation:
        // observations and navigations are safe to repeat, so giving them
        // stable ids would only fill the daemon's per-boot memory. An
        // invocation passes its own — see `invokeTool`.
        commandId: options.commandId ?? randomUUID(),
        source: "inspector",
        action,
      },
      this.handle.bootId,
      options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : undefined,
    );
    // Reported to whoever owns this session's idle clocks. Sent for every
    // outcome including a refusal: the traffic is what proves someone is
    // using the machine, and a lease refusal means a PERSON is using it
    // directly, which is the strongest signal of all.
    this.onCommand?.({
      computerId: this.handle.computerId,
      sessionId: this.handle.sessionId,
    });
    if (response.status === "lease_blocked") {
      // Backs the poll off rather than stopping it: without this it re-asks
      // every couple of seconds for as long as a person holds the browser and
      // is refused every time.
      this.leaseBlockedUntil = Date.now() + LEASE_BLOCKED_BACKOFF_MS;
      throw new WebMcpLeaseBlockedError(
        "a person has taken control of this browser; nothing was run or observed",
      );
    }
    this.leaseBlockedUntil = 0;
    if (response.status === "expired") {
      // The daemon retained this commandId's result and then evicted it, so
      // the original outcome is neither returnable nor safely repeatable.
      // Said plainly, because "unknown" is the honest answer and re-running a
      // side-effecting page tool to find out is not an option.
      throw new WebMcpOutcomeUnknownError(
        "this invocation's outcome is no longer known to the browser: it ran, but the result has expired",
      );
    }
    if (response.status !== "ok" || !response.result) {
      throw new Error(`the browser rejected the command (${response.status})`);
    }
    if (!response.result.ok) {
      throw new Error(
        response.result.error ?? "the browser could not complete the command",
      );
    }
    return response.result;
  }
}

export function createBrowserdWebMcpProvider(
  deps: BrowserdProviderDeps,
): WebMcpBrowserProvider {
  const pollMs = deps.toolPollMs ?? TOOL_POLL_MS;
  return {
    async createSession(
      options: CreateWebMcpSessionOptions,
    ): Promise<WebMcpBrowserSession> {
      const { handle } = deps;
      const transport =
        deps.transportFor?.(handle) ??
        (handle.client as unknown as BrowserdSessionTransport);
      const session = new BrowserdWebMcpSession(handle, transport, options, {
        pollMs,
        ...(deps.onCommand ? { onCommand: deps.onCommand } : {}),
        ...(deps.hasWatchers ? { hasWatchers: deps.hasWatchers } : {}),
      });
      if (options.navigate === false) {
        // RE-HYDRATION. Another replica already has this page open; this one is
        // adopting it, so it reads where the browser is rather than sending it
        // somewhere. Navigating here would reload the page under a person who
        // is mid-flow on it, and would do so on every replica that ever serves
        // a request for this session.
        await session.adoptCurrentPage();
      } else {
        await session.navigate(options.url);
      }
      return session;
    },
  };
}

/** The daemon reports `{tools:[{frameId,name,…}]}`; V1 wants raw browser facts. */
function parseTools(output: unknown): ProviderToolDescriptor[] {
  if (typeof output !== "object" || output === null) return [];
  const raw = (output as { tools?: unknown }).tools;
  if (!Array.isArray(raw)) return [];
  const tools: ProviderToolDescriptor[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const tool = entry as Record<string, unknown>;
    const name = typeof tool.name === "string" ? tool.name : "";
    const frameId = typeof tool.frameId === "string" ? tool.frameId : "";
    if (!name || !frameId) continue;
    tools.push({
      frameId,
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      ...(typeof tool.inputSchema === "object" && tool.inputSchema !== null
        ? { inputSchema: tool.inputSchema as Record<string, unknown> }
        : {}),
      origin: typeof tool.origin === "string" ? tool.origin : "",
      isMainFrame: tool.isMainFrame === true,
      // The daemon does not distinguish declarative from imperative
      // registration yet; claiming either would be a guess the UI displays.
      registrationKind: "unknown",
    });
  }
  return tools;
}

function readString(output: unknown, key: string): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const value = (output as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(output: unknown, key: string): boolean {
  if (typeof output !== "object" || output === null) return false;
  return (output as Record<string, unknown>)[key] === true;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
