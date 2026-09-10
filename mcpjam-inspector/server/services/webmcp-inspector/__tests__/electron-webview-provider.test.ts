/**
 * The Electron webview provider, driven with a fake Electron.
 *
 * Two things here cannot be observed from outside the provider and both fail
 * silently: the ORDER in which CDP handlers register (navigation before the
 * bridge, or the timeline reports a page's tools before it reports arriving at
 * the page), and what `dispose` does and does not touch (it must detach without
 * destroying a surface React still owns).
 *
 * The guard tests are the security ones. `webContents.fromId` will hand back
 * the app's OWN UI renderer — where the user's servers, tokens and chat history
 * live — so "a local caller cannot aim this at the main window" is asserted
 * directly rather than implied.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createElectronWebviewProvider,
  ElectronWebviewWebMcpSession,
  WebMcpWebviewAttachError,
} from "../electron-webview-provider";
import { WebMcpUnsupportedError } from "../provider";
import type { WebMcpSessionCallbacks } from "../provider";
import { WEBMCP_WEBVIEW_PARTITION } from "@/shared/webmcp-inspector-protocol";
import type { WebContents } from "electron";
import {
  fakeElectron,
  fakeImage,
  FakeWebContents,
  fakePartitionSession,
  ownedGuest,
  recordingCallbacks,
} from "./fake-electron";

const START_URL = "https://shop.test/";

/**
 * Start a session the way `createSession` does.
 *
 * Through the real factory, so the attach and the guard are exercised too —
 * a helper that constructed the session class directly would test everything
 * except the path production takes.
 */
async function startSession(
  options: {
    guest?: FakeWebContents;
    electron?: ReturnType<typeof fakeElectron>;
    callbacks?: WebMcpSessionCallbacks;
    url?: string;
  } = {},
) {
  const owned = options.guest ? undefined : ownedGuest();
  const guest = options.guest ?? owned!.guest;
  const electron = options.electron ?? owned!.electron;
  const recorder = recordingCallbacks();
  const provider = createElectronWebviewProvider({
    webContentsId: guest.id,
    electronModule: electron,
  });
  const session = await provider.createSession({
    url: options.url ?? START_URL,
    callbacks:
      options.callbacks ?? (recorder.callbacks as WebMcpSessionCallbacks),
  });
  return { session, guest, electron, recorder };
}

