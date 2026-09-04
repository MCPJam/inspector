import { describe, expect, it, vi } from "vitest";
import { createElectronPage } from "../electron-page";
import {
  elementAt,
  FakeBrowserWebContents,
  noElement,
} from "./fake-electron-browser";

function makePage(
  contents = new FakeBrowserWebContents(),
  deps: { onClose?: () => void; onBringToFront?: () => void } = {},
) {
  const page = createElectronPage(contents, {
    onClose: deps.onClose ?? (() => {}),
    ...(deps.onBringToFront ? { onBringToFront: deps.onBringToFront } : {}),
  });
  return { page, contents, dbg: contents.debugger };
}

/** Mouse events the page dispatched, in order. */
function mouseEvents(dbg: FakeBrowserWebContents["debugger"]) {
  return dbg.calls
    .filter((c) => c.method === "Input.dispatchMouseEvent")
    .map((c) => c.params as Record<string, unknown>);
}

function keyEvents(dbg: FakeBrowserWebContents["debugger"]) {
  return dbg.calls
    .filter((c) => c.method === "Input.dispatchKeyEvent")
    .map((c) => c.params as Record<string, unknown>);
}

describe("electron page — clicking", () => {
  it("moves before it presses, and releases the button it pressed", async () => {
    // Hover handlers and menus that open on mouseover both need the pointer to
    // have been there first; a bare press lands on a page that never opened.
    const { page, dbg } = makePage();
    await page.clickAt({ x: 10, y: 20 });

    expect(mouseEvents(dbg).map((e) => [e.type, e.button, e.buttons])).toEqual([
      ["mouseMoved", "none", 0],
      ["mousePressed", "left", 1],
      ["mouseReleased", "left", 0],
    ]);
  });

  it("sends a right-click as a right-click", async () => {
    const { page, dbg } = makePage();
    await page.clickAt({ x: 1, y: 2 }, { button: "right" });
    const pressed = mouseEvents(dbg).find((e) => e.type === "mousePressed");
    expect(pressed).toMatchObject({ button: "right", buttons: 2 });
  });

  it("aims at the middle of the element a selector names", async () => {
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(50, 60)) {
      contents.debugger.replies.set(method, reply);
    }
    const { page, dbg } = makePage(contents);

    await page.clickSelector("#go");

    expect(mouseEvents(dbg)[0]).toMatchObject({ x: 50, y: 60 });
    // Off-screen elements are the common case on a long page, and a click at
    // unscrolled coordinates lands on whatever happens to be there instead.
    expect(dbg.methods()).toContain("DOM.scrollIntoViewIfNeeded");
  });

  it("says the element is not there, rather than failing the daemon", async () => {
    // `chromium-driver.ts` classifies on the message: matching means the model
    // is told "the button isn't there" and can act on it.
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of noElement()) {
      contents.debugger.replies.set(method, reply);
    }
    const { page } = makePage(contents);

    await expect(page.clickSelector("#gone")).rejects.toThrow(
      /timeout|not found|no element|strict mode/i,
    );
  });

  it("treats a matched element with no box as nothing to click", async () => {
    const contents = new FakeBrowserWebContents();
    contents.debugger.replies.set("DOM.getDocument", { root: { nodeId: 1 } });
    contents.debugger.replies.set("DOM.querySelector", { nodeId: 42 });
    contents.debugger.replies.set("DOM.getBoxModel", {});
    const { page } = makePage(contents);

    // display:none, or zero-sized. "not found" is the truthful answer to
    // "click this": there is nothing there to aim at.
    await expect(page.clickSelector("#hidden")).rejects.toThrow(
      /timeout|not found|no element|strict mode/i,
    );
  });
});

describe("electron page — the keyboard", () => {
  it("types through insertText rather than a key event per letter", async () => {
    const { page, dbg } = makePage();
    await page.typeText("hello");
    expect(
      dbg.calls.filter((c) => c.method === "Input.insertText"),
    ).toHaveLength(1);
    expect(keyEvents(dbg)).toHaveLength(0);
  });

  it("presses a key with the text it inserts", async () => {
    const { page, dbg } = makePage();
    await page.press("Enter");
    const events = keyEvents(dbg);
    expect(events.map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
    expect(events[0]).toMatchObject({
      key: "Enter",
      code: "Enter",
      text: "\r",
    });
  });

  it("does not type the letter of a shortcut", async () => {
    // Ctrl+A with `text` set selects the document and then REPLACES it with
    // "a": CDP fires the shortcut and inserts the character independently.
    const { page, dbg } = makePage();
    await page.press("Control+a");
    const events = keyEvents(dbg);
    expect(events.map((e) => e.type)).toEqual([
      "rawKeyDown",
      "rawKeyDown",
      "keyUp",
      "keyUp",
    ]);
    expect(events.some((e) => "text" in e)).toBe(false);
  });

  it("refuses a key it cannot send instead of dropping it silently", async () => {
    const { page } = makePage();
    await expect(page.press("Frobnicate")).rejects.toThrow(
      /timeout|not found|no element|strict mode/i,
    );
  });

  it("replaces a field's value rather than appending to it", async () => {
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5)) {
      contents.debugger.replies.set(method, reply);
    }
    const { page, dbg } = makePage(contents);

    await page.fillSelector("#name", "Ada");

    // Click to focus, select-all, then insert. Without the select-all this
    // appends, and `fill`'s contract is REPLACE.
    const keys = keyEvents(dbg);
    expect(keys.some((e) => e.code === "KeyA")).toBe(true);
    const inserted = dbg.calls.filter((c) => c.method === "Input.insertText");
    expect(inserted.at(-1)?.params).toMatchObject({ text: "Ada" });
  });
});

