import { describe, expect, it } from "vitest";
import { ChromiumDriver } from "../chromium-driver";
import { shortHash } from "../state-token";
import type { DriverContext, DriverPage } from "../browser-page";
import type { BrowserCommand } from "../../protocol";

interface FakePage extends DriverPage {
  setUrl(u: string): void;
  setDom(d: string): void;
  readonly calls: { goto: string[]; reload: number; goBack: number; shots: number };
}

function fakePage(init: {
  url?: string;
  dom?: string;
  hangNetwork?: boolean;
  /** Called inside screenshotBase64 — used to simulate a DOM shift mid-capture. */
  onScreenshot?: (page: { setDom: (d: string) => void }) => void;
} = {}): FakePage {
  let url = init.url ?? "about:blank";
  let dom = init.dom ?? "0BODY";
  let closed = false;
  const calls = { goto: [] as string[], reload: 0, goBack: 0, shots: 0 };
  const setDom = (d: string) => { dom = d; };
  return {
    async goto(u) { calls.goto.push(u); url = u; },
    async reload() { calls.reload++; },
    async goBack() { calls.goBack++; },
    async waitForNetworkIdle(signal) {
      if (!init.hangNetwork) return;
      return new Promise<void>((_r, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    },
    async requestAnimationFrame() {},
    async domStructureSignal() { return dom; },
    async screenshotBase64() {
      calls.shots++;
      init.onScreenshot?.({ setDom });
      return "BASE64PNG";
    },
    url: () => url,
    close: async () => { closed = true; },
    isClosed: () => closed,
    setUrl: (u) => { url = u; },
    setDom,
    calls,
  };
}

function fakeContext(init: { pages?: FakePage[]; connected?: boolean } = {}) {
  let i = 0;
  let connected = init.connected ?? true;
  let closed = false;
  const created: FakePage[] = [];
  const context: DriverContext = {
    async newPage() {
      const page = init.pages?.[i++] ?? fakePage();
      created.push(page);
      return page;
    },
    isConnected: () => connected,
    close: async () => { closed = true; },
  };
  return { context, created, setConnected: (v: boolean) => (connected = v), wasClosed: () => closed };
}

function cmd(action: BrowserCommand["action"], tabId?: string): BrowserCommand {
  return { commandId: `c-${Math.random()}`, tabId, source: "chat", action };
}

describe("ChromiumDriver — navigation (W1 subset)", () => {
  it("navigates, settles, and returns the observation with a state token (L2/L3)", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    const res = await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    expect(page.calls.goto).toEqual(["https://x.test/"]);
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ url: "https://x.test/" });
    expect(res.settled).toBe(true);
    // tab-less commands resolve to the shared session key, which MUST match the
    // queue's default key so they cannot race an explicit tabId of the same name.
    expect(res.stateToken).toMatchObject({ tabId: "@session", navCounter: 1 });
  });

  it("uses the queue's default key for tab-less commands, so an explicit @session is the SAME tab (P1)", async () => {
    const page = fakePage();
    const { context, created } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" })); // tab-less
    const viaExplicit = await driver.execute(
      cmd({ kind: "observe", mode: "url" }, "@session"),
    );
    expect(created).toHaveLength(1); // one page, not two racing FIFOs
    expect(viaExplicit.output).toEqual({ url: "https://x.test/" });
  });

  it("dispatches back and reload to the page", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.execute(cmd({ kind: "reload" }));
    await driver.execute(cmd({ kind: "back" }));
    expect(page.calls.reload).toBe(1);
    expect(page.calls.goBack).toBe(1);
  });

  it("returns settled:false when the page will not go quiet in budget", async () => {
    const page = fakePage({ hangNetwork: true });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { settle: { maxWaitMs: 10 } });
    const res = await driver.execute(cmd({ kind: "navigate", url: "https://slow.test/" }));
    expect(res.ok).toBe(true);
    expect(res.settled).toBe(false); // frame returned anyway, no wait verb
  });
});

