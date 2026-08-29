import { describe, expect, it } from "vitest";
import { wrapPage, type AnyPage } from "../chromium-launch";

/**
 * Unit coverage for the ONE piece of the Playwright adapter that had a P1: the
 * network-idle wait must NOT convert a never-idling page into a settled one. The
 * rest of the adapter is exercised by the RUN_BROWSERD_SPIKE integration test.
 */
function fakeAnyPage(over: Partial<AnyPage> = {}): AnyPage {
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