describe("electron page — observation", () => {
  it("screenshots through CDP, because a hidden window has no pixels on screen", async () => {
    const contents = new FakeBrowserWebContents();
    contents.debugger.replies.set("Page.captureScreenshot", { data: "aGk=" });
    const { page, dbg } = makePage(contents);

    expect(await page.screenshotBase64()).toBe("aGk=");
    const shot = dbg.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(shot?.params).toMatchObject({ format: "jpeg" });
  });

  it("keeps the console from before anything asked for it", async () => {
    const contents = new FakeBrowserWebContents();
    const { page } = makePage(contents);
    contents.logConsole("warning", "a page logs while it loads");
    contents.logConsoleLegacy(3, "and older builds pass it positionally");

    expect(page.consoleEntries().map((e) => [e.type, e.text])).toEqual([
      ["warning", "a page logs while it loads"],
      ["error", "and older builds pass it positionally"],
    ]);
  });

  it("drops the console window a person's session filled", async () => {
    // The ring fills from an eager listener that knows nothing about the
    // lease, so what someone typed during a login would otherwise be readable
    // the instant they hand control back.
    const contents = new FakeBrowserWebContents();
    const { page } = makePage(contents);
    contents.logConsole("info", "before");
    const handoff = Date.now() + 1;
    vi.setSystemTime(new Date(handoff + 10));
    contents.logConsole("info", "during their session");

    page.dropConsoleSince(handoff);

    expect(page.consoleEntries().map((e) => e.text)).toEqual(["before"]);
    vi.useRealTimers();
  });

  it("reports the same DOM signal shape the Playwright engine does", async () => {
    // The L3 token is compared against one the model was handed. Two engines
    // that describe a page differently make a token minted on one meaningless.
    const contents = new FakeBrowserWebContents({
      evaluate: (code) =>
        code.includes("parts.join") ? "0BODY>1DIV" : undefined,
    });
    const { page } = makePage(contents);
    expect(await page.domStructureSignal()).toBe("0BODY>1DIV");
  });

  it("answers an empty signal rather than undefined when the page cannot say", async () => {
    const { page } = makePage(new FakeBrowserWebContents());
    expect(await page.domStructureSignal()).toBe("");
  });
});

