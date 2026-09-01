/**
 * The provider's adaptation of the shared WebMCP bridge.
 *
 * The state machine itself is covered without a browser in
 * `browserd/daemon/__tests__/webmcp-bridge.test.ts`; what is covered HERE is
 * the seam — the vocabulary translation in both directions, which is the only
 * part of the unification that could break the inspector while every bridge
 * test kept passing.
 */
import { describe, expect, it } from "vitest";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { PlaywrightWebMcpSession } from "../playwright-provider";
import {
  WebMcpInvocationCancelledError,
  WebMcpToolGoneError,
  type ProviderToolDescriptor,
  type WebMcpSessionCallbacks,
} from "../provider";

const TOOL = {
  name: "book_flight",
  description: "Book a flight",
  frameId: "frame-main",
  backendNodeId: 7,
};

function harness(options: { onSend?: (method: string) => unknown } = {}) {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const sent: Array<{ method: string; params?: unknown }> = [];
  const cdp = {
    async send(method: string, params?: unknown) {
      sent.push({ method, params });
      return options.onSend?.(method) ?? {};
    },
    on(event: string, handler: (payload: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };

  const toolSnapshots: ProviderToolDescriptor[][] = [];
  const navigations: Array<{ url: string; origin: string }> = [];
  const external: Array<{ note: string; toolName?: string }> = [];

  const callbacks: WebMcpSessionCallbacks = {
    onToolsChanged: (tools) => toolSnapshots.push(tools),
    onNavigated: (url, origin) => navigations.push({ url, origin }),
    onPopupOpened: () => {},
    onExternalInvocation: (note, toolName) => external.push({ note, toolName }),
    onActivityObserved: () => {},
    onCrashed: () => {},
    onFrame: () => {},
  };

  const page = {
    on: () => {},
    goto: async () => {},
    url: () => "https://example.test/book",
    evaluate: async () => true,
    screenshot: async () => Buffer.from("s"),
  } as unknown as Page;

  const session = new PlaywrightWebMcpSession(
    { close: async () => {} } as unknown as Browser,
    { close: async () => {} } as unknown as BrowserContext,
    page,
    cdp as unknown as CDPSession,
    callbacks,
    "https://example.test/book",
    true,
  );

  return { session, emit, sent, toolSnapshots, navigations, external };
}

async function started(options?: Parameters<typeof harness>[0]) {
  const h = harness(options);
  await h.session.start("https://example.test/book");
  h.emit("Page.frameNavigated", {
    frame: { id: "frame-main", url: "https://example.test/book" },
  });
  return h;
}

/** Settle an invocation the way the browser would, once it is registered. */
async function respond(
  h: Awaited<ReturnType<typeof started>>,
  payload: Record<string, unknown>,
) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emit("WebMCP.toolResponded", { invocationId: "inv-1", ...payload });
}

const invokeArgs = {
  frameId: "frame-main",
  toolName: "book_flight",
  input: {},
};

describe("PlaywrightWebMcpSession — bridge adaptation", () => {
  it("publishes the bridge's snapshot as provider descriptors", async () => {
    const h = await started();
    h.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const latest = h.toolSnapshots.at(-1)!;
    expect(latest).toHaveLength(1);
    // The frame id is what the runtime resolves back to at invoke time, so a
    // snapshot without it is a snapshot nothing can be invoked from.
    expect(latest[0]).toMatchObject({
      frameId: "frame-main",
      name: "book_flight",
      description: "Book a flight",
      origin: "https://example.test",
      isMainFrame: true,
      registrationKind: "declarative",
    });
  });

  it("reports navigation before the tool snapshot from the same event", async () => {
    const h = await started();
    h.emit("WebMCP.toolsAdded", { tools: [TOOL] });
    const before = h.toolSnapshots.length;

    h.emit("Page.frameNavigated", {
      frame: { id: "frame-main", url: "https://example.test/other" },
    });

    // Ordering, not just presence: the timeline reads "navigated, then these
    // tools" and would read backwards if the bridge's handler ran first.
    expect(h.navigations.at(-1)).toEqual({
      url: "https://example.test/other",
      origin: "https://example.test",
    });
    expect(h.toolSnapshots.length).toBeGreaterThan(before);
    // Chromium fires no removal on navigation, so an empty snapshot here is the
    // bridge synthesizing it — the behaviour the inline copy existed to carry.
    expect(h.toolSnapshots.at(-1)).toEqual([]);
  });

  it("ignores a subframe navigation for the session's own URL", async () => {
    const h = await started();
    const before = h.navigations.length;
    h.emit("Page.frameNavigated", {
      frame: {
        id: "frame-sub",
        url: "https://ads.test/frame",
        parentId: "frame-main",
      },
    });
    // The session's URL is the MAIN frame's. An ad iframe navigating is not the
    // page moving.
    expect(h.navigations).toHaveLength(before);
    expect(h.session.currentUrl()).toBe("https://example.test/book");
  });

  it("surfaces an invocation nobody here started", async () => {
    const h = await started();
    h.emit("WebMCP.toolInvoked", {
      invocationId: "someone-else",
      toolName: "book_flight",
    });
    expect(h.external.at(-1)).toEqual({
      note: "A tool was invoked from outside this inspector.",
      toolName: "book_flight",
    });
  });

  it("unwraps the daemon's envelope to just the output", async () => {
    const h = await started({ onSend: () => ({ invocationId: "inv-1" }) });
    h.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = h.session.invokeTool({
      ...invokeArgs,
      signal: new AbortController().signal,
    });
    await respond(h, { status: "Completed", output: { seat: "14C" } });

    // The runtime already has its own handle for this call, so the bridge's
    // invocation id is dropped rather than travelling up as a second one.
    await expect(pending).resolves.toEqual({ output: { seat: "14C" } });
  });

  it("translates a gone tool into the error the routes turn into a 409", async () => {
    const h = await started({ onSend: () => ({ invocationId: "inv-1" }) });
    // Nothing was ever registered, so resolution finds no frame.
    await expect(
      h.session.invokeTool({
        ...invokeArgs,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(WebMcpToolGoneError);
  });

  it("carries WHY an invocation was cancelled", async () => {
    const h = await started({ onSend: () => ({ invocationId: "inv-1" }) });
    h.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const controller = new AbortController();
    const pending = h.session.invokeTool({
      ...invokeArgs,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort("cancelled");
    h.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Canceled",
    });

    await expect(pending).rejects.toMatchObject({
      name: "WebMcpInvocationCancelledError",
      reason: "cancelled",
    });
  });

  it("keeps a runtime timeout a TIMEOUT, not a user cancel", async () => {
    const h = await started({ onSend: () => ({ invocationId: "inv-1" }) });
    h.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const controller = new AbortController();
    const pending = h.session.invokeTool({
      ...invokeArgs,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The runtime is the single deadline owner and aborts with its reason. The
    // browser answers `Canceled` either way, so losing the reason here is what
    // records a hung tool as something the user chose to stop.
    controller.abort("timeout");
    h.emit("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Canceled",
    });

    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebMcpInvocationCancelledError);
    expect((error as WebMcpInvocationCancelledError).reason).toBe("timeout");
  });

  it("passes a page-side failure up with the page's own message", async () => {
    const h = await started({ onSend: () => ({ invocationId: "inv-1" }) });
    h.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = h.session.invokeTool({
      ...invokeArgs,
      signal: new AbortController().signal,
    });
    await respond(h, {
      status: "Error",
      exception: { description: "TypeError: seat is not a function\n  at x" },
    });

    // The first line only: a stack trace in the timeline is noise, and the
    // message is what a developer reads to find their own bug.
    await expect(pending).rejects.toThrow("TypeError: seat is not a function");
  });

  it("rejects an in-flight invocation when the session is disposed", async () => {
    const h = await started({ onSend: () => ({ invocationId: "inv-1" }) });
    h.emit("WebMCP.toolsAdded", { tools: [TOOL] });

    const pending = h.session.invokeTool({
      ...invokeArgs,
      signal: new AbortController().signal,
    });
    const assertion = expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.session.dispose();
    // A dead browser can never settle what is in flight; leaving the caller
    // waiting is the one outcome with no way out.
    await assertion;
  });

  it("fails a session on a browser with no WebMCP page API", async () => {
    const h = harness();
    Reflect.set(
      h.session as unknown as { page: { evaluate: unknown } },
      "page",
      {
        on: () => {},
        goto: async () => {},
        url: () => "u",
        evaluate: async () => false,
      },
    );
    // Detected at start(), so creating a session fails fast with an explanation
    // rather than succeeding into an empty tool list that looks like the page's
    // fault.
    await expect(h.session.start("https://example.test/book")).rejects.toThrow(
      /does not expose the WebMCP page API/i,
    );
  });

  it("reports a navigation failure as itself, not as 'unsupported'", async () => {
    const h = harness();
    Reflect.set(h.session as unknown as { page: unknown }, "page", {
      on: () => {},
      goto: async () => {
        throw new Error("net::ERR_CONNECTION_REFUSED at https://nope.test/");
      },
      url: () => "about:blank",
      evaluate: async () => true,
    });
    // The bridge treats a throwing probe as "unsupported", which is right for a
    // probe and wrong for a navigation: reporting a refused connection as a
    // browser capability problem sends someone chasing a bug they do not have.
    await expect(h.session.start("https://nope.test/")).rejects.toThrow(
      /ERR_CONNECTION_REFUSED/,
    );
  });
});
