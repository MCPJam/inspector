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
import { logger } from "../../utils/logger.js";
import { randomUUID } from "node:crypto";

/** How often to re-read the page's tool set while a session is open. */
const TOOL_POLL_MS = 2_000;

/** The daemon calls this provider needs; narrowed so tests need no E2B. */
export interface BrowserdSessionTransport {
  sendCommand(
    command: BrowserCommand,
    expectedBootId?: string,
  ): Promise<{ status: string; result?: BrowserCommandResult; bootId: string }>;
}

export interface BrowserdProviderDeps {
  /** Establish (or reuse) the hosted browser for this session. */
  ensureSession(options: {
    url: string;
    signal?: AbortSignal;
  }): Promise<BrowserSessionHandle>;
  /** Overridable for tests; defaults to the handle's own client. */
  transportFor?(handle: BrowserSessionHandle): BrowserdSessionTransport;
  /** Poll cadence; 0 disables polling (tests, and the future push path). */
  toolPollMs?: number;
}

class BrowserdWebMcpSession implements WebMcpBrowserSession {
  private url: string;
  private disposed = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastToolsJson = "";

  constructor(
    private readonly handle: BrowserSessionHandle,
    private readonly transport: BrowserdSessionTransport,
    private readonly options: CreateWebMcpSessionOptions,
    pollMs: number,
  ) {
    this.url = options.url;
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => {
        void this.refreshTools();
      }, pollMs);
      // Never hold the process open for a polling timer.
      this.pollTimer.unref?.();
    }
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
    let invocationId: string | undefined;
    let aborted = request.signal.aborted;
    const onAbort = () => {
      aborted = true;
      if (invocationId) void this.cancel(invocationId).catch(() => {});
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.run({
        kind: "webmcp_invoke",
        toolKey: `${request.frameId}::${request.toolName}`,
        input: request.input,
      });
      invocationId = readString(result.output, "invocationId");
      // The abort may have arrived while the invoke was in flight, before we
      // had an id to cancel with.
      if (aborted && invocationId) {
        await this.cancel(invocationId).catch(() => {});
      }
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

  viewportTransport(): WebMcpViewportTransport {
    // The first real constructor of the type V1 reserved for a hosted browser.
    // Saying `native-window` here would tell the UI a window opened on the
    // viewer's machine, which is the one thing that is definitely not true.
    return { kind: "remote-interactive-url", url: this.handle.streamUrl };
  }

  /**
   * No-op: the hosted browser already publishes its own viewport, as
   * `remote-interactive-url`, and there is no CDP screencast to start on this
   * side of the daemon.
   *
   * Logged rather than thrown, per the interface contract. The client asks for
   * a screencast unconditionally when its pane is visible, and throwing here
   * would report a failure on a session whose viewport is working fine.
   */
  async setScreencast(enabled: boolean): Promise<void> {
    logger.debug("[webmcp] hosted sessions have no screencast to toggle", {
      enabled,
    });
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
    if (this.pollTimer) clearInterval(this.pollTimer);
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

  private async run(action: BrowserAction): Promise<BrowserCommandResult> {
    if (this.disposed) throw new Error("session disposed");
    const response = await this.transport.sendCommand(
      {
        commandId: randomUUID(),
        source: "inspector",
        action,
      },
      this.handle.bootId,
    );
    if (response.status === "lease_blocked") {
      throw new Error(
        "a person has taken control of this browser; nothing was run or observed",
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
      const handle = await deps.ensureSession({ url: options.url });
      const transport =
        deps.transportFor?.(handle) ??
        (handle.client as unknown as BrowserdSessionTransport);
      const session = new BrowserdWebMcpSession(
        handle,
        transport,
        options,
        pollMs,
      );
      await session.navigate(options.url);
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