describe("electron page — navigation", () => {
  it("keeps the address that answered, not the one that was asked for", async () => {
    // `url()` feeds the unattended origin allowlist, which decides whether a
    // page's content is returned or stripped. A redirect that lands back on
    // the page we were already on is the case a URL comparison cannot see:
    // the committed address equals the previous one, so the old code treated
    // that as "no event fired" and wrote the REQUESTED address over it.
    const contents = new FakeBrowserWebContents();
    const { page } = makePage(contents);
    await page.goto("https://a.test/");

    // Now ask for somewhere else, and have it redirect back to where we are.
    contents.redirectTo = "https://a.test/";
    await page.goto("https://elsewhere.test/");

    expect(page.url()).toBe("https://a.test/");
  });

  it("tracks the URL it navigated to", async () => {
    const { page, contents } = makePage();
    await page.goto("https://example.test/one");
    expect(page.url()).toBe("https://example.test/one");
    expect(contents.navigations).toEqual(["https://example.test/one"]);
  });

  it("waits for a reload to commit, not just to start", async () => {
    // `reload()` returns void: without the wait the driver settles and
    // captures the OLD page, and reports it as the result of the reload.
    const { page, contents } = makePage();
    await page.goto("https://example.test/");
    await page.reload();
    expect(contents.navigations).toContain("reload:https://example.test/");
  });

  it("says there is nowhere to go back to, rather than hanging", async () => {
    const { page } = makePage();
    await expect(page.goBack()).rejects.toThrow(
      /timeout|not found|no element|strict mode/i,
    );
  });

  it("calls off a navigation that blew its budget", async () => {
    // The command that started it has already been answered and the queue has
    // moved on. A load left running commits underneath whatever runs NEXT, and
    // that command's observation then describes a page nobody asked for.
    vi.useFakeTimers();
    try {
      const contents = new FakeBrowserWebContents({
        loadURL: () => new Promise<void>(() => {}),
      });
      const { page } = makePage(contents);

      const navigating = page.goto("https://slow.test/");
      const assertion = expect(navigating).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(31_000);
      await assertion;

      expect(contents.stopped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed navigation as something the model can act on", async () => {
    const contents = new FakeBrowserWebContents({
      loadError: new Error("ERR_NAME_NOT_RESOLVED"),
    });
    const { page } = makePage(contents);
    await expect(page.goto("https://nope.invalid/")).rejects.toThrow();
  });
});

describe("electron page — settling", () => {
  it("counts requests that started before the wait did", async () => {
    // `Network.enable` does not replay: anything already running when it is
    // called is invisible to that session forever. Enabling it inside the wait
    // meant `goto()`'s own requests were never counted, so the wait armed from
    // ZERO and reported a still-loading page as settled half a second later.
    const contents = new FakeBrowserWebContents();
    const { page, dbg } = makePage(contents);
    await page.cdp();

    // Enabled with the other domains, before anything navigates.
    expect(dbg.methods()).toContain("Network.enable");

    // A request in flight, then the wait: it must not resolve until the
    // request finishes.
    dbg.emitCdp("Network.requestWillBeSent", { requestId: "r1" });
    let settled = false;
    const waiting = page
      .waitForNetworkIdle(new AbortController().signal)
      .then(() => {
        settled = true;
      });
    await new Promise((r) => setTimeout(r, 700));
    expect(settled).toBe(false);

    dbg.emitCdp("Network.loadingFinished", { requestId: "r1" });
    await waiting;
    expect(settled).toBe(true);
  }, 10_000);

  it("does not stay busy forever after a redirect", async () => {
    // A redirect emits a fresh `requestWillBeSent` for each hop under the SAME
    // requestId and exactly one terminal event at the end. A counter would go
    // up three times and down once and never reach zero again — the page would
    // never settle for the rest of its life, which is a hang rather than a
    // wrong answer.
    const contents = new FakeBrowserWebContents();
    const { page, dbg } = makePage(contents);
    await page.cdp();

    dbg.emitCdp("Network.requestWillBeSent", { requestId: "r1" });
    dbg.emitCdp("Network.requestWillBeSent", { requestId: "r1" });
    dbg.emitCdp("Network.requestWillBeSent", { requestId: "r1" });
    dbg.emitCdp("Network.loadingFinished", { requestId: "r1" });

    await expect(
      page.waitForNetworkIdle(new AbortController().signal),
    ).resolves.toBeUndefined();
  }, 10_000);

  it("does not add three CDP listeners per observation", async () => {
    // `CdpLike` has deliberately no `off`, and `settle()` runs a wait on every
    // observe and every act. Registering handlers per wait grew the adapter's
    // map by three entries forever on a long session.
    const contents = new FakeBrowserWebContents();
    const { page } = makePage(contents);
    await page.cdp();

    // The adapter's OWN handler map is what grows — asserting on the
    // debugger emitter's `listenerCount("message")` measures the single
    // listener the adapter installs in its constructor, which stays at one
    // however badly the map leaks. That version of this test passed with the
    // regression reintroduced.
    const cdp = (await page.cdp()) as unknown as { handlerCount(): number };
    const before = cdp.handlerCount();

    for (let i = 0; i < 5; i += 1) {
      const controller = new AbortController();
      const waiting = page.waitForNetworkIdle(controller.signal);
      controller.abort();
      await waiting;
    }

    expect(cdp.handlerCount()).toBe(before);
  });
});

describe("electron page — lifecycle", () => {
  it("detaches the debugger and tells the context to drop its window", async () => {
    const onClose = vi.fn();
    const { page, dbg } = makePage(new FakeBrowserWebContents(), { onClose });
    await page.cdp();
    expect(dbg.isAttached()).toBe(true);

    await page.close();

    expect(dbg.isAttached()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(page.isClosed()).toBe(true);
  });

  it("closes once, however many times it is asked", async () => {
    const onClose = vi.fn();
    const { page } = makePage(new FakeBrowserWebContents(), { onClose });
    await page.close();
    await page.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is closed when its surface was destroyed underneath it", async () => {
    const contents = new FakeBrowserWebContents();
    const { page } = makePage(contents);
    expect(page.isClosed()).toBe(false);
    contents.destroyed = true;
    expect(page.isClosed()).toBe(true);
  });

  it("shares ONE debugger attach across everything that needs CDP", async () => {
    // Two attaches is two of everything the CDP domains keep per session, for
    // one page's worth of truth — and the second attach throws in real Electron.
    const { page, dbg } = makePage();
    const [a, b] = await Promise.all([page.cdp(), page.cdp()]);
    expect(a).toBe(b);
    expect(dbg.methods().filter((m) => m === "DOM.enable")).toHaveLength(1);
  });
});