describe("electron-webview provider — the ownership guard", () => {
  it("refuses an id that resolves to nothing", async () => {
    const provider = createElectronWebviewProvider({
      webContentsId: 999,
      electronModule: fakeElectron({ contents: [] }),
    });
    await expect(
      provider.createSession({ url: START_URL, callbacks: stubCallbacks() }),
    ).rejects.toBeInstanceOf(WebMcpWebviewAttachError);
  });

  it("refuses a destroyed surface", async () => {
    const { guest, electron } = ownedGuest();
    guest.destroyed = true;
    await expect(startSession({ guest, electron })).rejects.toBeInstanceOf(
      WebMcpWebviewAttachError,
    );
  });

  it("refuses to attach to this app's OWN window", async () => {
    // The attack the guard exists for: a local caller pointing the inspector's
    // CDP attach at the renderer holding the user's servers, tokens and chat.
    const mainWindow = new FakeWebContents({ id: 1, type: "window" });
    const electron = fakeElectron({
      contents: [mainWindow],
      windows: [{ webContents: mainWindow as unknown as WebContents }],
    });
    const provider = createElectronWebviewProvider({
      webContentsId: mainWindow.id,
      electronModule: electron,
    });
    await expect(
      provider.createSession({ url: START_URL, callbacks: stubCallbacks() }),
    ).rejects.toBeInstanceOf(WebMcpWebviewAttachError);
    // And nothing was attached on the way to refusing.
    expect(mainWindow.debugger.isAttached()).toBe(false);
  });

  it("refuses a surface that is not a webview, even with everything else right", async () => {
    // Defence in depth, and separately load-bearing. The main-window case above
    // happens to be caught by the host check too (a window has no host), so
    // without this the type check could be deleted and every guard test would
    // still pass — while a `browserView` or offscreen surface, which CAN have a
    // host, walked through.
    const host = new FakeWebContents({ id: 1, type: "window" });
    const impostor = new FakeWebContents({
      id: 8,
      type: "browserView",
      host: host as unknown as WebContents,
    });
    const electron = fakeElectron({
      contents: [impostor, host],
      windows: [{ webContents: host as unknown as WebContents }],
    });
    await expect(
      startSession({ guest: impostor, electron }),
    ).rejects.toBeInstanceOf(WebMcpWebviewAttachError);
    expect(impostor.debugger.isAttached()).toBe(false);
  });

  it("refuses a webview on another partition", async () => {
    const host = new FakeWebContents({ id: 1, type: "window" });
    const guest = new FakeWebContents({
      id: 7,
      host: host as unknown as WebContents,
      session: fakePartitionSession("persist:something-else"),
    });
    const electron = fakeElectron({
      contents: [guest, host],
      windows: [{ webContents: host as unknown as WebContents }],
    });
    await expect(startSession({ guest, electron })).rejects.toBeInstanceOf(
      WebMcpWebviewAttachError,
    );
  });

  it("refuses a webview hosted by a window that is not ours", async () => {
    const foreignHost = new FakeWebContents({ id: 99, type: "window" });
    const guest = new FakeWebContents({
      id: 7,
      host: foreignHost as unknown as WebContents,
    });
    // The guest is on the right partition and IS a webview — only its host is
    // wrong, so this proves that check is separately load-bearing.
    expect(guest.session).toBe(fakePartitionSession(WEBMCP_WEBVIEW_PARTITION));
    const electron = fakeElectron({ contents: [guest], windows: [] });
    await expect(startSession({ guest, electron })).rejects.toBeInstanceOf(
      WebMcpWebviewAttachError,
    );
  });

  it("says what to do when devtools hold the debugger slot", async () => {
    const { guest, electron } = ownedGuest();
    guest.debugger.attachError = new Error("Another debugger is attached");
    await expect(startSession({ guest, electron })).rejects.toThrow(
      /Close DevTools on the embedded page/,
    );
  });
});

describe("electron-webview provider — startup", () => {
  it("wires navigation BEFORE the bridge, and navigates inside the probe", async () => {
    const { guest, electron } = ownedGuest();
    const recorder = recordingCallbacks();
    const probeOrder: string[] = [];
    const provider = createElectronWebviewProvider({
      webContentsId: guest.id,
      electronModule: electron,
    });
    const original = guest.loadURL.bind(guest);
    guest.loadURL = async (url: string) => {
      // The domains must be enabled before the first load, or tools registered
      // during page load are never reported.
      probeOrder.push(`load-after:${guest.debugger.methods().join(",")}`);
      await original(url);
    };
    await provider.createSession({
      url: START_URL,
      callbacks: recorder.callbacks as WebMcpSessionCallbacks,
    });

    expect(probeOrder[0]).toMatch(/Page\.enable/);
    expect(probeOrder[0]).toMatch(/WebMCP\.enable/);

    // Registration order is the contract: our `Page.frameNavigated` handler has
    // to run before the bridge's, so the runtime sees `navigated` ahead of the
    // tool snapshot the bridge publishes from the same event.
    guest.debugger.emitCdp("Page.frameNavigated", {
      frame: { id: "main", url: "https://shop.test/cart" },
    });
    expect(
      recorder.log.filter((e) => e === "tools" || e.startsWith("navigated:")),
    ).toEqual(["navigated:https://shop.test/cart", "tools"]);
  });

  it("reports a page with no WebMCP support as unsupported, and detaches", async () => {
    const { guest, electron } = ownedGuest({ probe: async () => false });
    await expect(startSession({ guest, electron })).rejects.toBeInstanceOf(
      WebMcpUnsupportedError,
    );
    // A debugger left on a live surface would block the client's next attempt.
    expect(guest.debugger.isAttached()).toBe(false);
  });

  it("rethrows a navigation failure as itself, not as 'unsupported'", async () => {
    // A DNS failure reported as "this browser cannot do WebMCP" sends someone
    // chasing a browser problem they do not have.
    const { guest, electron } = ownedGuest({
      loadURL: async () => {
        throw new Error("ERR_NAME_NOT_RESOLVED");
      },
    });
    await expect(startSession({ guest, electron })).rejects.toThrow(
      /ERR_NAME_NOT_RESOLVED/,
    );
  });
});

