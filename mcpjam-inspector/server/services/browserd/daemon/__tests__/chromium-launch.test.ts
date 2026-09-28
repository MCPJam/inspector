import { describe, expect, it, vi } from "vitest";
import {
  adaptContext,
  contextOptionsFor,
  wrapPage,
  type AnyContext,
  type AnyPage,
} from "../chromium-launch";
import {
  BROWSERD_CONTEXT_OPTIONS,
  BROWSERD_LOCAL_CONTEXT_OPTIONS,
  BROWSERD_OBSERVATION_VIEWPORT,
} from "../launch-args";

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
    async goForward() {},
    async setViewportSize() {},
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

  it("closes the browser even when closing the CONTEXT never answers", async () => {
    // The other half, and the one `finally` does not cover: a REJECTION runs
    // the block below, an unsettled promise does not. `context.close()` waits
    // for Chromium to acknowledge, and a renderer still draining a navigation
    // — a submitted form, a beforeunload — can leave it pending forever.
    //
    // Unbounded, the browser kill is never reached: the process is orphaned
    // anyway and whoever awaited teardown waits with it. That is a server
    // shutdown that never exits, and a test hook that times out.
    vi.useFakeTimers();
    try {
      const onClose = vi.fn(async () => {});
      const adapted = adaptContext(
        fakeAnyContext({ close: () => new Promise<void>(() => {}) }),
        { onClose },
      );

      let settled = false;
      const closing = adapted.close().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_000);
      // Not cut short: an ordinary close is milliseconds, and giving up on one
      // that is merely slow would strand pages this could have closed cleanly.
      expect(settled).toBe(false);
      expect(onClose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      await closing;
      expect(settled).toBe(true);
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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

describe("wrapPage.pageText", () => {
  it("evaluates the shared extraction function, self-invoked", async () => {
    // A bare function literal evaluates to the UNCALLED function, which
    // serializes to undefined — the mistake every in-page constant here is
    // wrapped to prevent.
    const evaluate = vi.fn(async (expression: string) => {
      expect(expression.startsWith("(() => {")).toBe(true);
      expect(expression.endsWith("})()")).toBe(true);
      return "Hello";
    }) as unknown as <R>(fn: string) => Promise<R>;
    const page = wrapPage(fakeAnyPage({ evaluate }));
    await expect(page.pageText()).resolves.toBe("Hello");
  });

  it("answers an empty string when the page returns something else", async () => {
    const page = wrapPage(
      fakeAnyPage({
        evaluate: (async () => undefined) as unknown as <R>(
          fn: string,
        ) => Promise<R>,
      }),
    );
    await expect(page.pageText()).resolves.toBe("");
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

describe("contextOptionsFor — the surface decides what is a determinism pin", () => {
  it("gives the sandbox its full pin set, scale factor folded in when persistent", () => {
    expect(contextOptionsFor({ contextMode: "persistent" })).toEqual(
      BROWSERD_CONTEXT_OPTIONS,
    );
    expect(
      contextOptionsFor({ contextMode: "persistent", deviceScaleFactor: 2 }),
    ).toEqual({ ...BROWSERD_CONTEXT_OPTIONS, deviceScaleFactor: 2 });
  });

  it("still pins an EPHEMERAL sandbox context at scale 1, so eval captures match across hosts", () => {
    expect(
      contextOptionsFor({ contextMode: "ephemeral", deviceScaleFactor: 2 }),
    ).toEqual(BROWSERD_CONTEXT_OPTIONS);
  });

  it("gives a LOCAL context the viewport and nothing that describes a machine", () => {
    const local = contextOptionsFor({
      contextMode: "persistent",
      surface: "local",
    });
    expect(local).toEqual(BROWSERD_LOCAL_CONTEXT_OPTIONS);
    expect(local).not.toHaveProperty("userAgent");
    expect(local).not.toHaveProperty("timezoneId");
    expect(local).toHaveProperty("viewport", BROWSERD_OBSERVATION_VIEWPORT);
  });

  it("drops the pins for a local EPHEMERAL run too", () => {
    // A local eval's captures were never comparable to a hosted one's — same
    // pins, different OS and fonts — so the pins bought nothing there and cost
    // the same captchas.
    expect(
      contextOptionsFor({ contextMode: "ephemeral", surface: "local" }),
    ).toEqual(BROWSERD_LOCAL_CONTEXT_OPTIONS);
  });

  it("honours the display's scale factor on a local persistent context", () => {
    expect(
      contextOptionsFor({
        contextMode: "persistent",
        surface: "local",
        deviceScaleFactor: 2,
      }),
    ).toEqual({ ...BROWSERD_LOCAL_CONTEXT_OPTIONS, deviceScaleFactor: 2 });
  });
});
