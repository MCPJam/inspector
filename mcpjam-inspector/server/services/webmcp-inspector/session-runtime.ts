/**
 * One inspected page: tool identity, the invocation queue, and the activity
 * timeline. Knows nothing about HTTP, and nothing about Playwright — it talks
 * to a {@link WebMcpBrowserSession} and publishes to a {@link WebMcpStreamHub}.
 *
 * Identity is this layer's job because it is the only layer that sees the whole
 * registry at once. Providers report `{frameId, name}`, which is the browser's
 * identity and useless as ours: frame ids churn across navigations, so a key
 * built from one would break every bookmark, chat snapshot and pending
 * invocation on reload. Instead each tool gets `origin::name`, resolved back to
 * a live frame id at the moment of invocation.
 */
import { randomUUID, createHash } from "node:crypto";
import {
  capInputEcho,
  capResult,
  WEBMCP_INVOKE_QUEUE_LIMIT,
  WEBMCP_INVOKE_TIMEOUT_MS,
  type WebMcpActivityEntry,
  type WebMcpFrame,
  type WebMcpInputEvent,
  type WebMcpInvocationSource,
  type WebMcpInvocationState,
  type WebMcpSessionPublic,
  type WebMcpSessionStatus,
  type WebMcpToolDescriptor,
  type WebMcpToolRef,
  WEBMCP_TOOL_DESCRIPTION_MAX_CHARS,
  WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES,
  WEBMCP_TOOL_MAX_ENTRIES,
  WEBMCP_TOOL_NAME_MAX_CHARS,
  WEBMCP_INSPECTOR_PROTOCOL_VERSION,
} from "@/shared/webmcp-inspector-protocol";
import {
  WebMcpInvocationCancelledError,
  WebMcpToolGoneError,
  type ProviderToolDescriptor,
  type WebMcpBrowserSession,
  type WebMcpSessionCallbacks,
} from "./provider";
import { WebMcpStreamHub } from "./stream-hub";

/**
 * An activity entry before the runtime stamps its id and timestamp.
 *
 * Distributive on purpose: a bare `Omit<Union, …>` collapses a union to the
 * keys its members share, which would silently accept an entry carrying the
 * wrong fields for its kind.
 */
type WebMcpActivityDraft = WebMcpActivityEntry extends infer Entry
  ? Entry extends WebMcpActivityEntry
    ? Omit<Entry, "id" | "ts">
    : never
  : never;

export class WebMcpQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpQueueFullError";
  }
}

export interface WebMcpSessionRuntimeOptions {
  sessionId?: string;
  now?: () => number;
  invokeTimeoutMs?: number;
  queueLimit?: number;
  /** Called whenever anything happens that should postpone idle reaping. */
  onActivity?: () => void;
}

interface TrackedTool extends WebMcpToolDescriptor {
  frameId: string;
}

interface QueuedInvocation {
  invokeId: string;
  toolKey: string;
  input: Record<string, unknown>;
  source: WebMcpInvocationSource;
  controller: AbortController;
  resolve: (result: { output: unknown; truncated: boolean }) => void;
  reject: (error: Error) => void;
}

/**
 * Bound page-authored metadata before it enters the runtime or replay ring.
 * The chat route validates the same limits at its HTTP boundary, but the
 * provider feeds this path directly from CDP and never crosses that route.
 * Oversized schemas are omitted rather than sliced so they remain valid JSON
 * Schema; a tool with no schema is still manually invokable with `{}`.
 */
function boundProviderTools(
  incoming: ProviderToolDescriptor[],
): ProviderToolDescriptor[] {
  return incoming
    .slice(0, WEBMCP_TOOL_MAX_ENTRIES)
    .filter(
      (tool) =>
        tool.name.length <= WEBMCP_TOOL_NAME_MAX_CHARS &&
        tool.origin.length <= WEBMCP_TOOL_NAME_MAX_CHARS,
    )
    .map((tool) => {
      let inputSchema = tool.inputSchema;
      if (inputSchema !== undefined) {
        try {
          if (
            Buffer.byteLength(JSON.stringify(inputSchema), "utf8") >
            WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES
          ) {
            inputSchema = undefined;
          }
        } catch {
          inputSchema = undefined;
        }
      }
      return {
        ...tool,
        description: tool.description.slice(
          0,
          WEBMCP_TOOL_DESCRIPTION_MAX_CHARS,
        ),
        inputSchema,
      };
    });
}

export class WebMcpSessionRuntime {
  readonly sessionId: string;
  readonly hub = new WebMcpStreamHub();
  readonly createdAt: number;

