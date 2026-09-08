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

  it("rejects a <select> so the driver can fall back to selectOption", async () => {
    // This engine fills by clicking, selecting all and inserting text, and on
    // a `<select>` that sequence silently does NOTHING — no error, no change.
    // `fill_form` falls back to `selectOption` on the refusal that names
    // `<input>`, so without this check the fallback fires on Playwright and
    // never here, and the model's form is quietly half-filled.
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5, 10, { nodeName: "SELECT" })) {
      contents.debugger.replies.set(method, reply);
    }
    const { page, dbg } = makePage(contents);

    const refusal = await page
      .fillSelector("#size", "L")
      .then(() => null, (error: Error) => error.message);
    // The list must NOT offer `<select>`: that one-item difference is how the
    // driver tells "use selectOption" from "this cannot be filled at all".
    expect(refusal).toMatch(/not an <input>/i);
    expect(refusal).not.toMatch(/<select>/);
    // And nothing was typed at it: a half-applied fill is worse than a refusal.
    expect(dbg.calls.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  it("refuses a target that cannot be filled, WITHOUT clicking it", async () => {
    // The keystrokes land on a button and change nothing — but the click that
    // precedes them presses it, which is a side effect nobody asked for. The
    // message names `<select>` among the alternatives, which is what keeps the
    // driver's `fill_form` from falling back to `selectOption` here.
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5, 10, { nodeName: "BUTTON" })) {
      contents.debugger.replies.set(method, reply);
    }
    const { page, dbg } = makePage(contents);

    await expect(page.fillSelector("#go", "x")).rejects.toThrow(/<select>/);
    expect(mouseEvents(dbg)).toHaveLength(0);
  });

  it("refuses a checkbox rather than toggling it on the way past", async () => {
    // This engine clicks before it inserts text, so a `fill_form` field aimed
    // at a checkbox TOGGLES it, at a file input opens a picker, and at a
    // submit sends the form — each a side effect nobody asked for, followed by
    // an insertion that changed nothing and reported success.
    const contents = new FakeBrowserWebContents();
    // `range` and `color` are in the same set on THIS engine even though
    // Playwright fills them, because it writes the value and this one clicks:
    // a centre click on a range IS the interaction (measured: 0 → 50) and a
    // colour input opens the platform picker.
    for (const [method, reply] of elementAt(5, 5, 10, {
      nodeName: "INPUT",
      attributes: ["type", "checkbox"],
    })) {
      contents.debugger.replies.set(method, reply);
    }
    const { page, dbg } = makePage(contents);

    const refusal = await page
      .fillSelector("#agree", "yes")
      .then(() => null, (error: Error) => error.message);

    // Playwright's own words for this case, which name neither `<input>` nor
    // `<select>` — so `fill_form` does not mistake a checkbox for a dropdown.
    expect(refusal).toMatch(/Input of type "checkbox" cannot be filled/);
    expect(refusal).not.toMatch(/not an <input>/i);
    expect(mouseEvents(dbg)).toHaveLength(0);
  });

  it("will not click a BUTTON however editable the page claims it is", async () => {
    // `<button>` is not an `<input>`, so the input-type list does not cover it
    // — and it used to reach the contenteditable probe, where a page that lied
    // about `isContentEditable` got the button pressed. Tags whose click
    // activates something are refused before anything page-controlled runs.
    const contents = new FakeBrowserWebContents({
      evaluate: () => true,
    });
    for (const [method, reply] of elementAt(5, 5, 10, { nodeName: "BUTTON" })) {
      contents.debugger.replies.set(method, reply);
    }
    // The page also answers the CDP probe with "yes, editable".
    contents.debugger.replies.set("DOM.resolveNode", { object: { objectId: "1" } });
    contents.debugger.replies.set("Runtime.callFunctionOn", {
      result: { value: true },
    });
    const { page, dbg } = makePage(contents);

    await expect(page.fillSelector("#pay", "x")).rejects.toThrow(/<select>/);
    expect(mouseEvents(dbg)).toHaveLength(0);
  });

  it("fills an inherited-contenteditable element, and releases the handle", async () => {
    // The one case that genuinely needs the page: `contenteditable` inherits,
    // so a span inside an editable div carries no attribute of its own.
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5, 10, { nodeName: "SPAN" })) {
      contents.debugger.replies.set(method, reply);
    }
    contents.debugger.replies.set("DOM.resolveNode", {
      object: { objectId: "obj-1" },
    });
    contents.debugger.replies.set("Runtime.callFunctionOn", {
      result: { value: true },
    });
    const { page, dbg } = makePage(contents);

    await page.fillSelector("#editor", "hello");

    expect(dbg.calls.some((c) => c.method === "Input.insertText")).toBe(true);
    // A resolved node pins the JS object; a tab that fills all day would hold
    // one handle per fill.
    expect(
      dbg.calls.find((c) => c.method === "Runtime.releaseObject")?.params,
    ).toMatchObject({ objectId: "obj-1" });
  });

  it("takes the contenteditable ATTRIBUTE from CDP without asking the page", async () => {
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5, 10, {
      nodeName: "DIV",
      attributes: ["contenteditable", ""],
    })) {
      contents.debugger.replies.set(method, reply);
    }
    const { page, dbg } = makePage(contents);

    await page.fillSelector("#editor", "hello");

    expect(dbg.calls.some((c) => c.method === "Input.insertText")).toBe(true);
    // The common case never reaches the page at all.
    expect(dbg.calls.some((c) => c.method === "DOM.resolveNode")).toBe(false);
  });

  it("does not take an INVALID contenteditable value for editable", async () => {
    // `contenteditable` is enumerated: `""`, `"true"`, `"plaintext-only"` and
    // `"false"` are the whole vocabulary. Anything else — `"yes"`, `"inherit"`,
    // a typo — is invalid, and invalid means INHERIT: editable only if an
    // ancestor is. Reading "present and not false" as editable skipped the
    // probe for a span that is not editable at all, and this span sits inside
    // an `<a>`, so the click it collected would follow the link. The tag list
    // cannot see that: the span's own tag is perfectly inert.
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5, 10, {
      nodeName: "SPAN",
      attributes: ["contenteditable", "yes"],
    })) {
      contents.debugger.replies.set(method, reply);
    }
    contents.debugger.replies.set("DOM.resolveNode", {
      object: { objectId: "obj-1" },
    });
    // What the element actually is, computed: not editable.
    contents.debugger.replies.set("Runtime.callFunctionOn", {
      result: { value: false },
    });
    const { page, dbg } = makePage(contents);

    await expect(page.fillSelector("#label", "x")).rejects.toThrow(/<select>/);
    expect(mouseEvents(dbg)).toHaveLength(0);
    // The attribute did not answer; the computed property did.
    expect(dbg.calls.some((c) => c.method === "DOM.resolveNode")).toBe(true);
  });

  it("fills a plaintext-only element, and refuses an explicit false", async () => {
    // The two remaining spec values, both answered from the protocol without
    // a round trip to the page: `plaintext-only` is editable, and the false
    // state does not inherit its way back to editable.
    const editable = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5, 10, {
      nodeName: "DIV",
      attributes: ["contenteditable", "plaintext-only"],
    })) {
      editable.debugger.replies.set(method, reply);
    }
    const { page: editablePage, dbg: editableDbg } = makePage(editable);
    await editablePage.fillSelector("#note", "hello");
    expect(
      editableDbg.calls.some((c) => c.method === "Input.insertText"),
    ).toBe(true);

    const off = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5, 10, {
      nodeName: "DIV",
      attributes: ["contenteditable", "false"],
    })) {
      off.debugger.replies.set(method, reply);
    }
    const { page: offPage, dbg: offDbg } = makePage(off);
    await expect(offPage.fillSelector("#frozen", "x")).rejects.toThrow(
      /<select>/,
    );
    expect(mouseEvents(offDbg)).toHaveLength(0);
    expect(offDbg.calls.some((c) => c.method === "DOM.resolveNode")).toBe(
      false,
    );
  });

  it("cannot be talked out of the refusal by a page that breaks its own DOM", async () => {
    // The classification used to run as page JS through
    // `document.querySelector`, and a thrown classifier was read as "carry on"
    // — so any page could switch the guard off by replacing that function and
    // collect the click it was meant to prevent. It is asked of CDP now, where
    // page script cannot reach.
    const contents = new FakeBrowserWebContents({
      evaluate: () => {
        throw new Error("document.querySelector is not a function");
      },
    });
    for (const [method, reply] of elementAt(5, 5, 10, {
      nodeName: "INPUT",
      attributes: ["type", "submit"],
    })) {
      contents.debugger.replies.set(method, reply);
    }
    const { page, dbg } = makePage(contents);

    await expect(page.fillSelector("#pay", "x")).rejects.toThrow(
      /Input of type "submit" cannot be filled/,
    );
    // The submit button was never pressed.
    expect(mouseEvents(dbg)).toHaveLength(0);
  });

  it("lets a MALFORMED selector fail the way it always has", async () => {
    // The preflight would reject with the page's own `querySelector` prose,
    // which the driver reads as a daemon fault; the box lookup below it
    // normalizes the same failure to "no element", which the model is told is
    // its own selector's problem.
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of noElement()) {
      contents.debugger.replies.set(method, reply);
    }
    const { page } = makePage(contents);

    await expect(page.fillSelector("[[[", "x")).rejects.toThrow(
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

    // Focus, select-all, then insert. Without the select-all this appends, and
    // `fill`'s contract is REPLACE.
    const keys = keyEvents(dbg);
    expect(keys.some((e) => e.code === "KeyA")).toBe(true);
    const inserted = dbg.calls.filter((c) => c.method === "Input.insertText");
    expect(inserted.at(-1)?.params).toMatchObject({ text: "Ada" });
  });

  it("reaches the node it classified, not the coordinate it measured", async () => {
    // `pointFor` measures a box, and the classification that follows spends
    // CDP round trips before anything is written. A page that reflows in that
    // window puts a different control under the measured point — so a click
    // there presses something nobody classified, and every check above it
    // passes on the way. Focusing the NODE has no such window.
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5)) {
      contents.debugger.replies.set(method, reply);
    }
    const { page, dbg } = makePage(contents);

    await page.fillSelector("#name", "Ada");

    expect(mouseEvents(dbg)).toHaveLength(0);
    expect(dbg.calls.find((c) => c.method === "DOM.focus")?.params).toMatchObject(
      { nodeId: 42 },
    );
  });

  it("does not type into the old focus when the element cannot take it", async () => {
    // Fails closed: if focus is refused, select-all and insert would land in
    // whatever was focused before — the same wrong-target write by a longer
    // route.
    const contents = new FakeBrowserWebContents();
    for (const [method, reply] of elementAt(5, 5)) {
      contents.debugger.replies.set(method, reply);
    }
    const dbg = contents.debugger;
    const send = dbg.sendCommand.bind(dbg);
    dbg.sendCommand = async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.focus") throw new Error("Element is not focusable");
      return send(method, params);
    };
    const { page } = makePage(contents);

    await expect(page.fillSelector("#name", "Ada")).rejects.toThrow(
      /could not be focused/,
    );
    expect(dbg.calls.some((c) => c.method === "Input.insertText")).toBe(false);
    expect(keyEvents(dbg)).toHaveLength(0);
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

  it("ignores a SUBFRAME that failed, because the document loaded", async () => {
    // Blocked ad iframes and tracking pixels fail constantly on the open web
    // this engine exists to drive. Electron reports every frame's failure
    // through the same event, so without the main-frame check one of them
    // rejected the whole navigation and `reload()` answered `not found` on a
    // page that had loaded perfectly.
    const { page, contents } = makePage();
    await page.goto("https://example.test/");
    contents.failFrameOnNextLoad = {
      description: "ERR_BLOCKED_BY_CLIENT",
      isMainFrame: false,
    };

    await expect(page.reload()).resolves.toBeUndefined();
  });

  it("still fails a reload whose MAIN frame failed", async () => {
    const { page, contents } = makePage();
    await page.goto("https://example.test/");
    contents.failFrameOnNextLoad = {
      description: "ERR_NAME_NOT_RESOLVED",
      isMainFrame: true,
    };

    await expect(page.reload()).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
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
