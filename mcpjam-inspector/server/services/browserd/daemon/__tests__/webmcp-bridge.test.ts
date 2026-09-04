/**
 * The WebMCP bridge against a FAKE CDP session — every behavior the local
 * inspector learned the hard way, pinned without a browser:
 *
 *   - navigation fires no `toolsRemoved` and the main frame keeps its id, so
 *     the bridge must drop the navigated frame's tools itself;
 *   - the browser answers every cancel `Canceled`, so WHY we cancelled is
 *     remembered locally (a timeout must not be reported as a user cancel);
 *   - a cancel the page never answers still settles.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WebMcpBridge,
  WebMcpBridgeError,
  type CdpLike,
} from "../webmcp-bridge";

/** A fake CDP session: records sends, lets a test emit events. */
function fakeCdp(over?: {
  onSend?: (method: string, params?: Record<string, unknown>) => unknown;
}) {
  const handlers = new Map<string, (payload: unknown) => void>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const cdp: CdpLike = {
    async send(method, params) {
      sent.push({ method, params });
      return over?.onSend?.(method, params) ?? {};
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  return {
    cdp,
    sent,
    emit(event: string, payload: unknown) {
      handlers.get(event)?.(payload);
    },
  };
}

const TOOL = {
  name: "book_flight",
  description: "Book a flight",
  frameId: "frame-main",
  backendNodeId: 7,
};

async function started(
  fake: ReturnType<typeof fakeCdp>,
  options?: ConstructorParameters<typeof WebMcpBridge>[1],
  supported = true,
) {
  const bridge = new WebMcpBridge(fake.cdp, options);
  await bridge.start(async () => supported);
  // A main-frame navigation is what establishes main-frame identity.
  fake.emit("Page.frameNavigated", {
    frame: { id: "frame-main", url: "https://example.com/book" },
  });
  return bridge;
}

describe("WebMcpBridge — discovery", () => {
  it("enables the domains and probes support IN THE PAGE, not via the domain", async () => {
    const fake = fakeCdp();
    const probe = vi.fn(async () => true);
    const bridge = new WebMcpBridge(fake.cdp);
    await bridge.start(probe);
    expect(fake.sent.map((s) => s.method)).toEqual([
      "Page.enable",
      "WebMCP.enable",
    ]);
    // `WebMCP.enable` resolves even where the feature is off — the page probe
    // is the only real signal.
    expect(probe).toHaveBeenCalled();
    expect(bridge.isSupported()).toBe(true);
  });

  it("still runs the callback when the WebMCP domain is unavailable", async () => {
    const fake = fakeCdp({
      onSend: (method) => {
        if (method === "WebMCP.enable") {
          throw new Error("Protocol error: 'WebMCP.enable' wasn't found");
        }
        return {};
      },
    });
    const probe = vi.fn(async () => true);
    const bridge = new WebMcpBridge(fake.cdp);
    await bridge.start(probe);

    // The callback is not only a probe — it is the caller's one hook for work
    // that must happen between the domains being enabled and the page being
    // asked about itself, and the inspector NAVIGATES there. Short-circuiting
    // it on a browser without the domain leaves the page on `about:blank`,
    // which an embedded session then streams, under an error that says the
    // page loaded normally.
    expect(probe).toHaveBeenCalled();
    // Unsupported all the same: both halves have to hold.
    expect(bridge.isSupported()).toBe(false);
  });

  it("reports unsupported when the page API is absent", async () => {
    const fake = fakeCdp();
    const bridge = await started(fake, undefined, false);
    expect(bridge.isSupported()).toBe(false);
    await expect(
      bridge.invoke({ toolName: "anything", input: {} }),
    ).rejects.toMatchObject({ failure: "webmcp_unsupported" });
  });

  it("tracks added and removed tools, with origin and registration kind", async () => {
    const fake = fakeCdp();
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    expect(bridge.list()).toEqual([
      expect.objectContaining({
        name: "book_flight",
        origin: "https://example.com",
        isMainFrame: true,
        // backendNodeId present ⇒ declarative registration.
        registrationKind: "declarative",
      }),
    ]);

    fake.emit("WebMCP.toolsRemoved", {
      tools: [{ name: "book_flight", frameId: "frame-main" }],
    });
    expect(bridge.list()).toEqual([]);
  });

  it("labels an imperative registration, which is why annotations are not trusted", async () => {
    const fake = fakeCdp();
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", {
      tools: [
        {
          name: "imperative_tool",
          frameId: "frame-main",
          stackTrace: { callFrames: [] },
          annotations: { readOnly: true },
        },
      ],
    });
    expect(bridge.list()[0].registrationKind).toBe("imperative");
  });

  it("drops a frame's tools on navigation — the browser never says to", async () => {
    const fake = fakeCdp();
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });
    expect(bridge.list()).toHaveLength(1);

    // Same frame id, new page: no toolsRemoved arrives, so a bridge that
    // trusted the browser would keep serving the old page's tools.
    fake.emit("Page.frameNavigated", {
      frame: { id: "frame-main", url: "https://example.com/other" },
    });
    expect(bridge.list()).toHaveLength(0);
  });

  it("drops a detached subframe's tools", async () => {
    const fake = fakeCdp();
    const bridge = await started(fake);
    fake.emit("Page.frameNavigated", {
      frame: {
        id: "frame-child",
        url: "https://widget.example",
        parentId: "frame-main",
      },
    });
    fake.emit("WebMCP.toolsAdded", {
      tools: [{ name: "child_tool", frameId: "frame-child" }],
    });
    expect(bridge.list()).toHaveLength(1);
    expect(bridge.list()[0].isMainFrame).toBe(false);

    fake.emit("Page.frameDetached", { frameId: "frame-child" });
    expect(bridge.list()).toHaveLength(0);
  });
});

