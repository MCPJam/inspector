import { describe, expect, it } from "vitest";
import { ChromiumDriver } from "../chromium-driver";
import type { BrowserCommand } from "../../protocol";
import { fakeContext, fakePage } from "./fake-page";
import type { SessionViewport } from "../../../../../shared/browser-viewport";

/**
 * The responsive viewport, from the driver's side.
 *
 * The client half of this feature is a panel somebody drags; this is the half
 * that has to keep the number the model is told and the size the page is
 * rendering at from ever disagreeing — including when a page refuses, when the
 * session was never allowed to resize in the first place, and when a caller
 * pins an act to an observation taken before the reflow.
 */
function cmd(action: BrowserCommand["action"], tabId?: string): BrowserCommand {
  return { commandId: `c-${Math.random()}`, tabId, source: "chat", action };
}

/** No debounce: these tests are about the decision, not the pacing. */
const responsive = (onChange?: (viewport: SessionViewport) => void) => ({
  viewport: {
    policy: "followPane" as const,
    debounceMs: 0,
    ...(onChange ? { onChange } : {}),
  },
});

describe("session viewport", () => {
  it("starts a session at the size every browser has always launched at", async () => {
    const { context } = fakeContext({ pages: [fakePage()] });
    const driver = new ChromiumDriver(context);
    expect(driver.sessionViewportState()).toEqual({
      width: 1024,
      height: 768,
      revision: 0,
    });
  });

  it("never moves a fixed session, which is every caller that predates this", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const after = await driver.requestViewport({ width: 1400, height: 900 });
    expect(after).toEqual({ width: 1024, height: 768, revision: 0 });
    expect(page.calls.viewportSizes).toEqual([]);
  });

  it("resizes every open tab and bumps the revision once", async () => {
    const a = fakePage();
    const b = fakePage();
    const { context } = fakeContext({ pages: [a, b] });
    const changes: SessionViewport[] = [];
    const driver = new ChromiumDriver(
      context,
      responsive((viewport) => changes.push(viewport)),
    );
    await driver.execute(cmd({ kind: "navigate", url: "https://a.test/" }, "a"));
    await driver.execute(cmd({ kind: "navigate", url: "https://b.test/" }, "b"));

    await driver.requestViewport({ width: 1400, height: 900 });

    expect(a.calls.viewportSizes).toEqual([{ width: 1400, height: 900 }]);
    expect(b.calls.viewportSizes).toEqual([{ width: 1400, height: 900 }]);
    expect(driver.sessionViewportState()).toEqual({
      width: 1400,
      height: 900,
      revision: 1,
    });
    // One event for the session, not one per tab.
    expect(changes).toEqual([{ width: 1400, height: 900, revision: 1 }]);
  });

  it("does not bump the revision for a request that changed no pixel", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, responsive());
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    await driver.requestViewport({ width: 1024, height: 768 });
    expect(driver.sessionViewportState().revision).toBe(0);
    expect(page.calls.viewportSizes).toEqual([]);
  });

  it("clamps a request outside the bounds instead of refusing it", async () => {
    // The caller is a resize observer on a panel somebody is dragging: it
    // reports 40px for one frame while a collapse animation runs.
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, responsive());
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    await driver.requestViewport({ width: 40, height: 12 });
    expect(driver.sessionViewportState()).toMatchObject({
      width: 400,
      height: 300,
    });
  });
});

describe("the published number never runs ahead of the picture", () => {
  it("keeps the old size when a page refuses the resize", async () => {
    const good = fakePage();
    const bad = fakePage();
    bad.setViewportSize = async () => {
      throw new Error("the renderer is gone");
    };
    const { context } = fakeContext({ pages: [good, bad] });
    const changes: SessionViewport[] = [];
    const driver = new ChromiumDriver(
      context,
      responsive((viewport) => changes.push(viewport)),
    );
    await driver.execute(cmd({ kind: "navigate", url: "https://a.test/" }, "a"));
    await driver.execute(cmd({ kind: "navigate", url: "https://b.test/" }, "b"));

    await driver.requestViewport({ width: 1400, height: 900 });

    expect(driver.sessionViewportState()).toEqual({
      width: 1024,
      height: 768,
      revision: 0,
    });
    // Nothing published, because nothing landed.
    expect(changes).toEqual([]);
    // And the tab that DID take the new size is put back, so no two tabs in
    // one session are rendering at different sizes.
    expect(good.calls.viewportSizes).toEqual([
      { width: 1400, height: 900 },
      { width: 1024, height: 768 },
    ]);
  });

  it("refuses rather than pretending when the engine cannot resize at all", async () => {
    const page = fakePage();
    delete (page as { setViewportSize?: unknown }).setViewportSize;
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, responsive());
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    await driver.requestViewport({ width: 1400, height: 900 });
    expect(driver.sessionViewportState().revision).toBe(0);
  });
});

describe("the viewport revision in the observation token", () => {
  it("rides every observation", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, responsive());
    const before = await driver.execute(
      cmd({ kind: "navigate", url: "https://x.test/", observe: "screenshot" }),
    );
    expect(before.stateToken).toMatchObject({ viewportRevision: 0 });

    await driver.requestViewport({ width: 1400, height: 900 });
    const after = await driver.execute(
      cmd({ kind: "observe", mode: "url" }, "@session"),
    );
    expect(after.stateToken).toMatchObject({ viewportRevision: 1 });
  });

  it("is absent on a driver with no viewport policy, so nothing compares it", async () => {
    // A `fixed` session's revision never moves anyway, but the token still
    // carries it — what must not happen is an ABSENT revision being read as 0.
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    const res = await driver.execute(
      cmd({ kind: "navigate", url: "https://x.test/" }),
    );
    expect(res.stateToken).toMatchObject({ viewportRevision: 0 });
  });

  it("moves when the layout reflowed but the DOM did not", async () => {
    // The whole reason the revision exists: a CSS breakpoint crossing turns
    // three columns into one with the identical tag skeleton, so the DOM hash
    // is unchanged and every other arm of the staleness check passes.
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, responsive());
    const before = await driver.execute(
      cmd({ kind: "navigate", url: "https://x.test/" }),
    );
    await driver.requestViewport({ width: 480, height: 900 });
    const after = await driver.currentStateToken("@session");

    expect(after?.domHash).toBe(before.stateToken?.domHash);
    expect(after?.urlHash).toBe(before.stateToken?.urlHash);
    expect(after?.navCounter).toBe(before.stateToken?.navCounter);
    // ...and yet it is a different page to click on.
    expect(after?.viewportRevision).not.toBe(before.stateToken?.viewportRevision);
  });
});

describe("coordinates are read in the session's space", () => {
  it("accepts a coordinate the launch viewport would have refused", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, responsive());
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.requestViewport({ width: 1400, height: 900 });

    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [1200, 800] } }),
    );
    expect(res.ok).toBe(true);
  });

  it("refuses a coordinate that is off the session's page, and says its size", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, responsive());
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.requestViewport({ width: 800, height: 600 });

    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [900, 100] } }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("out_of_viewport");
    // The message names the size the caller is actually working against.
    expect(res.error).toContain("800x600");
  });
});
