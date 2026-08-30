import { describe, expect, it } from "vitest";
import { ChromiumDriver } from "../chromium-driver";
import { shortHash } from "../state-token";
import type { DriverContext, DriverPage } from "../browser-page";
import type { BrowserCommand } from "../../protocol";
import { HandoffLease, RESUMED_AFTER_HANDOFF_NOTE } from "../lease";

/** Every act the fake page recorded, in order, as `verb:detail` strings. */
type ActLog = string[];

interface FakePage extends DriverPage {
  setUrl(u: string): void;
  setDom(d: string): void;
  readonly calls: {
    goto: string[];
    reload: number;
    goBack: number;
    shots: number;
    acts: ActLog;
    front: number;
  };
}

function fakePage(init: {
  url?: string;
  dom?: string;
  hangNetwork?: boolean;
  /** Called inside screenshotBase64 — used to simulate a shift mid-capture. */
  onScreenshot?: (page: { setDom: (d: string) => void; setUrl: (u: string) => void }) => void;
  /** Make a targeted act fail, as a missing element would. */
  actError?: Error;
  a11y?: unknown;
  console?: Array<{ type: string; text: string; at: number }>;
  webmcp?: DriverPage extends { webmcp(): Promise<infer B | null> } ? B | null : never;
} = {}): FakePage {
  let url = init.url ?? "about:blank";
  let dom = init.dom ?? "0BODY";
  let closed = false;
  const calls = {
    goto: [] as string[],
    reload: 0,
    goBack: 0,
    shots: 0,
    acts: [] as ActLog,
    front: 0,
  };
  const setDom = (d: string) => { dom = d; };
  const setUrl = (u: string) => { url = u; };
  const act = (entry: string) => {
    calls.acts.push(entry);
    if (init.actError) throw init.actError;
  };
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
      init.onScreenshot?.({ setDom, setUrl });
      return "BASE64PNG";
    },
    url: () => url,
    close: async () => { closed = true; },
    isClosed: () => closed,
    bringToFront: async () => { calls.front++; },

    async clickAt(point, options) {
      act(`click:${point.x},${point.y}${options?.button ? `:${options.button}` : ""}`);
    },
    async clickSelector(selector) { act(`click:${selector}`); },
    async hoverAt(point) { act(`hover:${point.x},${point.y}`); },
    async hoverSelector(selector) { act(`hover:${selector}`); },
    async typeText(text) { act(`type:${text}`); },
    async fillSelector(selector, text) { act(`fill:${selector}:${text}`); },
    async press(key) { act(`press:${key}`); },
    async scrollBy({ dx, dy }) { act(`scroll:${dx},${dy}`); },
    async dragTo(from, to) { act(`drag:${from.x},${from.y}->${to.x},${to.y}`); },
    async selectOption(selector, value) { act(`select:${selector}:${value}`); },
    async a11ySnapshot() { return (init.a11y ?? null) as never; },
    consoleEntries: () => init.console ?? [],
    async webmcp() { return (init.webmcp ?? null) as never; },

    setUrl,
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

  it("returns a budgeted a11y tree, omitting whole subtrees (L9)", async () => {
    const deep = {
      role: "main",
      children: Array.from({ length: 30 }, (_, i) => ({
        role: "group",
        name: `g${i}`,
        children: [{ role: "button", name: `b${i}` }],
      })),
    };
    const page = fakePage({ url: "https://x.test/", a11y: deep });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, {
      a11y: { maxNodes: 10, maxDepth: 5 },
    });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));
    expect(res.ok).toBe(true);
    const output = res.output as { a11y: unknown; omittedSubtrees?: number };
    expect(output.omittedSubtrees).toBeGreaterThan(0);
    // A model must never receive a half-serialized node.
    expect(() => JSON.parse(JSON.stringify(output.a11y))).not.toThrow();
    expect(res.stateToken).toBeDefined();
  });

  it("returns the console tail, newest last, byte-capped", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      type: "log",
      text: `line-${i}`,
      at: i,
    }));
    const page = fakePage({ url: "https://x.test/", console: entries });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, {
      console: { maxEntries: 3, maxEntryBytes: 100 },
    });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "console" }));
    const output = res.output as {
      console: Array<{ text: string }>;
      omitted?: number;
    };
    expect(output.console.map((e) => e.text)).toEqual([
      "line-7",
      "line-8",
      "line-9",
    ]);
    expect(output.omitted).toBe(7);
  });

  it("reports a page with no WebMCP as a normal answer, not an error", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    // "This page offers no WebMCP tools" is the COMMON case; treating it as a
    // failure would teach the model that cooperation is a precondition.
    const res = await driver.execute(
      cmd({ kind: "observe", mode: "webmcp_tools" }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ webmcpSupported: false, tools: [] });
  });

  it("lists the page's WebMCP tools when the bridge has them", async () => {
    const bridge = {
      isSupported: () => true,
      list: () => [{ name: "book_flight", origin: "https://x.test" }],
    };
    const page = fakePage({ url: "https://x.test/", webmcp: bridge as never });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({ kind: "observe", mode: "webmcp_tools" }),
    );
    expect(res.output).toMatchObject({
      webmcpSupported: true,
      tools: [{ name: "book_flight" }],
    });
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

  it("flags settled:false when the URL shifts mid-capture even if the DOM skeleton holds (P1)", async () => {
    // A same-skeleton client-side route change: DOM signal is unchanged, but the
    // URL moves — the token must not bind a new-route url to an old-route image.
    let n = 0;
    const page = fakePage({
      url: "https://x.test/a",
      dom: "0BODY>1MAIN", // never changes
      onScreenshot: ({ setUrl }) => setUrl(`https://x.test/route-${++n}`),
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/a" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "screenshot" }));
    expect(res.settled).toBe(false);
    expect(res.stateToken!.urlHash).toBe(shortHash(`https://x.test/route-${n}`));
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
  it("opens a named new tab, and refuses to replace an existing one", async () => {
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://a.test/" }, "t1"));

    // A named new tab is created alongside the first.
    const opened = await driver.execute(
      cmd({ kind: "navigate", url: "https://b.test/", newTab: true }, "t2"),
    );
    expect(opened.ok).toBe(true);
    expect(created).toHaveLength(2);

    // Re-using a live tabId would silently replace that tab's page — the
    // exact confusion the P2 guard exists to prevent.
    const clash = await driver.execute(
      cmd({ kind: "navigate", url: "https://c.test/", newTab: true }, "t1"),
    );
    expect(clash).toMatchObject({ ok: false });
    expect(clash.error).toContain("tab_exists");
    expect(created).toHaveLength(2);
  });

  it("refuses an unnamed new tab — the tabId is how it would be addressed", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    const res = await driver.execute(
      cmd({ kind: "navigate", url: "https://x.test/", newTab: true }),
    );
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toContain("explicit tabId");
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

describe("ChromiumDriver — act verbs (W3)", () => {
  /** Navigate first so a tab exists, then run one act. */
  async function acted(
    action: Extract<Parameters<typeof cmd>[0], { kind: "act" }>,
    pageInit: Parameters<typeof fakePage>[0] = {},
  ) {
    const page = fakePage({ url: "https://x.test/", ...pageInit });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd(action));
    return { res, page };
  }

  it("dispatches each verb to its primitive, by coordinates or selector", async () => {
    const cases: Array<[Parameters<typeof acted>[0], string]> = [
      [{ kind: "act", verb: "click", target: { coordinates: [12, 34] } }, "click:12,34"],
      [{ kind: "act", verb: "click", target: { selector: "#go" } }, "click:#go"],
      [{ kind: "act", verb: "hover", target: { coordinates: [5, 6] } }, "hover:5,6"],
      [{ kind: "act", verb: "hover", target: { selector: ".menu" } }, "hover:.menu"],
      [{ kind: "act", verb: "type", value: "hello" }, "type:hello"],
      [
        { kind: "act", verb: "type", target: { selector: "#email" }, value: "a@b.c" },
        "fill:#email:a@b.c",
      ],
      [{ kind: "act", verb: "press", value: "Enter" }, "press:Enter"],
      [{ kind: "act", verb: "scroll" }, "scroll:0,600"],
      [{ kind: "act", verb: "scroll", value: "up" }, "scroll:0,-600"],
      [{ kind: "act", verb: "scroll", value: "250" }, "scroll:0,250"],
      [{ kind: "act", verb: "scroll", value: "10,20" }, "scroll:10,20"],
      [
        { kind: "act", verb: "drag", target: { coordinates: [1, 2] }, value: "9,8" },
        "drag:1,2->9,8",
      ],
      [
        { kind: "act", verb: "select", target: { selector: "#size" }, value: "L" },
        "select:#size:L",
      ],
    ];
    for (const [action, expected] of cases) {
      const { res, page } = await acted(action);
      expect(res.ok, `${action.verb} should succeed`).toBe(true);
      expect(page.calls.acts).toEqual([expected]);
    }
  });

  it("folds the post-act observation into the result (L1)", async () => {
    // The whole point: after an act the model already HAS the new screenshot,
    // url and a fresh token — it never spends a turn asking "what happened?".
    const { res, page } = await acted({
      kind: "act",
      verb: "click",
      target: { coordinates: [1, 1] },
    });
    expect(res.output).toMatchObject({
      url: "https://x.test/",
      screenshot: "BASE64PNG",
    });
    expect(res.settled).toBe(true);
    expect(res.stateToken).toBeDefined();
    expect(page.calls.shots).toBe(1);
  });

  it("reports an unresolvable target as target_not_found, with the current state", async () => {
    const { res } = await acted(
      { kind: "act", verb: "click", target: { selector: "#gone" } },
      { actError: new Error("Timeout 15000ms exceeded waiting for locator") },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("target_not_found");
    // A failed act still hands back where the page IS, so the model can re-aim.
    expect(res.stateToken).toBeDefined();
    expect(res.output).toMatchObject({ url: "https://x.test/" });
  });

  it("refuses a11yRef targeting explicitly rather than silently mis-clicking", async () => {
    const { res } = await acted({
      kind: "act",
      verb: "click",
      target: { a11yRef: "node-7" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unsupported_target");
  });

  it("refuses verbs that are missing what they need", async () => {
    const missing: Array<Parameters<typeof acted>[0]> = [
      { kind: "act", verb: "click" }, // no target
      { kind: "act", verb: "press" }, // no key
      { kind: "act", verb: "select", target: { selector: "#s" } }, // no value
      { kind: "act", verb: "drag", target: { coordinates: [1, 2] } }, // no dest
    ];
    for (const action of missing) {
      const { res } = await acted(action);
      expect(res.ok, `${action.verb} without its input must fail`).toBe(false);
    }
  });

  it("closes and activates tabs", async () => {
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    expect(
      await driver.execute(cmd({ kind: "act", verb: "activate_tab" })),
    ).toMatchObject({ ok: true });
    expect(page.calls.front).toBe(1);

    expect(
      await driver.execute(cmd({ kind: "act", verb: "close_tab" })),
    ).toMatchObject({ ok: true, output: { closed: "@session" } });
    // The tab is really gone: a follow-up act finds no tab rather than a
    // closed page it might try to drive.
    expect(
      await driver.execute(cmd({ kind: "act", verb: "click", target: { coordinates: [1, 1] } })),
    ).toMatchObject({ ok: false, error: "unknown_tab: @session" });
  });

  it("returns unknown_tab for an act on a tab that was never created", async () => {
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);
    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [1, 1] } }, "ghost"),
    );
    expect(res).toMatchObject({ ok: false, error: "unknown_tab: ghost" });
    expect(created).toHaveLength(0);
  });
});

describe("ChromiumDriver — webmcp actions (W3)", () => {
  function bridgeStub(over: Record<string, unknown> = {}) {
    return {
      isSupported: () => true,
      list: () => [],
      invoke: async () => ({ invocationId: "inv-1", output: { ok: true } }),
      cancel: async () => true,
      ...over,
    } as never;
  }

  async function withBridge(bridge: unknown) {
    const page = fakePage({ url: "https://x.test/", webmcp: bridge as never });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    return driver;
  }

  it("invokes a page tool and returns its output with a fresh token", async () => {
    const driver = await withBridge(bridgeStub());
    const res = await driver.execute(
      cmd({ kind: "webmcp_invoke", toolKey: "book_flight", input: { seat: "1A" } }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({
      invocationId: "inv-1",
      result: { ok: true },
    });
    expect(res.stateToken).toBeDefined();
  });

  it("caps an oversized tool output rather than half-serializing it (L9)", async () => {
    const huge = { rows: Array.from({ length: 20_000 }, (_, i) => i) };
    const driver = await withBridge(
      bridgeStub({ invoke: async () => ({ invocationId: "inv-1", output: huge }) }),
    );
    const res = await driver.execute(
      cmd({ kind: "webmcp_invoke", toolKey: "dump", input: {} }),
    );
    const output = res.output as { result: unknown; omitted?: boolean };
    expect(output.omitted).toBe(true);
    expect(typeof output.result).toBe("string");
  });

  it("surfaces a typed bridge failure verbatim", async () => {
    const { WebMcpBridgeError } = await import("../webmcp-bridge");
    const driver = await withBridge(
      bridgeStub({
        invoke: async () => {
          throw new WebMcpBridgeError("webmcp_tool_gone", "The page no longer offers it.");
        },
      }),
    );
    const res = await driver.execute(
      cmd({ kind: "webmcp_invoke", toolKey: "vanished", input: {} }),
    );
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toContain("webmcp_tool_gone");
  });

  it("reports an unsupported page without pretending it errored", async () => {
    const driver = await withBridge(bridgeStub({ isSupported: () => false }));
    const res = await driver.execute(
      cmd({ kind: "webmcp_invoke", toolKey: "t", input: {} }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("webmcp_unsupported");
  });

  it("cancels an invocation and says whether the bridge knew it", async () => {
    const driver = await withBridge(bridgeStub({ cancel: async () => false }));
    const res = await driver.execute(
      cmd({ kind: "webmcp_cancel", invocationId: "inv-9" }),
    );
    expect(res).toMatchObject({ ok: true, output: { cancelled: false } });
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

describe("ChromiumDriver — loud resume after a human handoff (L6/W4)", () => {
  it("attaches the handoff note to the FIRST observation after a resume, once", async () => {
    const page = fakePage({ url: "https://bank.test/", dom: "0BODY" });
    const { context } = fakeContext({ pages: [page] });
    const lease = new HandoffLease();
    const driver = new ChromiumDriver(context, { lease });

    await driver.execute(cmd({ kind: "navigate", url: "https://bank.test/" }));

    // A person takes the browser (an SSO login), then hands it back.
    lease.acquire("panel-a", 60_000);
    lease.resume("panel-a");

    const first = await driver.execute(cmd({ kind: "observe", mode: "url" }));
    expect(first.output).toMatchObject({ handoffNote: RESUMED_AFTER_HANDOFF_NOTE });
    // The note marks the observation that actually crossed the handoff — a
    // note on every later result would be noise the model learns to ignore.
    const second = await driver.execute(cmd({ kind: "observe", mode: "url" }));
    expect(second.output).not.toHaveProperty("handoffNote");
  });

  it("says nothing when no handoff happened", async () => {
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease: new HandoffLease() });
    const res = await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    expect(res.output).not.toHaveProperty("handoffNote");
  });

  it("rides an act's inline observation too (L1 + L6 together)", async () => {
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const lease = new HandoffLease();
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    lease.acquire("panel-a", 60_000);
    lease.resume("panel-a");
    const acted = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [4, 5] } }),
    );
    expect(acted.output).toMatchObject({ handoffNote: RESUMED_AFTER_HANDOFF_NOTE });
  });

  it("works without a lease at all (the daemon can run leaseless)", async () => {
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    const res = await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    expect(res.ok).toBe(true);
    expect(res.output).not.toHaveProperty("handoffNote");
  });
});

describe("ChromiumDriver — a FAILED act still reports the handoff (L6)", () => {
  it("carries the note on the failure result, so the model re-reads the page", async () => {
    const page = fakePage({ url: "https://x.test/", actError: new Error("no element") });
    const { context } = fakeContext({ pages: [page] });
    const lease = new HandoffLease();
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    lease.acquire("panel-a", 60_000);
    lease.resume("panel-a");
    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { selector: "#gone" } }),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatchObject({ handoffNote: RESUMED_AFTER_HANDOFF_NOTE });
  });
});