describe("WebMcpBridge — invocation", () => {
  it("resolves with the page's output", async () => {
    const fake = fakeCdp({
      onSend: (method) =>
        method === "WebMCP.invokeTool" ? { invocationId: "inv-1" } : {},
    });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = bridge.invoke({
      toolName: "book_flight",
      input: { seat: "12A" },
    });
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Completed",
      output: { confirmation: "ABC123" },
    });
    await expect(pending).resolves.toEqual({
      invocationId: "inv-1",
      output: { confirmation: "ABC123" },
    });
    expect(
      fake.sent.find((s) => s.method === "WebMCP.invokeTool")?.params,
    ).toMatchObject({ frameId: "frame-main", toolName: "book_flight" });
  });

  it("prefers the main frame when two frames offer the same name", async () => {
    const fake = fakeCdp({
      onSend: () => ({ invocationId: "inv-1" }),
    });
    const bridge = await started(fake);
    fake.emit("Page.frameNavigated", {
      frame: {
        id: "frame-child",
        url: "https://widget.example",
        parentId: "frame-main",
      },
    });
    fake.emit("WebMCP.toolsAdded", {
      tools: [
        { name: "shared", frameId: "frame-child" },
        { name: "shared", frameId: "frame-main" },
      ],
    });

    const pending = bridge.invoke({ toolName: "shared", input: {} });
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Completed",
      output: null,
    });
    await pending;
    expect(
      fake.sent.find((s) => s.method === "WebMCP.invokeTool")?.params?.frameId,
    ).toBe("frame-main");
  });

  it("reports a gone tool distinctly — before and at the CDP call", async () => {
    const fake = fakeCdp({
      onSend: (method) => {
        if (method === "WebMCP.invokeTool") {
          throw new Error("Tool not found: vanished");
        }
        return {};
      },
    });
    const bridge = await started(fake);

    // Not in the registry at all.
    await expect(
      bridge.invoke({ toolName: "never_existed", input: {} }),
    ).rejects.toMatchObject({ failure: "webmcp_tool_gone" });

    // In the registry, but the browser rejects the call.
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });
    await expect(
      bridge.invoke({ toolName: "book_flight", input: {} }),
    ).rejects.toMatchObject({ failure: "webmcp_tool_gone" });
  });

  it("surfaces a page-side throw with its message", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = bridge.invoke({ toolName: "book_flight", input: {} });
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Error",
      exception: { description: "TypeError: seat is not a string\n  at book" },
    });
    await expect(pending).rejects.toMatchObject({
      failure: "webmcp_error",
      message: "TypeError: seat is not a string",
    });
  });

  it("distinguishes a TIMEOUT from a user cancel, though the browser says only 'Canceled'", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
      const bridge = await started(fake, { invocationTimeoutMs: 1_000 });
      fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

      const pending = bridge.invoke({ toolName: "book_flight", input: {} });
      const assertion = expect(pending).rejects.toMatchObject({
        failure: "webmcp_cancelled",
        cancelReason: "timeout",
      });
      await vi.advanceTimersByTimeAsync(1_001);
      // The browser's answer is the same word for both reasons — the bridge's
      // own memory is what makes the trace honest.
      fake.emit("WebMCP.toolResponded", {
        invocationId: "inv-1",
        status: "Canceled",
      });
      await assertion;
      expect(
        fake.sent.some((s) => s.method === "WebMCP.cancelInvocation"),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves NO timer behind after an aborted invocation settles", async () => {
    // The abort path used to overwrite the invocation deadline's handle with
    // the cancel-grace handle, so the deadline timer was never cleared: a
    // no-op timer stayed scheduled for its full duration, holding the event
    // loop open and out of reach of both settle() and dispose().
    vi.useFakeTimers();
    try {
      const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
      const bridge = await started(fake, {
        invocationTimeoutMs: 60_000,
        cancelSettleGraceMs: 100,
      });
      fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

      const controller = new AbortController();
      const pending = bridge.invoke({
        toolName: "book_flight",
        input: {},
        signal: controller.signal,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        failure: "webmcp_cancelled",
      });
      controller.abort();
      await vi.advanceTimersByTimeAsync(101); // the grace timer settles it
      await assertion;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles even when the page never answers the cancel", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
      const bridge = await started(fake, {
        invocationTimeoutMs: 1_000,
        cancelSettleGraceMs: 500,
      });
      fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

      const pending = bridge.invoke({ toolName: "book_flight", input: {} });
      const assertion = expect(pending).rejects.toMatchObject({
        failure: "webmcp_cancelled",
      });
      await vi.advanceTimersByTimeAsync(1_001); // timeout fires the cancel
      await vi.advanceTimersByTimeAsync(501); // page never responds
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an invocation aborted before the CDP round trip returned", async () => {
    const controller = new AbortController();
    const fake = fakeCdp({
      onSend: (method) => {
        if (method === "WebMCP.invokeTool") {
          // Abort DURING the round trip: the listener below is attached only
          // after this resolves, so without the re-check nothing cancels.
          controller.abort();
        }
        return { invocationId: "inv-1" };
      },
    });
    const bridge = await started(fake, { cancelSettleGraceMs: 1 });
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    await expect(
      bridge.invoke({
        toolName: "book_flight",
        input: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      failure: "webmcp_cancelled",
      cancelReason: "cancelled",
    });
    expect(fake.sent.some((s) => s.method === "WebMCP.cancelInvocation")).toBe(
      true,
    );
  });

  it("ignores a response for an invocation it never started", async () => {
    const fake = fakeCdp();
    await started(fake);
    // A devtools panel or the page's own agent can invoke tools too; an
    // unknown response must not throw or settle anything of ours.
    expect(() =>
      fake.emit("WebMCP.toolResponded", {
        invocationId: "someone-else",
        status: "Completed",
      }),
    ).not.toThrow();
  });

  it("rejects in-flight invocations on dispose", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = bridge.invoke({ toolName: "book_flight", input: {} });
    const assertion = expect(pending).rejects.toBeInstanceOf(WebMcpBridgeError);
    // Let `invokeTool`'s round trip resolve so the invocation is registered —
    // in production a dispose arrives as its own task, never inside the send.
    await Promise.resolve();
    bridge.dispose();
    await assertion;
  });

  it("refuses a new invocation after dispose", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });
    bridge.dispose();
    await expect(
      bridge.invoke({ toolName: "book_flight", input: {} }),
    ).rejects.toMatchObject({ failure: "webmcp_cancelled" });
  });

  it("cancel() reports whether it knew the invocation", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    expect(await bridge.cancel("never-heard-of-it")).toBe(false);

    const pending = bridge.invoke({ toolName: "book_flight", input: {} });
    const assertion = expect(pending).rejects.toMatchObject({
      cancelReason: "cancelled",
    });
    // As above: a `webmcp_cancel` command is its own task, so the invocation
    // it names is already registered by the time it runs.
    await Promise.resolve();
    expect(await bridge.cancel("inv-1")).toBe(true);
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Canceled",
    });
    await assertion;
  });
});

