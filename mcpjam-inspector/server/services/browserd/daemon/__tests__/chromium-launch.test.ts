import { describe, expect, it, vi } from "vitest";
import {
  adaptContext,
  wrapPage,
  type AnyContext,
  type AnyPage,
} from "../chromium-launch";

/**
 * Unit coverage for the ONE piece of the Playwright adapter that had a P1: the
 * network-idle wait must NOT convert a never-idling page into a settled one. The
 * rest of the adapter is exercised by the RUN_BROWSERD_SPIKE integration test.
 */
function fakeAnyPage(over: Partial<AnyPage> = {}): AnyPage {
  const noop = async () => {};
  return {
    async goto() {},
    async reload() {},
    async goBack() {},
    async waitForLoadState() {}, // resolves = the page idled
    async evaluate() { return undefined as never; },
    async screenshot() { return Buffer.from("png"); },
    url: () => "about:blank",
    async close() {},
    isClosed: () => false,
    async bringToFront() {},
    mouse: {
      click: noop,
      move: noop,
      down: noop,
      up: noop,
      wheel: noop,
    },
    keyboard: { type: noop, press: noop },
    click: noop,
    hover: noop,
    fill: noop,
    async selectOption() { return []; },
    async ariaSnapshot() { return ""; },
    locator() {
      const self = {
        first: () => self,
        ariaSnapshot: async () => "",
      };
      return self;
    },
    on() {},
    ...over,
  };
}

describe("wrapPage.waitForNetworkIdle (P1)", () => {
  it("resolves when the page reaches networkidle", async () => {
    const page = wrapPage(fakeAnyPage());
    await expect(page.waitForNetworkIdle(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("does NOT resolve on its own for a page that never idles — it waits for abort, then rejects", async () => {
    // A page still polling: waitForLoadState never resolves. The adapter must
    // hang until the settle deadline aborts, then reject, so settlePage reports
    // settled:false rather than a false settled:true.
    const page = wrapPage(fakeAnyPage({ waitForLoadState: () => new Promise<void>(() => {}) }));
    const controller = new AbortController();
    const pending = page.waitForNetworkIdle(controller.signal);
    let settledEarly = false;
    void pending.then(
      () => (settledEarly = true),
      () => {},
    );
    await Promise.resolve();
    expect(settledEarly).toBe(false); // did not falsely resolve
    controller.abort();
    await expect(pending).rejects.toThrow(); // the deadline ends it
  });

  it("propagates a real failure (a crashed page is not just slow)", async () => {
    const page = wrapPage(
      fakeAnyPage({
        waitForLoadState: () => Promise.reject(new Error("target crashed")),
      }),
    );
    await expect(page.waitForNetworkIdle(new AbortController().signal)).rejects.toThrow(
      "target crashed",
    );
  });
});

function fakeAnyContext(over: Partial<AnyContext> = {}): AnyContext {
  return {
    newPage: vi.fn(async () => fakeAnyPage()),
    pages: () => [],
    browser: () => ({ isConnected: () => true }),
    async close() {},
    ...over,
  };
}

describe("adaptContext (P2 — adopt the persistent context's startup page)", () => {
  it("adopts the startup page for the first tab, then creates fresh pages", async () => {
    const startup = fakeAnyPage({ url: () => "about:blank" });
    const ctx = fakeAnyContext({ pages: () => [startup] });
    const driver = adaptContext(ctx);

    await driver.newPage(); // first tab
    expect(ctx.newPage).not.toHaveBeenCalled(); // adopted the startup page, no orphan

    await driver.newPage(); // second tab
    expect(ctx.newPage).toHaveBeenCalledOnce(); // only now is a new page created
  });

  it("creates a page normally when the context reports no startup pages", async () => {
    const ctx = fakeAnyContext({ pages: () => [] });
    const driver = adaptContext(ctx);
    await driver.newPage();
    expect(ctx.newPage).toHaveBeenCalledOnce();
  });

  it("reports connectivity from the underlying browser (null → assumed alive)", async () => {
    expect(adaptContext(fakeAnyContext({ browser: () => ({ isConnected: () => false }) })).isConnected()).toBe(false);
    expect(adaptContext(fakeAnyContext({ browser: () => null })).isConnected()).toBe(true);
  });
});

describe("adaptContext — ephemeral ownership (review follow-up)", () => {
  it("closes the browser even when closing the CONTEXT fails", async () => {
    // Ephemeral mode owns a Browser above the context. If a failing context
    // close skipped the browser close, a Chromium process would be stranded
    // inside the sandbox — and a failing close is exactly the moment when
    // something is already wrong.
    const onClose = vi.fn(async () => {});
    const adapted = adaptContext(
      fakeAnyContext({
        async close() {
          throw new Error("context close failed");
        },
      }),
      { onClose },
    );
    await expect(adapted.close()).rejects.toThrow(/context close failed/);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes the browser after a clean context close", async () => {
    const onClose = vi.fn(async () => {});
    const adapted = adaptContext(fakeAnyContext(), { onClose });
    await adapted.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("is fine with no owned browser at all (the persistent path)", async () => {
    const adapted = adaptContext(fakeAnyContext());
    await expect(adapted.close()).resolves.toBeUndefined();
  });
});

describe("wrapPage.a11ySnapshot", () => {
  it("reads the tree from ariaSnapshot, NOT the removed page.accessibility API", async () => {
    // Playwright 1.62 (our pin) has no `page.accessibility`; the adapter must
    // go through `ariaSnapshot`, or every a11y observation is an empty page.
    const ariaSnapshot = vi.fn(async () => '- heading "Welcome" [level=1]');
    const page = wrapPage(fakeAnyPage({ ariaSnapshot }));
    await expect(page.a11ySnapshot()).resolves.toEqual({
      role: "heading",
      name: "Welcome",
      level: 1,
    });
    expect(ariaSnapshot).toHaveBeenCalledOnce();
  });

  it("scopes to the rootSelector's FIRST match when one is given", async () => {
    const scoped = vi.fn(async () => "- list:\n  - listitem \"One\"");
    const locator = vi.fn((_selector: string) => {
      const self = { first: () => self, ariaSnapshot: scoped };
      return self;
    });
    const pageAria = vi.fn(async () => "- document");
    const page = wrapPage(fakeAnyPage({ locator, ariaSnapshot: pageAria }));

    const tree = await page.a11ySnapshot("#results");

    expect(locator).toHaveBeenCalledWith("#results");
    expect(pageAria).not.toHaveBeenCalled(); // scoped, not whole-page
    expect(tree).toEqual({
      role: "list",
      children: [{ role: "listitem", name: "One" }],
    });
  });

  it("answers null when the selector matches nothing, rather than throwing", async () => {
    // Playwright rejects on an unmatched locator; the driver turns this null
    // into `unknown_selector`, so the adapter must not propagate the throw.
    const locator = () => {
      const self = {
        first: () => self,
        ariaSnapshot: async () => {
          throw new Error("locator.ariaSnapshot: Timeout exceeded");
        },
      };
      return self;
    };
    const page = wrapPage(fakeAnyPage({ locator }));
    await expect(page.a11ySnapshot("#missing")).resolves.toBeNull();
  });
});

describe("wrapPage.screenshotBase64", () => {
  it("captures JPEG, not PNG — every act result carries one", async () => {
    const screenshot = vi.fn(async () => Buffer.from("jpeg-bytes"));
    const page = wrapPage(fakeAnyPage({ screenshot }));
    const base64 = await page.screenshotBase64();
    expect(screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: "jpeg" }),
    );
    expect(base64).toBe(Buffer.from("jpeg-bytes").toString("base64"));
  });
});