describe("electron-webview provider — the session surface", () => {
  it("reports the client-owned transport, and never screencasts", async () => {
    const { session, guest } = await startSession();
    expect(session.viewportTransport()).toEqual({ kind: "electron-webview" });
    // Must ANSWER rather than throw: an older client asks unconditionally on
    // every pane mount, and a throw would look like a broken session.
    await expect(session.setScreencast(true)).resolves.toBe(false);
    await expect(session.setScreencast(false)).resolves.toBe(false);
    expect(guest.debugger.methods()).not.toContain("Page.startScreencast");
  });

  it("swallows forwarded input rather than delivering every gesture twice", async () => {
    const { session, guest } = await startSession();
    const before = guest.debugger.calls.length;
    await session.dispatchInput([{ kind: "key_down", key: "a" }]);
    expect(guest.debugger.calls.length).toBe(before);
  });

  it("navigates, reloads and goes back", async () => {
    const { session, guest } = await startSession();
    await session.navigate("https://shop.test/cart");
    expect(session.currentUrl()).toBe("https://shop.test/cart");
    await session.reload();
    await session.goBack();
    expect(guest.navigations).toEqual([
      START_URL,
      "https://shop.test/cart",
      "reload:https://shop.test/cart",
      "goBack",
    ]);
  });

  it("returns immediately from go_back when there is nothing to go back to", async () => {
    vi.useFakeTimers();
    try {
      const { guest, electron } = ownedGuest();
      const { session } = await startSession({ guest, electron });
      guest.backHistory = false;

      let settled = false;
      const pending = session.goBack().then(() => {
        settled = true;
      });
      // A no-op `goBack()` emits no loading event, so a provider that waited
      // unconditionally would sit out the full 30s navigation timeout on the
      // one case where nothing happened at all.
      await pending;
      expect(settled).toBe(true);
      expect(guest.navigations).not.toContain("goBack");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a navigation ONCE, whichever source sees it first", async () => {
    const { guest, recorder } = await startSession();
    const before = recorder.navigated.length;

    // Electron's event first, then CDP's for the same navigation. Both describe
    // one page load; two `navigated` entries in the timeline is a duplicate in
    // the record the session exists to produce.
    guest.navigateTo("https://shop.test/cart");
    guest.debugger.emitCdp("Page.frameNavigated", {
      frame: { id: "main", url: "https://shop.test/cart" },
    });
    expect(recorder.navigated.length - before).toBe(1);

    // And the other ordering, for the next navigation.
    guest.debugger.emitCdp("Page.frameNavigated", {
      frame: { id: "main", url: "https://shop.test/checkout" },
    });
    guest.navigateTo("https://shop.test/checkout");
    expect(recorder.navigated.length - before).toBe(2);
    expect(recorder.navigated.at(-1)).toEqual({
      url: "https://shop.test/checkout",
      origin: "https://shop.test",
    });
  });

  it("honours the frame pin instead of letting the main frame shadow it", async () => {
    const { session, guest } = await startSession();
    // Both frames offer the same name. Name resolution prefers the main frame,
    // so a provider that dropped the pin would invoke the wrong tool — the
    // exact bug the runtime carries a frame id to prevent.
    guest.debugger.emitCdp("Page.frameNavigated", {
      frame: { id: "main", url: START_URL },
    });
    guest.debugger.emitCdp("WebMCP.toolsAdded", {
      tools: [
        { name: "getAvailability", frameId: "main" },
        { name: "getAvailability", frameId: "frame-9" },
      ],
    });
    guest.debugger.replies.set("WebMCP.invokeTool", { invocationId: "inv-1" });

    const pending = session.invokeTool({
      frameId: "frame-9",
      toolName: "getAvailability",
      input: { sku: "abc" },
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    guest.debugger.emitCdp("WebMCP.toolResponded", {
      invocationId: "inv-1",
      status: "Completed",
      output: { available: true },
    });
    const settled = await pending;

    const invoke = guest.debugger.calls.find(
      (call) => call.method === "WebMCP.invokeTool",
    );
    expect(invoke?.params).toEqual({
      frameId: "frame-9",
      toolName: "getAvailability",
      input: { sku: "abc" },
    });
    // `{output}` only: the daemon's `{invocationId, output}` envelope loses its
    // id because the runtime already has its own handle for this call.
    expect(settled).toEqual({ output: { available: true } });
  });

  it("finds an out-of-process frame's tools through flat auto-attach", async () => {
    // The Electron half of cross-origin frame support. There is only ONE
    // debugger here, so the equivalent of `newCDPSession(frame)` is flat
    // auto-attach: Chromium hands over a `sessionId` per frame target and the
    // adapter routes that session's events to a `CdpLike` of its own.
    const { session, guest, recorder } = await startSession();
    expect(
      guest.debugger.calls.find(
        (call) => call.method === "Target.setAutoAttach",
      )?.params,
    ).toMatchObject({ autoAttach: true, flatten: true });

    guest.debugger.replies.set("sess-1:Page.getFrameTree", {
      frameTree: { frame: { id: "frame-oopif", url: "https://widget.test/w" } },
    });
    guest.debugger.emitCdp("Target.attachedToTarget", {
      sessionId: "sess-1",
      targetInfo: { type: "iframe", url: "https://widget.test/w" },
    });
    await vi.waitFor(() =>
      expect(
        guest.debugger.calls.some(
          (call) =>
            call.sessionId === "sess-1" && call.method === "WebMCP.enable",
        ),
      ).toBe(true),
    );
    // Attachment is recursive or it is incomplete: `setAutoAttach` is per
    // target, so a cross-origin frame INSIDE this one only surfaces because the
    // same call goes out on the child session too.
    expect(
      guest.debugger.calls.some(
        (call) =>
          call.sessionId === "sess-1" && call.method === "Target.setAutoAttach",
      ),
    ).toBe(true);

    // Its tools arrive on that session and join the page's own catalog.
    guest.debugger.emitCdp(
      "WebMCP.toolsAdded",
      { tools: [{ name: "widget_tool", frameId: "frame-oopif" }] },
      "sess-1",
    );
    const names = () =>
      (recorder.toolSnapshots.at(-1) as { name: string; origin: string }[]).map(
        (tool) => tool.name,
      );
    await vi.waitFor(() => expect(names()).toContain("widget_tool"));
    expect(
      (
        recorder.toolSnapshots.at(-1) as { name: string; origin: string }[]
      ).find((tool) => tool.name === "widget_tool")?.origin,
    ).toBe("https://widget.test");

    // ...and an invocation goes out on THAT session, never the page's: the
    // browser rejects a frame id belonging to another target.
    guest.debugger.replies.set("sess-1:WebMCP.invokeTool", {
      invocationId: "inv-oopif",
    });
    const pending = session.invokeTool({
      frameId: "frame-oopif",
      toolName: "widget_tool",
      input: {},
      signal: new AbortController().signal,
    });
    await vi.waitFor(() =>
      expect(
        guest.debugger.calls.some(
          (call) =>
            call.sessionId === "sess-1" && call.method === "WebMCP.invokeTool",
        ),
      ).toBe(true),
    );
    guest.debugger.emitCdp(
      "WebMCP.toolResponded",
      { invocationId: "inv-oopif", status: "Completed", output: { ok: true } },
      "sess-1",
    );
    expect(await pending).toEqual({ output: { ok: true } });

    // A detach drops only what THAT session registered. It arrives on the
    // session that announced the attach — the page's, here — which is also why
    // the same subscription has to exist on every child session.
    guest.debugger.emitCdp("Target.detachedFromTarget", {
      sessionId: "sess-1",
    });
    await vi.waitFor(() => expect(names()).not.toContain("widget_tool"));
  });

  it("reaches a cross-origin frame NESTED inside a cross-origin frame", async () => {
    // ATTACHMENT IS RECURSIVE OR IT IS INCOMPLETE. `Target.setAutoAttach` is
    // per target, and so is the `attachedToTarget` it produces: the inner
    // frame is announced on the OUTER frame's session, never on the page's. A
    // version that only subscribed on the page would stop one level down and
    // report a widget-inside-a-widget's tools as absent.
    const { guest, recorder } = await startSession();
    guest.debugger.replies.set("outer:Page.getFrameTree", {
      frameTree: { frame: { id: "frame-outer", url: "https://outer.test/" } },
    });
    guest.debugger.replies.set("inner:Page.getFrameTree", {
      frameTree: { frame: { id: "frame-inner", url: "https://inner.test/" } },
    });

    guest.debugger.emitCdp("Target.attachedToTarget", {
      sessionId: "outer",
      targetInfo: { type: "iframe", url: "https://outer.test/" },
    });
    await vi.waitFor(() =>
      expect(
        guest.debugger.calls.some(
          (call) =>
            call.sessionId === "outer" &&
            call.method === "Target.setAutoAttach",
        ),
      ).toBe(true),
    );

    // The inner frame is announced ON THE OUTER SESSION.
    guest.debugger.emitCdp(
      "Target.attachedToTarget",
      { sessionId: "inner", targetInfo: { type: "iframe" } },
      "outer",
    );
    // Wait until the inner session is actually wired: `addSession` enables the
    // domains and reads the frame tree before it subscribes, and a tool emitted
    // into that gap would be missed by a real browser too.
    await vi.waitFor(() =>
      expect(
        guest.debugger.calls.some(
          (call) =>
            call.sessionId === "inner" && call.method === "WebMCP.enable",
        ),
      ).toBe(true),
    );
    guest.debugger.emitCdp(
      "WebMCP.toolsAdded",
      { tools: [{ name: "inner_tool", frameId: "frame-inner" }] },
      "inner",
    );
    await vi.waitFor(() =>
      expect(
        (recorder.toolSnapshots.at(-1) as { name: string }[]).map(
          (tool) => tool.name,
        ),
      ).toContain("inner_tool"),
    );
    // BY NAME, not `.at(-1)`: the bridge publishes its map in registration
    // order, so a later registration would move the entry this checks while the
    // name assertion above still passed.
    expect(
      (
        recorder.toolSnapshots.at(-1) as { name: string; origin: string }[]
      ).find((tool) => tool.name === "inner_tool")?.origin,
    ).toBe("https://inner.test");
  });

  it("undoes an attach whose frame detached while it was still in flight", async () => {
    // The window: `attachFrameSession` awaits a frame tree and the bridge's own
    // domain enables, and the detach can land in the middle of that — with no
    // token recorded yet, so the detach handler has nothing to remove. Without
    // a tombstone the attach completes afterwards and the bridge goes on
    // publishing a departed frame's tools.
    const { guest, recorder } = await startSession();
    // Hold `Page.getFrameTree` open, so the detach is guaranteed to land INSIDE
    // the attach rather than racing it.
    let answerTree: (tree: unknown) => void = () => {};
    guest.debugger.replies.set(
      "gone:Page.getFrameTree",
      new Promise((resolve) => {
        answerTree = resolve;
      }),
    );

    guest.debugger.emitCdp("Target.attachedToTarget", {
      sessionId: "gone",
      targetInfo: { type: "iframe", url: "https://gone.test/" },
    });
    await vi.waitFor(() =>
      expect(
        guest.debugger.calls.some(
          (call) =>
            call.sessionId === "gone" && call.method === "Page.getFrameTree",
        ),
      ).toBe(true),
    );

    // The frame goes away while the attach is still waiting on that reply.
    guest.debugger.emitCdp("Target.detachedFromTarget", { sessionId: "gone" });
    answerTree({
      frameTree: { frame: { id: "frame-gone", url: "https://gone.test/" } },
    });

    // The attach now completes — and must undo itself rather than register.
    await vi.waitFor(() =>
      expect(
        guest.debugger.calls.some(
          (call) =>
            call.sessionId === "gone" && call.method === "WebMCP.enable",
        ),
      ).toBe(true),
    );
    guest.debugger.emitCdp(
      "WebMCP.toolsAdded",
      { tools: [{ name: "gone_tool", frameId: "frame-gone" }] },
      "gone",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const names = (recorder.toolSnapshots.at(-1) ?? []) as { name: string }[];
    expect(names.map((tool) => tool.name)).not.toContain("gone_tool");
  });

  it("carries a cross-document JSON-LD ARRAY through the webview adapter", async () => {
    // The third transport. The `<webview>` reaches the same bridge through
    // `webContents.debugger` rather than a Playwright `CDPSession`, and the
    // adapter in between fans one `"message"` listener out to per-method
    // handlers — so the question worth asking here is whether an ARRAY output
    // (what Blink answers a navigating tool with) survives that fan-out as
    // itself. `deliver()` passes `responded.output` straight to the caller, and
    // this is what keeps it that way.
    const { session, guest } = await startSession();
    guest.debugger.emitCdp("WebMCP.toolsAdded", {
      tools: [{ name: "submit_order", frameId: "frame-9" }],
    });
    guest.debugger.replies.set("WebMCP.invokeTool", { invocationId: "inv-ld" });
    const pending = session.invokeTool({
      frameId: "frame-9",
      toolName: "submit_order",
      input: { sku: "S1" },
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    const jsonLd = [
      { "@context": "https://schema.org", "@type": "OrderConfirmation" },
      { "@context": "https://schema.org", "@type": "Receipt" },
    ];
    guest.debugger.emitCdp("WebMCP.toolResponded", {
      invocationId: "inv-ld",
      status: "Completed",
      output: jsonLd,
    });
    const settled = await pending;
    expect(Array.isArray(settled.output)).toBe(true);
    expect(settled.output).toEqual(jsonLd);
  });

  it("maps a name the page no longer offers to the named error", async () => {
    const { session } = await startSession();
    // Nothing registered: the page moved on. The timeline should say that
    // rather than relay a CDP failure nobody can act on.
    await expect(
      session.invokeTool({
        frameId: "",
        toolName: "checkout",
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/no longer offers a tool named "checkout"/);
  });

  it("carries WHY an invocation was cancelled, so a timeout is not a user cancel", async () => {
    const { session, guest } = await startSession();
    guest.debugger.emitCdp("WebMCP.toolsAdded", {
      tools: [{ name: "slow", frameId: "main" }],
    });
    guest.debugger.replies.set("WebMCP.invokeTool", { invocationId: "inv-3" });
    const controller = new AbortController();
    const pending = session.invokeTool({
      frameId: "main",
      toolName: "slow",
      input: {},
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    // The runtime owns the deadline because we handed the signal over; the
    // browser answers every cancel `Canceled` whatever the reason, so the
    // reason has to survive the round trip.
    controller.abort("timeout");
    await expect(pending).rejects.toMatchObject({
      name: "WebMcpOutcomeUnknownError",
      message: expect.stringMatching(/timeout.*may continue/i),
    });
  });
});

describe("electron-webview provider — screenshots", () => {
  it("keeps a capture that fits the budget", async () => {
    const { guest, electron } = ownedGuest({
      capture: async () => fakeImage({ jpegBytes: () => 1_024 }),
    });
    const { session } = await startSession({ guest, electron });
    const shot = await session.captureScreenshot();
    expect(shot).toBeDefined();
    expect(Buffer.from(shot!, "base64").byteLength).toBe(1_024);
  });

  it("RESCALES an oversized capture rather than clipping it", async () => {
    // Deliberately better than the Playwright path's top-left crop: a smaller
    // picture of the whole page is better evidence for the same bytes.
    const image = fakeImage({
      jpegBytes: (quality) => (quality === 50 ? 200_000 : 200_000),
      resizedJpegBytes: () => 10_000,
    });
    const { guest, electron } = ownedGuest({ capture: async () => image });
    const { session } = await startSession({ guest, electron });
    const shot = await session.captureScreenshot();
    expect(image.resizes).toEqual([640]);
    expect(Buffer.from(shot!, "base64").byteLength).toBe(10_000);
  });

  it("drops a capture that will not fit even after the rescale", async () => {
    const { guest, electron } = ownedGuest({
      capture: async () =>
        fakeImage({
          jpegBytes: () => 5_000_000,
          resizedJpegBytes: () => 900_000,
        }),
    });
    const { session } = await startSession({ guest, electron });
    // The timeline can say "no screenshot"; it must not carry megabyte entries.
    await expect(session.captureScreenshot()).resolves.toBeUndefined();
  });

  it("resolves undefined when the capture throws or comes back empty", async () => {
    const thrower = ownedGuest({
      capture: async () => {
        throw new Error("occluded window");
      },
    });
    const thrown = await startSession({
      guest: thrower.guest,
      electron: thrower.electron,
    });
    await expect(thrown.session.captureScreenshot()).resolves.toBeUndefined();

    // A minimized or occluded window can hand back an empty bitmap rather than
    // failing, and an empty JPEG is worse evidence than none.
    const blank = ownedGuest({
      capture: async () => fakeImage({ empty: true, jpegBytes: () => 10 }),
    });
    const empty = await startSession({
      guest: blank.guest,
      electron: blank.electron,
    });
    await expect(empty.session.captureScreenshot()).resolves.toBeUndefined();
  });
});

describe("electron-webview provider — callbacks", () => {
  it("reports a popup and lets it open, hardened and on our partition", async () => {
    const { session, guest, recorder } = await startSession();
    void session;
    const response = guest.currentWindowOpenHandler()({
      url: "https://auth.test/authorize",
    }) as {
      action: string;
      overrideBrowserWindowOptions?: {
        webPreferences: Record<string, unknown>;
      };
    };
    expect(recorder.popups).toEqual(["https://auth.test/authorize"]);
    // "Left open and un-driven": closing a popup, or folding it into the main
    // surface, breaks OAuth and `window.opener`.
    expect(response.action).toBe("allow");
    expect(response.overrideBrowserWindowOptions?.webPreferences).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: WEBMCP_WEBVIEW_PARTITION,
    });
  });

  it("REPLACES the app-wide window-open handler the guest was born with", async () => {
    const { guest } = await startSession();
    // `src/main.ts` installs one on every created webContents; the slot is
    // single-writer, so attaching is a behaviour change, not an addition.
    expect(guest.windowOpenHandlers.length).toBe(2);
    expect(guest.currentWindowOpenHandler()).not.toBe(
      guest.windowOpenHandlers[0],
    );
  });

  it("reports a crash and a destroy, but not during our own teardown", async () => {
    const { session, guest, recorder } = await startSession();
    guest.emit("render-process-gone");
    expect(recorder.crashes).toHaveLength(1);

    await session.dispose();
    // A client unmounting the element right after `dispose` must not produce a
    // crash banner on a session that ended cleanly.
    guest.emit("destroyed");
    expect(recorder.crashes).toHaveLength(1);
  });

  it("ticks the idle clock from input and console, throttled", async () => {
    vi.useFakeTimers();
    try {
      const { guest, recorder } = await startSession();
      const before = recorder.activityCount();
      // The gap browserd documents: a person reading and typing in the surface
      // sends no command, so without this the session is reaped as idle.
      for (let i = 0; i < 50; i += 1) guest.emit("before-input-event");
      guest.emit("console-message");
      expect(recorder.activityCount() - before).toBe(1);

      vi.advanceTimersByTime(200);
      guest.emit("before-input-event");
      expect(recorder.activityCount() - before).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows an in-page navigation, and ignores a subframe's", async () => {
    const { guest, recorder } = await startSession();
    guest.navigateTo("https://shop.test/cart#items", true);
    expect(recorder.navigated.at(-1)).toEqual({
      url: "https://shop.test/cart#items",
      origin: "https://shop.test",
    });

    const before = recorder.navigated.length;
    guest.emit("did-navigate-in-page", {}, "https://ads.test/pixel", false);
    expect(recorder.navigated.length).toBe(before);
  });
});

describe("electron-webview provider — dispose", () => {
  it("detaches, removes only our listeners, and NEVER destroys the surface", async () => {
    const { guest, electron } = ownedGuest();
    // Someone else's listener, which must survive: the surface outlives the
    // session, and React owns the element.
    const theirs = vi.fn();
    guest.on("did-finish-load", theirs);
    const listenersBefore = guest.listenerCount_all();

    const { session } = await startSession({ guest, electron });
    expect(guest.listenerCount_all()).toBeGreaterThan(listenersBefore);

    await session.dispose();
    expect(guest.debugger.isAttached()).toBe(false);
    expect(guest.listenerCount_all()).toBe(listenersBefore);
    expect(guest.listenerCount("did-finish-load")).toBe(1);
    // The whole point of the inversion: the client owns this surface.
    expect(guest.destroyed).toBe(false);
  });

  it("leaves a DENY window-open handler behind", async () => {
    const { session, guest } = await startSession();
    await session.dispose();
    // A deliberate change from what the guest was born with (that handler would
    // `shell.openExternal`): a surface whose session has ended must not be able
    // to launch the viewer's browser.
    expect(
      guest.currentWindowOpenHandler()({ url: "https://evil.test/" }),
    ).toEqual({ action: "deny" });
  });

  it("is idempotent", async () => {
    const { session, guest } = await startSession();
    await session.dispose();
    const handlers = guest.windowOpenHandlers.length;
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(guest.windowOpenHandlers.length).toBe(handlers);
  });

  it("inerts the CDP adapter, so a late event reaches nothing", async () => {
    const { session, guest, recorder } = await startSession();
    await session.dispose();
    const before = recorder.log.length;
    // `CdpLike` has no `off`, so the bridge's listeners cannot be removed —
    // they are made no-ops instead. An event arriving after dispose must not
    // publish a tool snapshot for a session that has ended.
    guest.debugger.emitCdp("WebMCP.toolsAdded", {
      tools: [{ name: "late", frameId: "main" }],
    });
    expect(recorder.log.length).toBe(before);
  });
});

describe("electron-webview provider — outside Electron", () => {
  it("refuses rather than trying to resolve the electron module", async () => {
    const saved = process.env.ELECTRON_APP;
    delete process.env.ELECTRON_APP;
    try {
      // No `electronModule` injected, so this takes the production load path.
      const provider = createElectronWebviewProvider({ webContentsId: 42 });
      await expect(
        provider.createSession({ url: START_URL, callbacks: stubCallbacks() }),
      ).rejects.toBeInstanceOf(WebMcpWebviewAttachError);
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_APP;
      else process.env.ELECTRON_APP = saved;
    }
  });
});

/** The session class is exported for these suites; keep the reference honest. */
void ElectronWebviewWebMcpSession;

function stubCallbacks(): WebMcpSessionCallbacks {
  return recordingCallbacks().callbacks as WebMcpSessionCallbacks;
}