describe("WebMcpBridge — the push channel", () => {
  it("announces the COMPLETE set on every change, never a delta", async () => {
    const fake = fakeCdp();
    const snapshots: Array<Array<{ name: string }>> = [];
    const bridge = new WebMcpBridge(fake.cdp, {
      onChange: (tools) => snapshots.push(tools.map(({ name }) => ({ name }))),
    });
    await bridge.start(async () => true);
    fake.emit("Page.frameNavigated", {
      frame: { id: "frame-main", url: "https://example.com/book" },
    });

    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });
    fake.emit("WebMCP.toolsAdded", {
      tools: [{ ...TOOL, name: "cancel_flight" }],
    });
    fake.emit("WebMCP.toolsRemoved", {
      tools: [{ name: "book_flight", frameId: "frame-main" }],
    });

    // A consumer stitching deltas would serve tools from the previous page
    // forever, because navigation fires no removal at all. A snapshot is
    // correct on arrival no matter what its consumer missed.
    expect(snapshots.map((snapshot) => snapshot.map((t) => t.name))).toEqual([
      // the navigation that established main-frame identity
      [],
      ["book_flight"],
      ["book_flight", "cancel_flight"],
      ["cancel_flight"],
    ]);
    expect(bridge.list().map((tool) => tool.name)).toEqual(["cancel_flight"]);
  });

  it("announces the empty set when a navigation takes the tools away", async () => {
    const fake = fakeCdp();
    const snapshots: string[][] = [];
    const bridge = new WebMcpBridge(fake.cdp, {
      onChange: (tools) => snapshots.push(tools.map((tool) => tool.name)),
    });
    await bridge.start(async () => true);
    fake.emit("Page.frameNavigated", {
      frame: { id: "frame-main", url: "https://example.com/book" },
    });
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    fake.emit("Page.frameNavigated", {
      frame: { id: "frame-main", url: "https://example.com/other" },
    });
    // The push channel is what makes the polling provider's lag go away — but
    // only if the DISAPPEARANCE is pushed too.
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("survives a throwing subscriber", async () => {
    const fake = fakeCdp();
    const bridge = new WebMcpBridge(fake.cdp, {
      onChange: () => {
        throw new Error("consumer exploded");
      },
    });
    await bridge.start(async () => true);
    // The subscriber is a consumer's reaction to a browser event; letting it
    // escape would take down the handler doing the bridge's own bookkeeping.
    expect(() =>
      fake.emit("WebMCP.toolsAdded", { tools: [TOOL] }),
    ).not.toThrow();
    expect(bridge.list()).toHaveLength(1);
  });
});

