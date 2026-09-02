import { describe, expect, it, vi } from "vitest";
import { createBrowserdWebMcpProvider } from "../browserd-provider";
import { WebMcpBridge } from "../../browserd/daemon/webmcp-bridge";
import type { BrowserSessionHandle } from "../../browserd/browser-session";
import type { BrowserCommand } from "../../browserd/protocol";
import type {
  ProviderToolDescriptor,
  WebMcpSessionCallbacks,
} from "../provider";

const HANDLE = {
  sessionId: "sessions_1",
  computerId: "computers_1",
  bootId: "boot-1",
  client: {} as never,
  streamUrl: "https://box-6080.e2b.dev/vnc.html",
  streamPassword: "pw",
  contextMode: "persistent",
  reused: true,
} as BrowserSessionHandle;

type Reply = { status: string; result?: any; bootId: string };

function build(
  replyFor: (command: BrowserCommand) => Reply = () => ({
    status: "ok",
    result: { ok: true, output: {} },
    bootId: "boot-1",
  }),
) {
  const commands: BrowserCommand[] = [];
  const sendCommand = vi.fn(async (command: BrowserCommand) => {
    commands.push(command);
    return replyFor(command);
  });
  const toolSets: ProviderToolDescriptor[][] = [];
  const navigations: string[] = [];
  const callbacks: WebMcpSessionCallbacks = {
    onToolsChanged: (tools) => toolSets.push(tools),
    onNavigated: (url) => navigations.push(url),
    onPopupOpened: () => {},
    onExternalInvocation: () => {},
    onActivityObserved: () => {},
    onCrashed: () => {},
    onFrame: () => {},
  };
  const provider = createBrowserdWebMcpProvider({
    handle: HANDLE,
    transportFor: () => ({ sendCommand }) as never,
    toolPollMs: 0, // no background polling in tests
  });
  return { provider, commands, toolSets, navigations, callbacks, sendCommand };
}

const withTools =
  (tools: unknown[]) =>
  (command: BrowserCommand): Reply => {
    const action = command.action as any;
    if (action.kind === "observe" && action.mode === "webmcp_tools") {
      return {
        status: "ok",
        result: { ok: true, output: { tools } },
        bootId: "b",
      };
    }
    return { status: "ok", result: { ok: true, output: {} }, bootId: "b" };
  };

