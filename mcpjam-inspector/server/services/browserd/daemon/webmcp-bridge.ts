/**
 * The WebMCP half of the daemon: page-registered tools, discovered and invoked
 * over Chrome's experimental `WebMCP` CDP domain.
 *
 * This is the cooperation layer, not the drive mechanism — `navigate`/`act`/
 * `observe` are how browserd gets work done; `webmcp_*` is the bonus when a
 * page chooses to expose structured tools. The state machine is ported from
 * the local inspector's `webmcp-inspector/playwright-provider.ts` (the only
 * other module that speaks this domain) and keeps its hard-won behaviors:
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
 * Written against an injected `CdpLike`, so all of it is unit-testable with a
 * fake CDP session — no Chromium required. That zero-import design is also what
 * lets it be the SINGLE copy of this machine: the local inspector's
 * `webmcp-inspector/playwright-provider.ts` instantiates it too, because
 * Playwright's `CDPSession` satisfies `CdpLike` structurally.
 *
 * That import direction — inspector reaching into `browserd/daemon/` — is
 * deliberate but temporary. This file has no imports at all, so the eventual
 * move into a shared `webmcp-runtime/` package consumed by both is a file move
 * and nothing else. Anyone doing that extraction should move this rather than
 * inverting the dependency in place.
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
   * How the page registered it. Load-bearing for approval reasoning:
   * Chromium 151 does not carry `annotations` through for IMPERATIVE
   * registrations, so a `readOnly: false` on one of those is the absence of a
   * signal, not a claim — which is exactly why the approval classifier does
   * not trust page annotations at all.
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

export interface WebMcpBridgeOptions {
  /**
   * How long a page has to answer before we cancel it.
   *
   * Only used for an invocation with NO `signal`. A caller that supplies one
   * owns the deadline — see {@link WebMcpBridge.invoke}.
   */
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
  /** Tools keyed `${frameId} ${name}` — the browser's own notion of identity. */
  private readonly tools = new Map<string, WebMcpCdpTool>();
  /** frameId → last known URL, for origin labelling. */
  private readonly frames = new Map<string, string>();
  private readonly pending = new Map<string, PendingInvocation>();
  /** Responses that arrived before their invocation was registered. */
  private readonly earlyResponses = new Map<string, RespondedPayload>();
  private mainFrameId = "";
  /** `WebMCP.invokeTool` calls whose reply has not come back yet. See `wire`. */
  private outstandingSends = 0;
  private readonly invocationTimeoutMs: number;
  private readonly cancelSettleGraceMs: number;
  private supported = false;
  private disposed = false;

  private readonly onChange:
    ((tools: WebMcpToolDescriptor[]) => void) | undefined;
  private readonly onExternalInvocation:
    ((toolName: string) => void) | undefined;

  constructor(
    private readonly cdp: CdpLike,
    options: WebMcpBridgeOptions = {},
  ) {
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
    if (!this.onChange) return;
    try {
      this.onChange(this.list());
    } catch {
      /* ignore */
    }
  }

  /**
   * Enable the domains and wire the events. `probeSupported` is the page-side
   * check for `document.modelContext`: `WebMCP.enable` RESOLVES even on a
   * browser with the feature off (it just never reports a tool), so the domain
   * is never the probe.
   */
  async start(probeSupported: () => Promise<boolean>): Promise<void> {
    this.wire();
    await this.cdp.send("Page.enable").catch(() => {});
    // BOTH halves have to hold. The page probe alone would accept a browser
    // that exposes `document.modelContext` while the CDP domain is unavailable
    // — a session that can never be told about a tool, reported as healthy and
    // showing an empty registry that looks like the page's fault.
    let domainEnabled = true;
    await this.cdp.send("WebMCP.enable").catch(() => {
      domainEnabled = false;
    });
    this.supported =
      domainEnabled && (await probeSupported().catch(() => false));
  }

  isSupported(): boolean {
    return this.supported;
  }

  private wire(): void {
    this.cdp.on("WebMCP.toolsAdded", (payload) => {
      const { tools } = (payload ?? {}) as { tools?: WebMcpCdpTool[] };
      for (const tool of tools ?? []) {
        this.tools.set(this.key(tool.frameId, tool.name), tool);
      }
      this.announce();
    });

    this.cdp.on("WebMCP.toolsRemoved", (payload) => {
      const { tools } = (payload ?? {}) as {
        tools?: Array<{ name: string; frameId: string }>;
      };
      for (const tool of tools ?? []) {
        this.tools.delete(this.key(tool.frameId, tool.name));
      }
      this.announce();
    });

    this.cdp.on("WebMCP.toolInvoked", (payload) => {
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
    });

    this.cdp.on("WebMCP.toolResponded", (payload) => {
      const responded = (payload ?? {}) as RespondedPayload;
      const id = responded.invocationId;
      if (!id) return;
      const waiter = this.pending.get(id);
      if (!waiter) {
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

    this.cdp.on("Page.frameNavigated", (payload) => {
      const { frame } = (payload ?? {}) as {
        frame?: { id: string; url: string; parentId?: string };
      };
      if (!frame) return;
      this.frames.set(frame.id, frame.url);
      // Navigation fires NO toolsRemoved and the main frame KEEPS its id, so
      // nothing the browser says separates "tools of the page we left" from
      // "tools of the page we are on". Dropping them here is what stops the
      // registry serving tools that no longer exist.
      this.dropFrame(frame.id);
      if (!frame.parentId) this.mainFrameId = frame.id;
      this.announce();
    });

    this.cdp.on("Page.frameDetached", (payload) => {
      const { frameId } = (payload ?? {}) as { frameId?: string };
      if (!frameId) return;
      this.frames.delete(frameId);
      this.dropFrame(frameId);
      this.announce();
    });
  }

  private key(frameId: string, name: string): string {
    return `${frameId} ${name}`;
  }

  private dropFrame(frameId: string): void {
    for (const key of [...this.tools.keys()]) {
      if (key.startsWith(`${frameId} `)) this.tools.delete(key);
    }
  }

  private settle(invocationId: string): void {
    const waiter = this.pending.get(invocationId);
    if (waiter?.timer) clearTimeout(waiter.timer);
    if (waiter?.cancelTimer) clearTimeout(waiter.cancelTimer);
    this.pending.delete(invocationId);
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
          "webmcp_cancelled",
          reason === "timeout"
            ? "The page tool did not respond in time."
            : "The invocation was cancelled.",
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
    return [...this.tools.values()].map((tool) => ({
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
    for (const tool of this.tools.values()) {
      if (tool.name === toolName && tool.frameId === this.mainFrameId) {
        return tool.frameId;
      }
    }
    for (const tool of this.tools.values()) {
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
  private frameFor(frameId: string | undefined, toolName: string): string {
    if (frameId && this.tools.has(this.key(frameId, toolName))) return frameId;
    return this.resolveFrame(toolName);
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
    const frameId = this.frameFor(args.frameId, args.toolName);

    let invocationId: string;
    try {
      // Counted around the await with try/finally rather than a `.finally()`
      // on the promise: chaining would insert an extra microtask between the
      // browser's reply and this invocation being registered as pending, and a
      // dispose or a response landing in that gap would find nothing to settle.
      this.outstandingSends += 1;
      let result: { invocationId?: string };
      try {
        result = (await this.cdp.send("WebMCP.invokeTool", {
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
      const waiter: PendingInvocation = { resolve, reject };
      // Claim a response that beat `invokeTool`'s own reply here — otherwise
      // an instant tool would be waited out to the full timeout.
      const early = this.earlyResponses.get(invocationId);
      if (early) {
        this.earlyResponses.delete(invocationId);
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
          this.cdp.send("WebMCP.cancelInvocation", { invocationId }),
        ).catch(() => {});
        // Settle even if the page never answers our cancel — a dead page must
        // not leave the caller waiting forever.
        waiter.cancelTimer = setTimeout(() => {
          if (!this.pending.has(invocationId)) return;
          this.pending.delete(invocationId);
          reject(
            new WebMcpBridgeError(
              "webmcp_cancelled",
              reason === "timeout"
                ? "The page tool did not respond in time."
                : "The invocation was cancelled.",
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
    await Promise.resolve(
      this.cdp.send("WebMCP.cancelInvocation", { invocationId }),
    ).catch(() => {});
    return Boolean(waiter);
  }

  /** Reject every waiter; called when the tab or daemon goes away. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, waiter] of this.pending) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.cancelTimer) clearTimeout(waiter.cancelTimer);
      waiter.reject(
        new WebMcpBridgeError(
          "webmcp_cancelled",
          "The browser tab was closed.",
          "cancelled",
        ),
      );
      this.pending.delete(id);
    }
  }
}