  private session: WebMcpBrowserSession | undefined;
  private status: WebMcpSessionStatus = "starting";
  private statusDetail: string | undefined;
  private url: string;
  private seq = 0;
  private tools: TrackedTool[] = [];
  private readonly queue: QueuedInvocation[] = [];
  private running: QueuedInvocation | undefined;
  private draining = false;
  /**
   * The in-flight drain, so `close()` can wait for it.
   *
   * `hub.publish()` is a silent no-op once the hub is closed, so a close that
   * lands mid-invocation would otherwise swallow that invocation's
   * `invocation_settled` and leave it looking like it never finished — in the
   * timeline, which is the record the session exists to produce.
   */
  private draining_ = Promise.resolve();
  private readonly now: () => number;
  private readonly invokeTimeoutMs: number;
  private readonly queueLimit: number;
  private readonly onActivity: () => void;
  /**
   * The quality the provider's stream is encoding at, when it has an adaptive
   * one. Reported, never decided here: the provider owns the ladder.
   */
  private streamQuality: number | undefined;
  /** Set by the registry; the runtime reports it but does not own it. */
  expiresAt = 0;
  hardExpiresAt = 0;

  constructor(startUrl: string, options: WebMcpSessionRuntimeOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? WEBMCP_INVOKE_TIMEOUT_MS;
    this.queueLimit = options.queueLimit ?? WEBMCP_INVOKE_QUEUE_LIMIT;
    this.onActivity = options.onActivity ?? (() => {});
    this.url = startUrl;
    this.createdAt = this.now();
    // Recorded at construction, not at `attach`: the browser navigates and
    // registers tools while it is starting, so an entry written afterwards
    // would land behind them and the timeline would read "navigated, tools
    // added, session started".
    this.pushActivity({ kind: "session_started", url: this.url });
  }

  /** Callbacks handed to the provider at construction. */
  callbacks(): WebMcpSessionCallbacks {
    return {
      onToolsChanged: (tools) => this.applyTools(tools),
      onNavigated: (url, origin) => {
        this.url = url;
        // The retained frame depicts a page that is gone. Held, it would be
        // replayed to a reconnecting client as the current one — the same class
        // of lie as serving the previous page's tools, which is why the
        // provider drops those here too.
        this.hub.clearFrame();
        this.setStatus("ready");
        this.pushActivity({ kind: "navigated", url, origin });
      },
      onPopupOpened: (url) =>
        this.pushActivity({
          kind: "popup_opened",
          url,
          note: "Popups are left open so sign-in flows keep working. Their tools are not inspected.",
        }),
      onExternalInvocation: (note, toolName) =>
        this.pushActivity({
          kind: "external_invocation",
          note,
          toolKey: toolName
            ? this.tools.find((t) => t.name === toolName)?.toolKey
            : undefined,
        }),
      onActivityObserved: () => this.onActivity(),
      onFrame: (frame) => this.publishFrame(frame),
      onStreamQualityChanged: (quality) => {
        // Republished only on a real change: the provider may re-report the
        // same rung after a restart, and a session event per frame-rate wobble
        // would be chatter on a stream the timeline shares.
        if (this.streamQuality === quality) return;
        this.streamQuality = quality;
        this.publishSession();
      },
      onCrashed: (message) => {
        this.setStatus("error", message);
        this.pushActivity({ kind: "session_error", message });
        // A dead browser can never settle what is in flight.
        this.failAllPending(new Error(message));
      },
    };
  }

  attach(session: WebMcpBrowserSession): void {
    this.session = session;
    this.url = session.currentUrl();
    // Status is set without publishing: the registry has not adopted this
    // session yet, so its deadlines are still zero and an event sent now would
    // sit in the replay buffer advertising a session that expires at the epoch.
    // `register` publishes the first session event, once there is one to tell.
    this.status = "ready";
  }

  /** Record that the browser works but WebMCP is unavailable in it. */
  markUnsupported(message: string): void {
    this.setStatus("unsupported", message);
    this.pushActivity({ kind: "unsupported", message });
  }

  toPublic(): WebMcpSessionPublic {
    return {
      sessionId: this.sessionId,
      status: this.status,
      url: this.url,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      hardExpiresAt: this.hardExpiresAt,
      viewportTransport: this.session?.viewportTransport() ?? {
        kind: "native-window",
      },
      // Spread rather than sent as undefined, so a provider with no adaptive
      // stream reports a session shaped exactly as it always has been.
      ...(this.streamQuality !== undefined
        ? { streamQuality: this.streamQuality }
        : {}),
      protocolVersion: WEBMCP_INSPECTOR_PROTOCOL_VERSION,
      ...(this.statusDetail ? { detail: this.statusDetail } : {}),
    };
  }