describe("browserd WebMCP provider", () => {
  it("reports a REMOTE viewport, not a window on the viewer's machine", async () => {
    // The one claim that would be actively wrong: this browser is in a
    // datacenter, and the UI decides what to render from this value.
    const { provider, callbacks } = build();
    const session = await provider.createSession({
      url: "https://x.test/",
      callbacks,
    });
    expect(session.viewportTransport()).toEqual({
      kind: "remote-interactive-url",
      url: HANDLE.streamUrl,
    });
  });

  it("navigates on creation and reports the URL", async () => {
    const { provider, callbacks, commands, navigations } = build();
    const session = await provider.createSession({
      url: "https://x.test/",
      callbacks,
    });
    expect(commands[0].action).toMatchObject({
      kind: "navigate",
      url: "https://x.test/",
    });
    expect(commands[0].source).toBe("inspector");
    expect(navigations).toEqual(["https://x.test/"]);
    expect(session.currentUrl()).toBe("https://x.test/");
  });

  it("reports the COMPLETE tool set, and only when it changes", async () => {
    // Snapshot semantics are what makes a missed event harmless: a provider
    // forwarding deltas would advertise a tool from the previous page forever.
    const tools = [
      {
        frameId: "f1",
        name: "search",
        description: "d",
        origin: "https://x.test",
        isMainFrame: true,
      },
    ];
    const { provider, callbacks, toolSets } = build(withTools(tools));
    const session = await provider.createSession({
      url: "https://x.test/",
      callbacks,
    });
    expect(toolSets).toHaveLength(1);
    expect(toolSets[0]).toEqual([
      {
        frameId: "f1",
        name: "search",
        description: "d",
        origin: "https://x.test",
        isMainFrame: true,
        registrationKind: "unknown",
      },
    ]);

    // Same set → no second callback.
    await session.reload();
    expect(toolSets).toHaveLength(1);
  });

  it("can parse what the DAEMON's own bridge actually reports", async () => {
    // A contract test across the seam, using the real bridge's output rather
    // than a fixture of what we hope it says. The fixtures above all invent a
    // `frameId`, and the daemon's `list()` did not report one — so this parser
    // silently dropped EVERY hosted tool while every test above passed.
    const handlers = new Map<string, (payload: unknown) => void>();
    const bridge = new WebMcpBridge({
      async send() {
        return {};
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    });
    await bridge.start(async () => true);
    handlers.get("Page.frameNavigated")?.({
      frame: { id: "f1", url: "https://x.test/" },
    });
    handlers.get("WebMCP.toolsAdded")?.({
      tools: [{ name: "search", description: "d", frameId: "f1" }],
    });

    const { provider, callbacks, toolSets } = build(withTools(bridge.list()));
    await provider.createSession({ url: "https://x.test/", callbacks });

    expect(toolSets[0]).toHaveLength(1);
    expect(toolSets[0][0]).toMatchObject({
      frameId: "f1",
      name: "search",
      origin: "https://x.test",
      isMainFrame: true,
    });
  });

  it("drops malformed tool entries instead of advertising half a tool", async () => {
    const { provider, callbacks, toolSets } = build(
      withTools([
        {
          frameId: "f1",
          name: "ok",
          description: "d",
          origin: "o",
          isMainFrame: true,
        },
        { name: "no-frame" },
        { frameId: "f2" },
        "not-an-object",
        null,
      ]),
    );
    await provider.createSession({ url: "https://x.test/", callbacks });
    expect(toolSets[0].map((t) => t.name)).toEqual(["ok"]);
  });

  it("surfaces the invocation output and cancels on abort", async () => {
    const { provider, callbacks, commands } = build((command) => {
      const action = command.action as any;
      if (action.kind === "webmcp_invoke") {
        return {
          status: "ok",
          result: { ok: true, output: { invocationId: "inv-7", result: 42 } },
          bootId: "b",
        };
      }
      if (action.kind === "webmcp_cancel") {
        return {
          status: "ok",
          result: { ok: true, output: { cancelled: true } },
          bootId: "b",
        };
      }
      return { status: "ok", result: { ok: true, output: {} }, bootId: "b" };
    });
    const session = await provider.createSession({
      url: "https://x.test/",
      callbacks,
    });

    const controller = new AbortController();
    const out = await session.invokeTool({
      frameId: "f1",
      toolName: "search",
      input: { q: "a" },
      signal: controller.signal,
    });
    expect(out.output).toMatchObject({ result: 42 });
    expect(commands.at(-1)!.action).toMatchObject({
      kind: "webmcp_invoke",
      toolKey: "f1::search",
    });
  });

  it("cancels IN THE BROWSER when the caller aborts mid-invocation", async () => {
    // Stopping our wait is not enough: a tool left running keeps acting on the
    // page after the user hit stop.
    const controller = new AbortController();
    const { provider, callbacks, commands } = build((command) => {
      const action = command.action as any;
      if (action.kind === "webmcp_cancel") {
        return {
          status: "ok",
          result: { ok: true, output: { cancelled: true } },
          bootId: "b",
        };
      }
      if (action.kind === "webmcp_invoke") {
        return {
          status: "ok",
          result: { ok: true, output: { invocationId: "inv-7" } },
          bootId: "b",
        };
      }
      return { status: "ok", result: { ok: true, output: {} }, bootId: "b" };
    });
    const session = await provider.createSession({
      url: "https://x.test/",
      callbacks,
    });
    const invoked = session.invokeTool({
      frameId: "f1",
      toolName: "slow",
      input: {},
      signal: controller.signal,
    });
    controller.abort();
    // The CALLER is freed at once. It has to be: the daemon's invoke is
    // synchronous, so awaiting it would mean "stop" could not take effect
    // until the thing being stopped had finished on its own.
    await expect(invoked).rejects.toThrow(/cancelled/i);
    // ...and the page is still told to stop, once the daemon's reply supplies
    // the invocation id that the cancel needs.
    await (session as unknown as { cancelWhenIdentified: Promise<void> })
      .cancelWhenIdentified;
    expect(
      commands.some((c) => (c.action as any).kind === "webmcp_cancel"),
    ).toBe(true);
  });

  it("says a person has the browser rather than reporting a generic failure", async () => {
    const { provider, callbacks } = build((command) =>
      (command.action as any).kind === "navigate"
        ? { status: "ok", result: { ok: true, output: {} }, bootId: "b" }
        : { status: "lease_blocked", bootId: "b" },
    );
    const session = await provider.createSession({
      url: "https://x.test/",
      callbacks,
    });
    await expect(session.reload()).rejects.toThrow(/person has taken control/);
  });

  it("returns undefined from a failed screenshot instead of failing the session", async () => {
    const { provider, callbacks } = build((command) => {
      const action = command.action as any;
      if (action.kind === "observe" && action.mode === "screenshot") {
        return { status: "at_capacity", bootId: "b" };
      }
      return { status: "ok", result: { ok: true, output: {} }, bootId: "b" };
    });
    const session = await provider.createSession({
      url: "https://x.test/",
      callbacks,
    });
    expect(await session.captureScreenshot()).toBeUndefined();
  });

  it("does NOT kill the daemon on dispose — the browser belongs to the computer", async () => {
    // Another chat turn may still be driving it; closing an inspector tab must
    // not close somebody else's browser.
    const { provider, callbacks, commands } = build();
    const session = await provider.createSession({
      url: "https://x.test/",
      callbacks,
    });
    const before = commands.length;
    await session.dispose();
    await session.dispose(); // idempotent
    expect(commands).toHaveLength(before);
    await expect(session.reload()).rejects.toThrow(/disposed/);
  });
});