describe("ChromiumDriver — observe", () => {
  it("returns a screenshot / url / dom each with a fresh token", async () => {
    const page = fakePage({ url: "https://x.test/", dom: "0BODY>1DIV" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const shot = await driver.execute(cmd({ kind: "observe", mode: "screenshot" }));
    expect(shot.output).toEqual({ screenshot: "BASE64PNG" });
    expect(shot.stateToken).toBeDefined();

    const url = await driver.execute(cmd({ kind: "observe", mode: "url" }));
    expect(url.output).toEqual({ url: "https://x.test/" });

    const dom = await driver.execute(cmd({ kind: "observe", mode: "dom" }));
    expect(dom.output).toEqual({ dom: "0BODY>1DIV" });
  });

  it("fails an observe on a tab that was never navigated", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    const res = await driver.execute(cmd({ kind: "observe", mode: "url" }, "ghost"));
    expect(res).toMatchObject({ ok: false, error: "unknown_tab: ghost" });
  });

  it("marks W1-unimplemented observe modes explicitly", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));
    expect(res).toMatchObject({ ok: false, error: "unimplemented_in_w1: observe/a11y" });
  });
});

describe("ChromiumDriver — screenshot token binds to the captured frame (P1)", () => {
  it("returns a token computed from the DOM the image was captured against", async () => {
    const page = fakePage({ url: "https://x.test/", dom: "0BODY>1MAIN" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "screenshot" }));
    expect(res.output).toEqual({ screenshot: "BASE64PNG" });
    expect(res.stateToken!.domHash).toBe(shortHash("0BODY>1MAIN")); // matches the frame
    expect(res.settled).toBeUndefined(); // stable capture, not flagged
  });

  it("flags settled:false when the DOM keeps shifting mid-capture (no stale image pinned)", async () => {
    let n = 0;
    const page = fakePage({
      dom: "A",
      onScreenshot: ({ setDom }) => setDom(`B${++n}`), // a new layout on every shot
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "screenshot" }));
    expect(res.ok).toBe(true);
    expect(res.settled).toBe(false); // caller must re-observe, not pin an act
    // the token still describes the post-capture DOM, never an earlier one
    expect(res.stateToken!.domHash).toBe(shortHash(`B${n}`));
  });
});

describe("ChromiumDriver — only navigate may create or replace a tab (P2)", () => {
  it("rejects navigate newTab:true instead of silently replacing the current tab", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    const res = await driver.execute(
      cmd({ kind: "navigate", url: "https://x.test/", newTab: true }),
    );
    expect(res).toMatchObject({ ok: false, error: "unimplemented_in_w1: navigate/newTab" });
  });

  it("returns unknown_tab for back/reload on a tab that was never created", async () => {
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);
    expect(await driver.execute(cmd({ kind: "back" }, "ghost"))).toMatchObject({
      ok: false,
      error: "unknown_tab: ghost",
    });
    expect(await driver.execute(cmd({ kind: "reload" }, "ghost"))).toMatchObject({
      ok: false,
      error: "unknown_tab: ghost",
    });
    expect(created).toHaveLength(0); // no about:blank page was conjured
  });
});

describe("ChromiumDriver — act/webmcp are explicitly deferred to W3", () => {
  it("returns an unimplemented result rather than silently doing nothing", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    for (const action of [
      { kind: "act", verb: "click" } as const,
      { kind: "webmcp_invoke", toolKey: "t", input: {} } as const,
      { kind: "webmcp_cancel", invocationId: "i" } as const,
    ]) {
      const res = await driver.execute(cmd(action));
      expect(res.ok).toBe(false);
      expect(res.error).toContain("unimplemented_in_w1");
    }
  });
});

describe("ChromiumDriver — tabs, state token, health, close", () => {
  it("reuses a page for the same tabId and opens a new one per distinct tabId", async () => {
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://a.test/" }, "t1"));
    await driver.execute(cmd({ kind: "navigate", url: "https://b.test/" }, "t1"));
    expect(created).toHaveLength(1); // same tab reused
    await driver.execute(cmd({ kind: "navigate", url: "https://c.test/" }, "t2"));
    expect(created).toHaveLength(2); // distinct tab → new page
  });

  it("currentStateToken tracks the tab and changes when the DOM shifts (L3)", async () => {
    const page = fakePage({ url: "https://x.test/", dom: "0BODY" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const before = await driver.currentStateToken(undefined);
    page.setDom("0BODY>1BANNER"); // a late banner shifts the DOM
    const after = await driver.currentStateToken(undefined);
    expect(after!.domHash).not.toBe(before!.domHash);
    expect(await driver.currentStateToken("ghost")).toBeUndefined();
  });

  it("reports health from the context and closes everything", async () => {
    const page = fakePage();
    const fc = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(fc.context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    expect(await driver.health()).toEqual({ ok: true });
    fc.setConnected(false);
    expect(await driver.health()).toMatchObject({ ok: false });
    await driver.close();
    expect(page.isClosed()).toBe(true);
    expect(fc.wasClosed()).toBe(true);
  });
});