describe("WebMcpBridge — descriptors", () => {
  it("carries the frame id and always a description", async () => {
    const fake = fakeCdp();
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", {
      tools: [TOOL, { name: "nameless", frameId: "frame-main" }],
    });

    const [book, nameless] = bridge.list();
    // Without a frame id a consumer cannot tell two same-named tools apart at
    // all — which is how the hosted provider's parser came to drop every tool.
    expect(book.frameId).toBe("frame-main");
    expect(book.description).toBe("Book a flight");
    // Empty string, not undefined: every consumer has to render something, and
    // an optional field is three different placeholder strings for one absence.
    expect(nameless.description).toBe("");
  });
});

describe("WebMcpBridge — explicit frame", () => {
  it("invokes in the frame the caller names, not the resolved one", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", {
      tools: [TOOL, { ...TOOL, frameId: "frame-sub" }],
    });

    const pending = bridge.invoke({
      toolName: "book_flight",
      frameId: "frame-sub",
      input: {},
    });
    await Promise.resolve();
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Completed",
      output: { ok: true },
    });
    await pending;

    // Name resolution prefers the MAIN frame, so a subframe's tool would
    // otherwise be shadowed by a same-named one the caller never listed.
    const invoke = fake.sent.find((s) => s.method === "WebMCP.invokeTool");
    expect(invoke?.params?.frameId).toBe("frame-sub");
  });

  it("falls back to resolution when the named frame is gone", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = bridge.invoke({
      toolName: "book_flight",
      // A frame the caller listed a moment ago and that has since detached.
      frameId: "frame-that-detached",
      input: {},
    });
    await Promise.resolve();
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Completed",
      output: {},
    });
    await pending;

    // Sending a stale id to the browser would fail obscurely; resolving is what
    // the caller wanted anyway.
    expect(
      fake.sent.find((s) => s.method === "WebMCP.invokeTool")?.params?.frameId,
    ).toBe("frame-main");
  });
});

