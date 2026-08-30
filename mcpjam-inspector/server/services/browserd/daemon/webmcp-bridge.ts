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
 * fake CDP session — no Chromium required.
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
  name: string;
  description?: string;
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
  timer?: ReturnType<typeof setTimeout>;
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
  /** How long a page has to answer before we cancel it. */
  invocationTimeoutMs?: number;
  /** Grace for the browser's own `Canceled` after we ask it to stop. */
  cancelSettleGraceMs?: number;
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
  private readonly invocationTimeoutMs: number;
  private readonly cancelSettleGraceMs: number;
  private supported = false;
  private disposed = false;

  constructor(
    private readonly cdp: CdpLike,
    options: WebMcpBridgeOptions = {},
  ) {
    this.invocationTimeoutMs =
      options.invocationTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS;
    this.cancelSettleGraceMs =
      options.cancelSettleGraceMs ?? DEFAULT_CANCEL_SETTLE_GRACE_MS;
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
    await this.cdp.send("WebMCP.enable").catch(() => {});
    this.supported = await probeSupported().catch(() => false);
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
    });

    this.cdp.on("WebMCP.toolsRemoved", (payload) => {
      const { tools } = (payload ?? {}) as {
        tools?: Array<{ name: string; frameId: string }>;
      };
      for (const tool of tools ?? []) {
        this.tools.delete(this.key(tool.frameId, tool.name));
      }
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
    });

    this.cdp.on("Page.frameDetached", (payload) => {
      const { frameId } = (payload ?? {}) as { frameId?: string };
      if (!frameId) return;
      this.frames.delete(frameId);
      this.dropFrame(frameId);
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
    this.pending.delete(invocationId);
  }

  /** Resolve or reject a waiter from the page's response. */
  private deliver(waiter: PendingInvocation, responded: RespondedPayload): void {
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
      name: tool.name,
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
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

  /** Invoke a page tool and wait for the page's own response. */
  async invoke(args: {
    toolName: string;
    input: unknown;
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
    const frameId = this.resolveFrame(args.toolName);

    let invocationId: string;
    try {
      const result = (await this.cdp.send("WebMCP.invokeTool", {
        frameId,
        toolName: args.toolName,
        input: args.input,
      })) as { invocationId?: string };
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
        void Promise.resolve(
          this.cdp.send("WebMCP.cancelInvocation", { invocationId }),
        ).catch(() => {});
        // Settle even if the page never answers our cancel — a dead page must
        // not leave the caller waiting forever.
        waiter.timer = setTimeout(() => {
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

      waiter.timer = setTimeout(
        () => cancel("timeout"),
        this.invocationTimeoutMs,
      );
      args.signal?.addEventListener("abort", () => cancel("cancelled"), {
        once: true,
      });
      // The listener is registered only after `invokeTool` resolved, so an
      // abort during that round trip has already fired and would never reach
      // it — leaving the page running a tool nobody will cancel.
      if (args.signal?.aborted) cancel("cancelled");
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
