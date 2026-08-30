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
    accessibility: { async snapshot() { return null; } },
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