describe("WebMcpBridge — timeout ownership", () => {
  it("arms NO internal deadline when the caller supplies a signal", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
      const bridge = await started(fake, { invocationTimeoutMs: 10 });
      fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

      const controller = new AbortController();
      const pending = bridge.invoke({
        toolName: "book_flight",
        input: {},
        signal: controller.signal,
      });
      pending.catch(() => {});
      await Promise.resolve();

      // Well past the bridge's own deadline. Two deadlines on one invocation
      // means whichever fires first names the failure, and the caller's is the
      // one the user reads.
      vi.advanceTimersByTime(1_000);
      expect(
        fake.sent.some((s) => s.method === "WebMCP.cancelInvocation"),
      ).toBe(false);

      controller.abort("cancelled");
      await Promise.resolve();
      expect(
        fake.sent.some((s) => s.method === "WebMCP.cancelInvocation"),
      ).toBe(true);
      fake.emit("WebMCP.toolResponded", {
        invocationId: "inv-1",
        status: "Canceled",
      });
      await expect(pending).rejects.toMatchObject({
        cancelReason: "cancelled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the cancel reason from the signal, so a caller timeout is a timeout", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const controller = new AbortController();
    const pending = bridge.invoke({
      toolName: "book_flight",
      input: {},
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort("timeout");
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Canceled",
    });

    // Naive adoption reports every caller-side timeout as a user cancellation —
    // the exact bug both docstrings warn about.
    await expect(pending).rejects.toMatchObject({
      failure: "webmcp_cancelled",
      cancelReason: "timeout",
    });
  });

  it("still owns the deadline when no signal is given", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
      const bridge = await started(fake, {
        invocationTimeoutMs: 10,
        cancelSettleGraceMs: 5,
      });
      fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

      const pending = bridge.invoke({ toolName: "book_flight", input: {} });
      const assertion = expect(pending).rejects.toMatchObject({
        cancelReason: "timeout",
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WebMcpBridge — pre-flight abort", () => {
  it("never starts a tool for an invocation the caller already cancelled", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const controller = new AbortController();
    controller.abort("cancelled");
    await expect(
      bridge.invoke({
        toolName: "book_flight",
        input: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ cancelReason: "cancelled" });

    // A queued invocation whose caller gave up must not mutate the page and
    // then be cancelled a moment later.
    expect(fake.sent.some((s) => s.method === "WebMCP.invokeTool")).toBe(false);
  });

  it("reports a pre-flight timeout as a timeout", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const bridge = await started(fake);
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const controller = new AbortController();
    controller.abort("timeout");
    await expect(
      bridge.invoke({
        toolName: "book_flight",
        input: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ cancelReason: "timeout" });
  });
});

describe("WebMcpBridge — external invocations", () => {
  it("reports a tool this bridge did not start", async () => {
    const fake = fakeCdp();
    const external: string[] = [];
    const bridge = new WebMcpBridge(fake.cdp, {
      onExternalInvocation: (name) => external.push(name),
    });
    await bridge.start(async () => true);

    fake.emit("WebMCP.toolInvoked", {
      invocationId: "someone-else",
      toolName: "book_flight",
    });
    // It explains state changes the timeline would otherwise attribute to
    // nothing at all.
    expect(external).toEqual(["book_flight"]);
  });

  it("does not report our OWN invocation as external", async () => {
    const fake = fakeCdp({ onSend: () => ({ invocationId: "inv-1" }) });
    const external: string[] = [];
    const bridge = new WebMcpBridge(fake.cdp, {
      onExternalInvocation: (name) => external.push(name),
    });
    await bridge.start(async () => true);
    fake.emit("Page.frameNavigated", {
      frame: { id: "frame-main", url: "https://example.com/book" },
    });
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = bridge.invoke({ toolName: "book_flight", input: {} });
    await Promise.resolve();
    fake.emit("WebMCP.toolInvoked", {
      invocationId: "inv-1",
      toolName: "book_flight",
    });
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Completed",
      output: {},
    });
    await pending;
    expect(external).toEqual([]);
  });

  it("stays quiet while one of our own sends is still outstanding", async () => {
    // The reply carrying our invocation id has not come back yet, so an unknown
    // id is genuinely ambiguous. A false "someone else drove your page" misleads
    // whoever reads the timeline; a missed note is a gap in an advisory one.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeCdp({
      onSend: (method) =>
        method === "WebMCP.invokeTool"
          ? gate.then(() => ({ invocationId: "inv-1" }))
          : {},
    });
    const external: string[] = [];
    const bridge = new WebMcpBridge(fake.cdp, {
      onExternalInvocation: (name) => external.push(name),
    });
    await bridge.start(async () => true);
    fake.emit("Page.frameNavigated", {
      frame: { id: "frame-main", url: "https://example.com/book" },
    });
    fake.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = bridge.invoke({ toolName: "book_flight", input: {} });
    await Promise.resolve();
    fake.emit("WebMCP.toolInvoked", {
      invocationId: "inv-1",
      toolName: "book_flight",
    });
    expect(external).toEqual([]);

    // Let the gated reply land and the invocation register, then settle it
    // normally: the point is that nothing was reported while it was in doubt.
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Completed",
      output: {},
    });
    await pending;
    expect(external).toEqual([]);
  });
});