  currentTools(): WebMcpToolDescriptor[] {
    return this.tools.map(({ frameId: _frameId, ...rest }) => rest);
  }

  /** True while an invocation holds the session, so it must not be reaped. */
  get inFlight(): number {
    return (this.running ? 1 : 0) + this.queue.length;
  }

  // ---------------------------------------------------------------- tools

  private applyTools(incoming: ProviderToolDescriptor[]): void {
    const previous = new Map(this.tools.map((t) => [t.toolKey, t]));
    const next = assignToolKeys(boundProviderTools(incoming));

    const added = next.filter((tool) => !previous.has(tool.toolKey));
    const removed = this.tools.filter(
      (tool) => !next.some((candidate) => candidate.toolKey === tool.toolKey),
    );

    this.tools = next;
    this.publish({
      type: "tools",
      seq: this.nextSeq(),
      tools: this.currentTools(),
    });

    if (added.length > 0) {
      this.pushActivity({ kind: "tools_added", tools: added.map(toRef) });
    }
    if (removed.length > 0) {
      // Chromium never reports removal on navigation, so a removal we observe
      // is almost always our own synthesis from a frame navigating away. The
      // cause is recorded so the timeline can say which it was.
      this.pushActivity({
        kind: "tools_removed",
        tools: removed.map(toRef),
        cause: "page",
      });
    }
  }

  // ---------------------------------------------------------- navigation

  /** Drive the page. Status flips to `navigating` so the UI can say so. */
  async navigateCommand(
    command:
      | { type: "navigate"; url: string }
      | { type: "reload" }
      | { type: "go_back" },
  ): Promise<void> {
    const session = this.requireSession();
    this.setStatus("navigating");
    try {
      if (command.type === "navigate") await session.navigate(command.url);
      else if (command.type === "reload") await session.reload();
      else await session.goBack();
      this.url = session.currentUrl();
      this.setStatus("ready");
    } catch (error) {
      // A failed navigation leaves the browser on the page it was already on,
      // so the session stays usable and only the command reports the failure.
      this.setStatus("ready");
      throw error;
    }
  }

  /** On-demand screenshot for the UI's preview button. */
  async screenshotNow(): Promise<string | undefined> {
    const shot = await this.requireSession().captureScreenshot();
    this.onActivity();
    return shot;
  }

  /**
   * Start or stop the viewport stream, reporting whether frames are flowing.
   *
   * `false` is a real answer, not a failure: this browser cannot screencast, or
   * the provider has no such thing. The caller turns it into the screenshot
   * fallback, which is the difference between a degraded pane and a pane stuck
   * on "Waiting for the first frame…".
   *
   * Ticks the idle clock only when TURNING IT ON. Asking for frames is a person
   * opening the pane — interest worth postponing a reap for. Withdrawing them
   * is the opposite, and since the client withdraws on every visibility change,
   * ticking there would let a flapping background tab keep an abandoned session
   * alive indefinitely.
   */
  async setScreencast(enabled: boolean): Promise<boolean> {
    const streaming = await this.requireSession().setScreencast(enabled);
    if (enabled) this.onActivity();
    // Nothing is going to replace that retained frame now, and replay promises
    // a reconnecting client the CURRENT paint rather than the last one before
    // the stream stopped.
    if (!streaming) this.hub.clearFrame();
    return streaming;
  }

  /**
   * Drive the page from the pane.
   *
   * Ticks the idle clock — a human working the pane is the clearest possible
   * signal that the session is in use, and reaping it out from under them would
   * be the worst version of this feature.
   *
   * Writes NO timeline entry, mirroring `capture_screenshot`. The timeline
   * records protocol happenings: tools registering, invocations starting and
   * settling. Input's consequences already produce entries — a click that
   * navigates writes `navigated`, one that fires a page tool writes
   * `external_invocation` — so logging the clicks themselves would bury those
   * under a mouse trail.
   */
  async dispatchInput(events: WebMcpInputEvent[]): Promise<void> {
    await this.requireSession().dispatchInput(events);
    this.onActivity();
  }

  private requireSession(): WebMcpBrowserSession {
    if (!this.session) {
      throw new Error("The browser session is not ready.");
    }
    return this.session;
  }

  // ----------------------------------------------------------- invocation

  /**
   * Queue an invocation. Resolves when the tool settles, so both the manual
   * route and the chat path can await the same call. The queue is strictly
   * FIFO and one-at-a-time: page tools mutate a single shared page, and running
   * two concurrently would interleave their effects unpredictably.
   */
  invoke(
    toolKey: string,
    input: Record<string, unknown>,
    source: WebMcpInvocationSource,
  ): {
    invokeId: string;
    settled: Promise<{ output: unknown; truncated: boolean }>;
  } {
    if (this.inFlight >= this.queueLimit + 1) {
      throw new WebMcpQueueFullError(
        `Too many invocations are already queued (limit ${this.queueLimit}).`,
      );
    }
    const invokeId = randomUUID();
    let resolve!: (result: { output: unknown; truncated: boolean }) => void;
    let reject!: (error: Error) => void;
    const settled = new Promise<{ output: unknown; truncated: boolean }>(
      (res, rej) => {
        resolve = res;
        reject = rej;
      },
    );
    this.queue.push({
      invokeId,
      toolKey,
      input,
      source,
      controller: new AbortController(),
      resolve,
      reject,
    });
    this.draining_ = this.drain();
    void this.draining_;
    return { invokeId, settled };
  }

  /** Cancel a queued or running invocation. Idempotent by design: cancelling
   *  something already settled is a race, not an error. */
  cancel(invokeId: string): boolean {
    if (this.running?.invokeId === invokeId) {
      this.running.controller.abort("cancelled");
      return true;
    }
    const index = this.queue.findIndex((item) => item.invokeId === invokeId);
    if (index === -1) return false;
    const [dropped] = this.queue.splice(index, 1);
    dropped.reject(
      new WebMcpInvocationCancelledError(
        "Cancelled before it started.",
        "cancelled",
      ),
    );
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.running = item;
        try {
          await this.run(item);
        } finally {
          this.release(item);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Stop counting an invocation as in flight.
   *
   * Called immediately BEFORE settling its promise, not after `run` returns:
   * a caller that awaits an invocation and then navigates must not be told the
   * page is still busy by the very call it just watched finish.
   */
  private release(item: QueuedInvocation): void {
    if (this.running === item) this.running = undefined;
  }

  private async run(item: QueuedInvocation): Promise<void> {
    const session = this.session;
    const startedAt = this.now();
    this.onActivity();

    if (!session) {
      await this.settle(item, "failed", startedAt, {
        errorMessage: "The browser session is not ready.",
      });
      this.release(item);
      item.reject(new Error("The browser session is not ready."));
      return;
    }

    // Resolved at dequeue, not at enqueue: a navigation between the two may
    // have replaced or removed the tool, and invoking a stale frame id would
    // either fail obscurely or hit the wrong page.
    const tool = this.tools.find(
      (candidate) => candidate.toolKey === item.toolKey,
    );
    if (!tool) {
      const message = `The page no longer offers "${item.toolKey}".`;
      await this.settle(item, "failed", startedAt, { errorMessage: message });
      this.release(item);
      item.reject(new WebMcpToolGoneError(message));
      return;
    }

    const echo = capInputEcho(item.input);
    this.pushActivity({
      kind: "invocation_started",
      invokeId: item.invokeId,
      toolKey: item.toolKey,
      source: item.source,
      input: echo.value,
      ...(echo.truncated ? { inputTruncated: true } : {}),
      ...(await this.screenshot()),
    });

    const timeout = setTimeout(
      () => item.controller.abort("timeout"),
      this.invokeTimeoutMs,
    );
    try {
      const { output } = await session.invokeTool({
        frameId: tool.frameId,
        toolName: tool.name,
        input: item.input,
        signal: item.controller.signal,
      });
      const capped = capResult(output);
      await this.settle(item, "succeeded", startedAt, {
        output: capped.value,
        ...(capped.truncated
          ? { outputTruncated: true, outputBytes: capped.bytes }
          : {}),
      });
      this.release(item);
      item.resolve({ output: capped.value, truncated: capped.truncated });
    } catch (error) {
      const state: WebMcpInvocationState =
        error instanceof WebMcpInvocationCancelledError
          ? error.reason === "timeout"
            ? "timeout"
            : "cancelled"
          : "failed";
      const message =
        error instanceof Error ? error.message : "The tool failed.";
      await this.settle(item, state, startedAt, { errorMessage: message });
      this.release(item);
      item.reject(error instanceof Error ? error : new Error(message));
    } finally {
      clearTimeout(timeout);
      this.onActivity();
    }
  }

  /**
   * Publish the terminal entry for an invocation, and WAIT for it.
   *
   * Awaited rather than fired off, because the after-screenshot it captures
   * takes long enough for two things to go wrong otherwise: `drain` dequeues
   * the next invocation and publishes its `invocation_started` first, so the
   * timeline reports the two calls out of order; and a `close()` in between
   * shuts the hub before the entry lands, so the last invocation of a session
   * looks like it never finished.
   */
  private async settle(
    item: QueuedInvocation,
    state: WebMcpInvocationState,
    startedAt: number,
    extra: {
      output?: unknown;
      outputTruncated?: boolean;
      outputBytes?: number;
      errorMessage?: string;
    },
  ): Promise<void> {
    const shot = await this.screenshot();
    this.pushActivity({
      kind: "invocation_settled",
      invokeId: item.invokeId,
      toolKey: item.toolKey,
      source: item.source,
      state,
      durationMs: this.now() - startedAt,
      ...extra,
      ...shot,
    });
  }

  private async screenshot(): Promise<{ screenshotBase64?: string }> {
    const shot = await this.session?.captureScreenshot().catch(() => undefined);
    return shot ? { screenshotBase64: shot } : {};
  }

  private failAllPending(error: Error): void {
    this.running?.controller.abort("cancelled");
    while (this.queue.length > 0) this.queue.shift()!.reject(error);
  }

  // -------------------------------------------------------------- plumbing

  private setStatus(status: WebMcpSessionStatus, detail?: string): void {
    this.status = status;
    this.statusDetail = detail;
    this.publish({
      type: "session",
      seq: this.nextSeq(),
      session: this.toPublic(),
    });
  }

  /**
   * A viewer's transport could not take a frame and dropped one.
   *
   * Forwarded straight to the provider, which owns the quality ladder, and
   * NOT treated as activity: a struggling link is not somebody using the
   * session, and ticking the idle clock from it would keep an abandoned tab
   * alive for as long as its network stayed bad.
   */
  noteFramePressure(): void {
    this.session?.noteFramePressure?.();
  }

  /** Re-publish the session (used when the registry moves its clocks). */
  publishSession(): void {
    this.publish({
      type: "session",
      seq: this.nextSeq(),
      session: this.toPublic(),
    });
  }

  /**
   * Publish one painted frame.
   *
   * Its own path rather than an activity entry, for two independent reasons.
   * A frame is not a protocol happening, so it does not belong on the timeline
   * or in an export — and `pushActivity` writes to the replay ring, which a
   * 10fps stream would empty of everything else within seconds.
   *
   * It also does NOT call `onActivity()`. A page with a CSS spinner paints
   * forever; ticking the idle clock from a paint would make every abandoned
   * animated page unreapable.
   */
  private publishFrame(frame: WebMcpFrame): void {
    this.publish({ type: "frame", seq: this.nextSeq(), frame });
  }

  private pushActivity(entry: WebMcpActivityDraft): void {
    this.publish({
      type: "activity",
      seq: this.nextSeq(),
      entry: {
        id: randomUUID(),
        ts: this.now(),
        ...entry,
      } as WebMcpActivityEntry,
    });
  }

  private publish(event: Parameters<WebMcpStreamHub["publish"]>[0]): void {
    this.hub.publish(event);
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  async close(): Promise<void> {
    this.failAllPending(new Error("The session was closed."));
    this.setStatus("closed");
    await this.session?.dispose().catch(() => {});
    // Awaited BEFORE the hub closes. `failAllPending` aborts the running
    // invocation, but its `settle` still has to publish the terminal entry, and
    // a closed hub would drop it on the floor.
    await this.draining_.catch(() => {});
    this.hub.close();
  }
}

function toRef(tool: WebMcpToolDescriptor): WebMcpToolRef {
  return {
    toolKey: tool.toolKey,
    name: tool.name,
    origin: tool.origin,
    fromSubframe: tool.fromSubframe,
  };
}

/**
 * Give every tool a stable key.
 *
 * `origin::name` is enough for the overwhelmingly common case and stays
 * readable in a URL, a chat transcript and a trace. Two frames of the SAME
 * origin registering the same name is the case it cannot express, so those get
 * a short frame-derived suffix — deterministic, so the key survives a reconnect
 * as long as the frame does.
 */
export function assignToolKeys(
  incoming: ProviderToolDescriptor[],
): (WebMcpToolDescriptor & { frameId: string })[] {
  const counts = new Map<string, number>();
  for (const tool of incoming) {
    const base = `${tool.origin}::${tool.name}`;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return incoming.map((tool) => {
    const base = `${tool.origin}::${tool.name}`;
    const collides = (counts.get(base) ?? 0) > 1;
    const toolKey = collides
      ? `${base}#${createHash("sha256").update(tool.frameId).digest("hex").slice(0, 4)}`
      : base;
    return {
      toolKey,
      name: tool.name,
      origin: tool.origin,
      fromSubframe: !tool.isMainFrame,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      registrationKind: tool.registrationKind,
      frameId: tool.frameId,
    };
  });
}
