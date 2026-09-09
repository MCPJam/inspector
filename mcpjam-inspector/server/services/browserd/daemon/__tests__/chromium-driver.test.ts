import { describe, expect, it, vi } from "vitest";
import { ChromiumDriver } from "../chromium-driver";
import { guardStaleness } from "../browser-driver";
import { shortHash } from "../state-token";
import type { BrowserCommand, ObservationStateToken } from "../../protocol";
import type { DriverContext } from "../browser-page";
import { HandoffLease, RESUMED_AFTER_HANDOFF_NOTE } from "../lease";
import { axTree, fakeContext, fakePage, type FakePage } from "./fake-page";

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

describe("ChromiumDriver — observe {mode:\"text\"}", () => {
  it("returns the page's readable text with a state token", async () => {
    const page = fakePage({ url: "https://x.test/", text: "# Title\n\nHello" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "text" }));
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ text: "# Title\n\nHello", url: "https://x.test/" });
    expect(res.stateToken).toMatchObject({ tabId: "@session" });
  });

  it("CUTS over-budget prose and says how much it kept", async () => {
    // Prose has no subtree boundary to omit at, so it is cut — and the marker
    // is what stops a model reading a third of a page as the whole of it.
    const page = fakePage({ url: "https://x.test/", text: "z".repeat(5_000) });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { pageTextBytes: 500 });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "text" }));
    const output = res.output as { text: string; truncated?: boolean };
    expect(output.truncated).toBe(true);
    expect(output.text).toContain("showing");
    expect(output.text).toContain("of 5000 bytes");
    expect(new TextEncoder().encode(output.text).byteLength).toBeLessThanOrEqual(500);
  });

  it("does not flag text that fit", async () => {
    const page = fakePage({ text: "short" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "text" }));
    expect(res.output).not.toHaveProperty("truncated");
  });

  it("flags settled:false when the page moves under the read", async () => {
    // The prose is from before the change and the token from after it. Left
    // unflagged, `guardStaleness` would admit an act chosen from text the page
    // no longer shows — the same P1 the screenshot loop exists for.
    const page = fakePage({ url: "https://x.test/", text: "first" });
    let reads = 0;
    const shifting = {
      ...page,
      async pageText() {
        reads += 1;
        // The page navigates while each read is in flight.
        page.setUrl(`https://x.test/step-${reads}`);
        return `text-${reads}`;
      },
    } as typeof page;
    const { context } = fakeContext({ pages: [shifting] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "text" }));

    expect(res.ok).toBe(true);
    expect(res.settled).toBe(false);
    expect(reads).toBeGreaterThan(1); // it retried before giving up
  });

  it("keeps settled true when the page holds still", async () => {
    const page = fakePage({ url: "https://x.test/", text: "steady" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "text" }));
    expect(res.settled).not.toBe(false);
  });

  it("refuses to hand over text captured while a person holds the browser", async () => {
    // Same rule as every other capture: a read in flight when someone takes
    // control must not return what they are looking at.
    const lease = new HandoffLease();
    const page = fakePage({
      text: "secret",
      onText: () => {
        lease.acquire("person-1", 60_000);
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "text" }));
    expect(res.ok).toBe(false);
    expect(res.leaseBlocked).toBe(true);
    expect(JSON.stringify(res)).not.toContain("secret");
  });
});

describe("ChromiumDriver — observe", () => {
  it("returns a screenshot / url / dom each with a fresh token", async () => {
    const page = fakePage({ url: "https://x.test/", dom: "0BODY>1DIV" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const shot = await driver.execute(cmd({ kind: "observe", mode: "screenshot" }));
    // `url` rides on EVERY observation, screenshots included: the unattended
    // origin allowlist is enforced against it, and a result without one would
    // pass that check by default.
    expect(shot.output).toEqual({
      url: "https://x.test/",
      screenshot: "BASE64PNG",
    });
    expect(shot.stateToken).toBeDefined();

    const url = await driver.execute(cmd({ kind: "observe", mode: "url" }));
    expect(url.output).toEqual({ url: "https://x.test/" });

    const dom = await driver.execute(cmd({ kind: "observe", mode: "dom" }));
    expect(dom.output).toEqual({ url: "https://x.test/", dom: "0BODY>1DIV" });
  });

  it("fails an observe on a tab that was never navigated", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    const res = await driver.execute(cmd({ kind: "observe", mode: "url" }, "ghost"));
    expect(res).toMatchObject({ ok: false, error: "unknown_tab: ghost" });
  });

  it("renders the tree as indented text with refs, not as JSON", async () => {
    // JSON cost roughly twice the tokens and carried no way to NAME an
    // element: the model could read about a button and then had to describe it
    // back as a coordinate or a guessed selector.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            {
              role: "navigation",
              name: "Primary",
              children: [
                { role: "link", name: "Docs", id: 11, props: { url: "https://x.test/docs" } },
                { role: "button", name: "Sign in", id: 12, props: { disabled: true } },
              ],
            },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    expect(res.ok).toBe(true);
    const output = res.output as { a11y: string; refs: Record<string, unknown> };
    // The named landmark earns a ref of its own: it is what `rootRef` zooms
    // into, and an anonymous one would not have.
    expect(output.a11y).toBe(
      [
        '- navigation "Primary" [ref=e1]',
        '  - link "Docs" [ref=e2 url=https://x.test/docs]',
        '  - button "Sign in" [disabled ref=e3]',
      ].join("\n"),
    );
    expect(output.refs).toEqual({
      e1: { role: "navigation", name: "Primary" },
      e2: { role: "link", name: "Docs" },
      e3: { role: "button", name: "Sign in" },
    });
  });

  it("defaults to the interactive view, and spends no budget on prose", async () => {
    // Filtering AFTER the budget would let a page of text report its buttons
    // as omitted — the one thing the interactive view exists to show.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            ...Array.from({ length: 40 }, (_, i) => ({
              role: "StaticText",
              name: `paragraph ${i}`,
            })),
            { role: "button", name: "Buried", id: 99 },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, {
      a11y: { maxNodes: 10, maxDepth: 5 },
    });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    const output = res.output as { a11y: string; refs: Record<string, unknown> };
    expect(output.a11y).toContain('button "Buried" [ref=e1]');
    expect(output.a11y).not.toContain("paragraph");
  });

  it('shows the prose when asked for filter:"all"', async () => {
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            { role: "StaticText", name: "Some words." },
            { role: "button", name: "Go", id: 7 },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", filter: "all" }),
    );

    const output = res.output as { a11y: string };
    expect(output.a11y).toContain('- text "Some words."');
    expect(output.a11y).toContain('- button "Go" [ref=e1]');
  });

  it("renders an omitted subtree with the ref that retrieves it", async () => {
    // "There is more here" without "and this is how you get it" only teaches a
    // model to guess. The marker used to name a `<selector for this element>`
    // placeholder nobody could type.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            {
              role: "region",
              name: "Results",
              id: 5,
              children: Array.from({ length: 30 }, (_, i) => ({
                role: "button",
                name: `b${i}`,
              })),
            },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, {
      a11y: { maxNodes: 4, maxDepth: 5 },
    });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    const output = res.output as { a11y: string; omittedSubtrees?: number };
    expect(output.omittedSubtrees).toBeGreaterThan(0);
    expect(output.a11y).toMatch(
      /- … \[\d+ node\(s\) omitted; observe \{mode:"a11y", rootRef:"e1"\} to read it\]/,
    );
  });

  it("numbers a duplicate role+name so an act can tell them apart", async () => {
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            { role: "button", name: "Delete", id: 21 },
            { role: "button", name: "Delete", id: 22 },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));
    const output = res.output as { a11y: string };
    // Two distinct refs for two identical labels — the whole point of a ref.
    expect(output.a11y).toContain('- button "Delete" [ref=e1]');
    expect(output.a11y).toContain('- button "Delete" [ref=e2]');
  });

  it("re-roots at a rootRef from the last observation", async () => {
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            {
              role: "region",
              name: "Panel",
              id: 31,
              children: [{ role: "button", name: "Go", id: 32 }],
            },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    const res = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );

    expect(res.ok).toBe(true);
    expect((res.output as { a11y: string }).a11y).toContain('button "Go"');
  });

  it("REFUSES a rootRef minted for a page this tab has left", async () => {
    // Node ids are per document. Without the token check the ref resolves
    // against whatever the NEW page happens to number the same, or falls
    // through to name-matching and answers with a same-named element on a page
    // the model never asked about.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            {
              role: "region",
              name: "Panel",
              id: 31,
              children: [{ role: "button", name: "Go", id: 32 }],
            },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.execute(cmd({ kind: "observe", mode: "a11y" }));
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/next" }));

    const res = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stale_ref/);
  });

  it("does not keep refs from an observation a handoff discarded", async () => {
    // The model never received them, so a guessed ref must not resolve against
    // the page a person was looking at.
    const lease = new HandoffLease();
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [{ role: "button", name: "Private", id: 77 }],
        }),
      },
      onA11y: () => lease.acquire("person-1", 60_000),
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const blocked = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));
    expect(blocked.leaseBlocked).toBe(true);

    lease.release("person-1");
    const guess = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );
    expect(guess.ok).toBe(false);
    expect(guess.error).toMatch(/unknown_ref|stale_ref/);
  });

  it("says a11y_unavailable when the page cannot answer, not 'nothing here'", async () => {
    // "There is nothing to click" sends the model elsewhere; "I could not read
    // this" sends it back to look again. Answering the first for the second is
    // how a model gives up on a page it never read.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: { "Accessibility.getFullAXTree": { nodes: [] } },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/a11y_unavailable/);
  });

  it("keeps a NAMED landmark in the interactive view, control or not", async () => {
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            { role: "search", name: "Site search", id: 51 },
            { role: "contentinfo", name: "Legal", id: 52 },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    const output = res.output as { a11y: string };
    expect(output.a11y).toContain('search "Site search" [ref=e1]');
    expect(output.a11y).toContain('contentinfo "Legal" [ref=e2]');
  });

  it("REFUSES a rootRef it never issued, rather than reading the whole page", async () => {
    // Silently widening to the whole page would answer a question the model
    // did not ask, and it would never learn its ref was stale.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({ role: "RootWebArea" }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e99" }),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown_ref/);
  });

  it("scopes the tree to rootSelector, which the marker still names", async () => {
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "DOM.getDocument": { root: { nodeId: 1 } },
        "DOM.querySelector": (params?: Record<string, unknown>) =>
          (params as { selector: string }).selector === "#panel"
            ? { nodeId: 2 }
            : { nodeId: 0 },
        "DOM.describeNode": { node: { backendNodeId: 41 } },
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            {
              role: "region",
              name: "Panel",
              id: 41,
              children: [{ role: "button", name: "Go", id: 42 }],
            },
          ],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootSelector: "#panel" }),
    );

    expect(res.ok).toBe(true);
    expect((res.output as { a11y: string }).a11y).toContain('button "Go"');
  });

  it("REFUSES a rootSelector that matches nothing, instead of answering an empty tree", async () => {
    // An empty tree reads as "that subtree is empty" — the model believes the
    // page and moves on. The error is the only version it can act on.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "DOM.getDocument": { root: { nodeId: 1 } },
        "DOM.querySelector": { nodeId: 0 },
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootSelector: "#gone" }),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown_selector/);
    expect(res.error).toContain("#gone");
  });

  it("says the tree is unavailable when the page cannot answer one", async () => {
    // Distinct from "your selector was wrong": telling a model its selector
    // missed, when the page has no tree at all, sends it hunting a bug that is
    // not there.
    const page = fakePage({ url: "https://x.test/" });
    page.cdpSession = null;
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/a11y_unavailable/);
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
    expect(res.output).toEqual({
      url: "https://x.test/",
      screenshot: "BASE64PNG",
    });
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
    return { res, page, driver };
  }

  /** An `Accessibility.getFullAXTree` reply with one named button. */
  function oneButton(name = "Sign in", id = 41) {
    return {
      "Accessibility.getFullAXTree": axTree({
        role: "RootWebArea",
        children: [{ role: "button", name, id }],
      }),
    };
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
    // The whole point: after an act the model already HAS the new page state
    // and a fresh token — it never spends a turn asking "what happened?".
    //
    // The DAEMON default is `screenshot`, which is what an act returned before
    // `observe` existed: an old caller against a new daemon must read exactly
    // the result it always read. The tool layer asks for `both` explicitly.
    const { res, page } = await acted({
      kind: "act",
      verb: "click",
      target: { coordinates: [1, 1] },
    });
    expect(res.output).toMatchObject({
      url: "https://x.test/",
      screenshot: "BASE64PNG",
    });
    expect(res.output).not.toHaveProperty("a11y");
    expect(res.settled).toBe(true);
    expect(res.stateToken).toBeDefined();
    expect(page.calls.shots).toBe(1);
  });

  it("hands back the tree of what to do NEXT, and commits its refs", async () => {
    // The round trip this PR exists to remove: an act used to return a picture,
    // and a model that wanted to know what was now CLICKABLE had to observe
    // again. The refs are committed exactly as an `observe` commits them, so
    // the zoom verb works off an act result too.
    const { res, driver } = await acted(
      {
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "a11y",
      },
      { cdpReplies: oneButton() },
    );

    const output = res.output as { a11y: string; refs: Record<string, unknown> };
    expect(res.ok).toBe(true);
    expect(output.a11y).toContain('- button "Sign in" [ref=e1]');
    expect(output.refs).toMatchObject({ e1: { role: "button", name: "Sign in" } });

    const zoomed = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );
    expect(zoomed.ok).toBe(true);
  });

  it("says where the page CAME FROM, but only when the act moved it", async () => {
    // An act that changed nothing about the address says nothing about it:
    // a `previousUrl` equal to `url` is a line on every result that teaches
    // the model nothing.
    const stayed = await acted(
      { kind: "act", verb: "click", target: { coordinates: [1, 1] } },
      { cdpReplies: oneButton() },
    );
    expect(stayed.res.output).not.toHaveProperty("previousUrl");

    // And one that DID move the page says so — which a bare `url` cannot:
    // the model reads the new address with no sign that it is new.

    const page = fakePage({ url: "https://x.test/", cdpReplies: oneButton() });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    page.onAct = () => page.setUrl("https://x.test/welcome");

    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [1, 1] } }),
    );

    expect(res.output).toMatchObject({
      previousUrl: "https://x.test/",
      url: "https://x.test/welcome",
    });
  });

  it("returns only what `observe` asked for", async () => {
    const cases: Array<[
      "a11y" | "screenshot" | "both" | "none",
      { a11y: boolean; screenshot: boolean },
    ]> = [
      ["a11y", { a11y: true, screenshot: false }],
      ["screenshot", { a11y: false, screenshot: true }],
      ["both", { a11y: true, screenshot: true }],
      ["none", { a11y: false, screenshot: false }],
    ];
    for (const [observe, want] of cases) {
      const { res, page } = await acted(
        {
          kind: "act",
          verb: "click",
          target: { coordinates: [1, 1] },
          observe,
        },
        { cdpReplies: oneButton() },
      );
      const output = res.output as Record<string, unknown>;
      expect(res.ok, `observe:${observe}`).toBe(true);
      expect("a11y" in output, `observe:${observe} tree`).toBe(want.a11y);
      expect("screenshot" in output, `observe:${observe} shot`).toBe(
        want.screenshot,
      );
      // The URL and the token ride on every act, whatever was asked for —
      // they are what the NEXT act is pinned to.
      expect(output.url).toBe("https://x.test/");
      expect(res.stateToken).toBeDefined();
      expect(page.calls.shots, `observe:${observe} shots`).toBe(
        want.screenshot ? 1 : 0,
      );
    }
  });

  it("keeps a successful act successful when the page cannot answer a tree", async () => {
    // A PDF, a chrome:// page, a renderer whose CDP session went away. Turning
    // a click that WORKED into a failed act because the aftermath could not be
    // described would be the worst possible trade.
    const { res } = await acted(
      {
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "both",
      },
      { cdpReplies: { "Accessibility.getFullAXTree": { nodes: [] } } },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({
      a11yUnavailable: true,
      screenshot: "BASE64PNG",
    });
    expect(res.output).not.toHaveProperty("a11y");
  });

  it("shows a FAILED act the page it failed on, tree and all", async () => {
    // "Your selector matched nothing" plus the list of what the page does
    // offer is one turn; the bare refusal is two.
    const { res } = await acted(
      {
        kind: "act",
        verb: "click",
        target: { selector: "#gone" },
        observe: "a11y",
      },
      {
        cdpReplies: oneButton(),
        actError: new Error("Timeout 15000ms exceeded waiting for locator"),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("target_not_found");
    const output = res.output as { a11y: string };
    expect(output.a11y).toContain('- button "Sign in" [ref=e1]');
    expect(res.stateToken).toBeDefined();
  });

  it("does not commit refs when a handoff lands during the POST-ACT read", async () => {
    // Same rule as `observe`: refs the model never received must not resolve
    // afterwards, or a guessed ref names a page a person was looking at.
    const lease = new HandoffLease();
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: oneButton("Private", 77),
      onA11y: () => lease.acquire("person-1", 60_000),
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const blocked = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "a11y",
      }),
    );
    expect(blocked.leaseBlocked).toBe(true);
    expect(JSON.stringify(blocked)).not.toContain("Private");

    lease.release("person-1");
    const guess = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );
    expect(guess.ok).toBe(false);
    expect(guess.error).toMatch(/unknown_ref|stale_ref/);
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

  it("presses Enter after the text when `submit` is set, once", async () => {
    // A search or a login was two gated calls — type, then press — which is
    // two approvals for a person and two observations for the model.
    const { res, page } = await acted({
      kind: "act",
      verb: "type",
      target: { selector: "#q" },
      value: "hello",
      submit: true,
    });
    expect(res.ok).toBe(true);
    expect(page.calls.acts).toEqual(["fill:#q:hello", "press:Enter"]);
    // ONE settle and ONE observation, not two.
    expect(page.calls.shots).toBe(1);
  });

  it("does not press Enter when `submit` is absent", async () => {
    const { page } = await acted({
      kind: "act",
      verb: "type",
      target: { selector: "#q" },
      value: "hello",
    });
    expect(page.calls.acts).toEqual(["fill:#q:hello"]);
  });

  it("fills each fill_form field in order, then submits", async () => {
    const { res, page } = await acted({
      kind: "act",
      verb: "fill_form",
      fields: [
        { selector: "#email", value: "a@b.c" },
        { selector: "#password", value: "hunter2" },
      ],
      submit: true,
    });
    expect(res.ok).toBe(true);
    expect(page.calls.acts).toEqual([
      "fill:#email:a@b.c",
      "fill:#password:hunter2",
      "press:Enter",
    ]);
    expect(page.calls.shots).toBe(1);
  });

  it("falls back to selectOption when the field turns out to be a <select>", async () => {
    // The model read "Size" off a tree and wants "L" in it. Making it work out
    // first what KIND of control it is looking at is work the driver can do
    // from the refusal `fillSelector` already gives.
    const { res, page } = await acted(
      {
        kind: "act",
        verb: "fill_form",
        fields: [
          { selector: "#name", value: "Ada" },
          { selector: "#size", value: "L" },
        ],
      },
      {
        actErrorFor: (entry) =>
          entry === "fill:#size:L"
            ? new Error("Error: Element is not an <input>, <textarea> or [contenteditable]")
            : undefined,
      },
    );
    expect(res.ok).toBe(true);
    expect(page.calls.acts).toEqual([
      "fill:#name:Ada",
      "fill:#size:L",
      "select:#size:L",
    ]);
  });

  it("does NOT fall back to selectOption for a field that is merely unfillable", async () => {
    // Playwright's two refusals differ by one item in the same list, and both
    // say "not an <input>". Falling back on the second sent a `fill` aimed at
    // a button off to `selectOption`, which then failed for its own unrelated
    // reason — so the model was told about a missing option rather than about
    // an element that cannot be filled.
    const { res, page } = await acted(
      {
        kind: "act",
        verb: "fill_form",
        fields: [{ selector: "#go", value: "x" }],
      },
      {
        actErrorFor: (entry) =>
          entry === "fill:#go:x"
            ? new Error(
                "page.fill: Error: Element is not an <input>, <textarea>, " +
                  "<select> or [contenteditable] and does not have a role " +
                  "allowing [aria-readonly]",
              )
            : undefined,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("fill_form_failed");
    expect(res.error).toContain("not an <input>");
    // The point: no `selectOption` was attempted on it.
    expect(page.calls.acts).toEqual(["fill:#go:x"]);
  });

  it("keeps a completed act successful when the page cannot be read afterwards", async () => {
    // `domStructureSignal` is an in-page evaluate and a navigation destroys the
    // context it runs in — which is what a submitted form does. Reported as a
    // command failure, the obvious next move for a model is to try again, and
    // the form is submitted twice.
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    let acted = false;
    page.onAct = () => {
      acted = true;
    };
    const original = page.domStructureSignal.bind(page);
    page.domStructureSignal = async () => {
      // The PRE-act read still works; only the post-act one is destroyed.
      if (!acted) return original();
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    };

    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { selector: "#submit" } }),
    );

    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ observationFailed: true });
    // NO TOKEN: the tool layer keeps the one it had, the next act pins to that,
    // and the guard refuses it with a fresh look rather than acting blind.
    expect(res.stateToken).toBeUndefined();
    expect(res.settled).toBe(false);
    // WHERE IT HAPPENED, on this path too. The unattended origin allowlist is
    // enforced against a result's `url` and fails OPEN without one, and this
    // return does not go through the `observation` funnel that normally stamps
    // it.
    expect(res.output).toMatchObject({ url: "https://x.test/" });
  });

  it("hands back NO capture when it cannot even name the page it came from", async () => {
    // A closed page answers no URL, and without one the allowlist has nothing
    // to check — so what goes is the capture, not the check.
    const page = fakePage({ url: "https://secret.test/", cdpReplies: oneButton() });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://secret.test/" }));
    let acted = false;
    page.onAct = () => {
      acted = true;
    };
    const original = page.domStructureSignal.bind(page);
    page.domStructureSignal = async () => {
      if (!acted) return original();
      throw new Error("Execution context was destroyed");
    };
    page.url = () => {
      if (!acted) return "https://secret.test/";
      throw new Error("page has been closed");
    };

    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "both",
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ observationFailed: true });
    expect(JSON.stringify(res)).not.toContain("BASE64PNG");
    expect(JSON.stringify(res)).not.toContain("Sign in");
  });

  it("does not fail an act because the TREE could not be read", async () => {
    // Same rule one read earlier: `renderA11y` attaches CDP and walks a tree,
    // and a closing tab rejects rather than answering.
    const page = fakePage({ url: "https://x.test/" });
    page.cdp = async () => {
      throw new Error("Target closed");
    };
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "a11y",
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ a11yUnavailable: true });
  });

  it("does not treat an unfillable INPUT TYPE as a dropdown either", async () => {
    // Playwright's third refusal shape: `Input of type "checkbox" cannot be
    // filled`. It names neither `<input>` nor `<select>`, so the discriminator
    // must leave it alone — a checkbox is not a field that wanted
    // `selectOption`.
    const { res, page } = await acted(
      {
        kind: "act",
        verb: "fill_form",
        fields: [{ selector: "#agree", value: "yes" }],
      },
      {
        actErrorFor: (entry) =>
          entry === "fill:#agree:yes"
            ? new Error('page.fill: Error: Input of type "checkbox" cannot be filled')
            : undefined,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("cannot be filled");
    expect(page.calls.acts).toEqual(["fill:#agree:yes"]);
  });

  it("stops at the first real failure and says which fields went in", async () => {
    // Half a filled form is a state the page is in and the model cannot see.
    const { res, page } = await acted(
      {
        kind: "act",
        verb: "fill_form",
        fields: [
          { selector: "#a", value: "1" },
          { selector: "#b", value: "2" },
          { selector: "#c", value: "3" },
        ],
      },
      {
        actErrorFor: (entry) =>
          entry === "fill:#b:2"
            ? new Error("Timeout 15000ms exceeded waiting for locator\nmore prose")
            : undefined,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error!.startsWith("fill_form_failed: field 2 (#b):")).toBe(true);
    expect(res.error!.endsWith("fields 1..1 were filled")).toBe(true);
    // The regex that classifies an unknown throw would have re-labelled this
    // `target_not_found: fill_form_failed: …` — two codes, the outer one wrong.
    expect(res.error).not.toContain("target_not_found");
    // Only the fields up to the failure were touched: #c was never attempted.
    expect(page.calls.acts).toEqual(["fill:#a:1", "fill:#b:2"]);
  });

  it("refuses a verb it does not know instead of answering ok for nothing", async () => {
    // A newer inspector can reach an older daemon — the lazy-upgrade path
    // reuses a running one — and a verb with no case in the switch used to
    // fall straight through and be reported as a successful act. A form
    // "filled" with every field still empty is the worst kind of wrong answer:
    // the model believes it and moves on.
    const { res, page } = await acted({
      kind: "act",
      verb: "teleport" as never,
      target: { selector: "#x" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("act_failed");
    expect(res.error).toContain("older build");
    expect(page.calls.acts).toHaveLength(0);
  });

  it("stops a fill_form the moment a person takes the browser mid-form", async () => {
    // The pre-act check covers one dispatch; `fill_form` is a LOOP of page
    // writes, so without a check between steps the rest of the form — and the
    // Enter — is typed into a browser somebody is already using.
    const lease = new HandoffLease();
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    page.onAct = () => {
      // Taken while the FIRST field is being filled.
      if (page.calls.acts.length === 1) lease.acquire("rail-1", 60_000);
    };

    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "fill_form",
        fields: [
          { selector: "#a", value: "1" },
          { selector: "#b", value: "2" },
          { selector: "#c", value: "3" },
        ],
        submit: true,
      }),
    );

    expect(res.leaseBlocked).toBe(true);
    // Field 1 landed before the handoff; nothing after it did, and no Enter.
    expect(page.calls.acts).toEqual(["fill:#a:1"]);
    // And the model is told so, because "nothing was run" would have it fill
    // the same fields again on top of the ones that are already there.
    expect(res.error).toContain("partway through");
  });

  it("does not run the <select> FALLBACK into a browser taken mid-fill", async () => {
    // The fallback is a page write on the far side of an await that can run
    // for the whole act timeout — the longest window in a composite, and the
    // one a per-field check at the top of the loop does not cover.
    const lease = new HandoffLease();
    const page = fakePage({
      url: "https://x.test/",
      // The person takes the browser while this field's fill is in flight; the
      // fill then refuses the way a `<select>` does.
      actErrorFor: (entry) => {
        if (entry !== "fill:#size:L") return undefined;
        lease.acquire("rail-1", 60_000);
        return new Error(
          "page.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element",
        );
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "fill_form",
        fields: [{ selector: "#size", value: "L" }],
      }),
    );

    expect(res.leaseBlocked).toBe(true);
    // The refusal keeps its own shape rather than being relabelled a field
    // failure — that flag is what the handler maps to 423.
    expect(res.error).toMatch(/^lease_held:/);
    expect(res.error).not.toContain("fill_form_failed");
    // And the dropdown was never touched.
    expect(page.calls.acts).toEqual(["fill:#size:L"]);
  });

  it("does not press Enter into a browser taken between the text and the submit", async () => {
    const lease = new HandoffLease();
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    page.onAct = () => lease.acquire("rail-1", 60_000);

    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "type",
        target: { selector: "#q" },
        value: "hello",
        submit: true,
      }),
    );

    expect(res.leaseBlocked).toBe(true);
    expect(page.calls.acts).toEqual(["fill:#q:hello"]);
  });

  it("sends NO token when the page moved while it was being captured", async () => {
    // A token minted after an image describes a page the image may not show —
    // and that is the dangerous direction: an act chosen from the stale image
    // and pinned to that token MATCHES the live tab and sails through the
    // staleness guard. Sending no token instead leaves the turn pinned to its
    // previous one, which the guard refuses with a fresh look.
    const page = fakePage({
      url: "https://x.test/",
      // The DOM shifts during the capture, exactly as a late banner does.
      onScreenshot: ({ setDom }) => setDom("0BODY>1BANNER"),
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "screenshot",
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ screenshot: "BASE64PNG" });
    expect(res.stateToken).toBeUndefined();
    expect(res.settled).toBe(false);
    // And the URL the capture belongs to, which the origin allowlist reads and
    // which this return has to stamp itself — `observation` is skipped here.
    expect(res.output).toMatchObject({ url: "https://x.test/" });
  });

  it("keeps the token when the page held still across the capture", async () => {
    const { res } = await acted(
      {
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "screenshot",
      },
      {},
    );
    expect(res.stateToken).toBeDefined();
    expect(res.settled).toBe(true);
  });

  it("does not hand out refs from a capture the page moved under", async () => {
    // Same rule as a discarded observation: refs bound to no token would be
    // names for a page nobody can prove the model was shown.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: oneButton(),
      onScreenshot: ({ setDom }) => setDom("0BODY>1BANNER"),
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "both",
      }),
    );
    expect(res.stateToken).toBeUndefined();
    // The INDEX is not advertised either: a ref map is a promise only
    // `commitRefs` can keep, and there is no token here to bind one to.
    expect(res.output).not.toHaveProperty("refs");

    const zoom = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );
    expect(zoom.ok).toBe(false);
    expect(zoom.error).toMatch(/unknown_ref|stale_ref/);
  });

  it("drops refs the tab ALREADY held when a capture goes unstable", async () => {
    // The act destabilised the page, so a map minted by an earlier observation
    // describes a state nobody has been shown since — and `refsStillDescribe`
    // will not catch it, because it compares which navigation and which URL
    // rather than the shape. This act reads no tree of its own, so nothing but
    // an unconditional drop covers it.
    // The shift lands INSIDE the capture — `onAct` would be too early, since
    // the frame is sampled after the verb and after settling. Only the
    // observation modes that take a picture reach this hook, so the two a11y
    // reads below are untouched by it.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: oneButton(),
      onScreenshot: ({ setDom }) => setDom("0BODY>1BANNER"),
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    // A good observation first: e1 is real and usable.
    await driver.execute(cmd({ kind: "observe", mode: "a11y" }));
    expect(
      (await driver.execute(cmd({ kind: "observe", mode: "a11y", rootRef: "e1" })))
        .ok,
    ).toBe(true);

    // Now a SCREENSHOT-only act during which the page shifts.
    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "screenshot",
      }),
    );
    expect(res.stateToken).toBeUndefined();

    const zoom = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );
    expect(zoom.ok).toBe(false);
    expect(zoom.error).toMatch(/unknown_ref|stale_ref/);
  });

  it("drops stored refs when an act ASKED for a tree and could not get one", async () => {
    // `a11yUnavailable` leaves no new map, and the old one then answered for a
    // page this act has since changed and failed to describe —
    // `refsStillDescribe` compares which navigation and which URL, so a
    // same-document change leaves it satisfied.
    const page = fakePage({ url: "https://x.test/", cdpReplies: oneButton() });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.execute(cmd({ kind: "observe", mode: "a11y" }));
    expect(
      (await driver.execute(cmd({ kind: "observe", mode: "a11y", rootRef: "e1" })))
        .ok,
    ).toBe(true);

    // The act asks for a tree; the page can no longer answer one.
    page.cdpSession = null;
    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "a11y",
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ a11yUnavailable: true });

    page.cdpSession = undefined; // the page can answer again
    const zoom = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );
    expect(zoom.ok).toBe(false);
    expect(zoom.error).toMatch(/unknown_ref|stale_ref/);
  });

  it("keeps the tab's refs when an act never asked about the tree", async () => {
    // The other half of the same condition: refs are meant to survive a DOM
    // mutation, and a stable screenshot-only act is no reason to lose them.
    const page = fakePage({ url: "https://x.test/", cdpReplies: oneButton() });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "screenshot",
      }),
    );

    expect(
      (await driver.execute(cmd({ kind: "observe", mode: "a11y", rootRef: "e1" })))
        .ok,
    ).toBe(true);
  });

  it("does not advertise refs it could not store when the read failed", async () => {
    const page = fakePage({ url: "https://x.test/", cdpReplies: oneButton() });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    let acted = false;
    page.onAct = () => {
      acted = true;
    };
    const original = page.domStructureSignal.bind(page);
    page.domStructureSignal = async () => {
      if (!acted) return original();
      throw new Error("Execution context was destroyed");
    };

    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        observe: "a11y",
      }),
    );

    expect(res.output).toMatchObject({ observationFailed: true });
    expect(res.output).not.toHaveProperty("refs");
    const zoom = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", rootRef: "e1" }),
    );
    expect(zoom.ok).toBe(false);
  });

  it("refuses malformed fill_form fields without touching the page", async () => {
    // The handler validates the ENVELOPE and passes the action through
    // untouched, so this is the only layer that can refuse it.
    const malformed: Array<Parameters<typeof acted>[0]> = [
      { kind: "act", verb: "fill_form" },
      { kind: "act", verb: "fill_form", fields: [] },
      {
        kind: "act",
        verb: "fill_form",
        fields: [{ selector: "", value: "x" }],
      },
      {
        kind: "act",
        verb: "fill_form",
        fields: [{ selector: "#a" } as never],
      },
    ];
    for (const action of malformed) {
      const { res, page } = await acted(action);
      expect(res.ok, JSON.stringify(action)).toBe(false);
      expect(res.error).toContain("act_failed");
      expect(res.error).toContain("fill_form needs fields");
      expect(page.calls.acts).toHaveLength(0);
    }
  });

  it("refuses a ref this tab never issued, naming the recovery", async () => {
    // `node-7` is not even ref-shaped, which is the shape of the real mistake:
    // a model quoting an id it read somewhere else. The refusal must send it
    // to a fresh observation rather than to a selector.
    const { res } = await acted({
      kind: "act",
      verb: "click",
      target: { a11yRef: "node-7" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown_ref");
    expect(res.error).toContain("observe again");
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

  it("REFUSES a coordinate outside the observation viewport, without dispatching", async () => {
    // Chromium delivers an out-of-viewport mouse event happily: it hits
    // nothing, and the caller reads a normal post-act observation that is
    // indistinguishable from a click landing on empty space. Refusing is the
    // only outcome the model can recover from.
    const { res, page } = await acted({
      kind: "act",
      verb: "click",
      target: { coordinates: [1200, 40] },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/out_of_viewport/);
    expect(res.error).toContain("1024x768");
    expect(page.calls.acts).toHaveLength(0); // nothing was dispatched
  });

  it("refuses a NEGATIVE coordinate too", async () => {
    const { res } = await acted({
      kind: "act",
      verb: "click",
      target: { coordinates: [10, -1] },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/out_of_viewport/);
  });

  it("allows the far corner — the bound is inclusive of the last pixel", async () => {
    // Guards the off-by-one that would make the bottom-right of every
    // screenshot unclickable.
    const { res, page } = await acted({
      kind: "act",
      verb: "click",
      target: { coordinates: [1023, 767] },
    });
    expect(res.ok).toBe(true);
    expect(page.calls.acts).toContain("click:1023,767");
  });

  it("refuses a drag DESTINATION outside the viewport (it rides in a string)", async () => {
    // The destination bypasses the target check because it arrives as
    // `value: "x,y"`, so it needs its own bound.
    const { res, page } = await acted({
      kind: "act",
      verb: "drag",
      target: { coordinates: [10, 10] },
      value: "5000,20",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/out_of_viewport/);
    expect(page.calls.acts).toHaveLength(0);
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

  it("passes the caller's frame through, so a subframe's tool is not shadowed", async () => {
    // Two frames can register the same tool name, and name resolution prefers
    // the main frame. A caller acting on a tool it just listed says which
    // frame it saw; dropping that on the floor here would silently run the
    // wrong page's tool.
    const seen: Array<Record<string, unknown>> = [];
    const driver = await withBridge(
      bridgeStub({
        invoke: async (args: Record<string, unknown>) => {
          seen.push(args);
          return { invocationId: "inv-1", output: { ok: true } };
        },
      }),
    );
    await driver.execute(
      cmd({
        kind: "webmcp_invoke",
        toolKey: "book_flight",
        frameId: "frame-7",
        input: {},
      }),
    );
    expect(seen[0]).toMatchObject({
      toolName: "book_flight",
      frameId: "frame-7",
    });
  });

  it("sends no frame at all when the caller named none", async () => {
    // `frameId: undefined` and an absent key are not the same to a bridge that
    // checks `args.frameId &&` — but they are to `toMatchObject`, so this
    // asserts the key is genuinely absent rather than present-and-undefined.
    const seen: Array<Record<string, unknown>> = [];
    const driver = await withBridge(
      bridgeStub({
        invoke: async (args: Record<string, unknown>) => {
          seen.push(args);
          return { invocationId: "inv-1", output: {} };
        },
      }),
    );
    await driver.execute(
      cmd({ kind: "webmcp_invoke", toolKey: "book_flight", input: {} }),
    );
    expect("frameId" in seen[0]!).toBe(false);
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

/**
 * The guard and the real driver, together.
 *
 * `browser-driver.test.ts` pins the guard against a fake whose token is
 * whatever the test says it is. That cannot answer the question this suite
 * exists for: which page changes actually MOVE the token. A new element does
 * and typing into a field does not — and "the model may act on a page it
 * decided from, but not on one that grew a banner underneath it" is exactly
 * that distinction. It is only provable where the guard meets a driver that
 * computes the token from a real DOM signal.
 */
describe("guardStaleness(ChromiumDriver)", () => {
  /** A tab, an a11y-answering page, and the guarded executor over it. */
  async function pinned() {
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [{ role: "button", name: "Submit", id: 61 }],
        }),
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    const guarded = guardStaleness(driver);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const observed = await driver.execute(
      cmd({ kind: "observe", mode: "screenshot" }),
    );
    return {
      page,
      driver,
      guarded,
      token: observed.stateToken as ObservationStateToken,
    };
  }

  it("REFUSES the second act of a step whose first one changed the page — with the page", async () => {
    const { page, driver, guarded, token } = await pinned();
    // The first act adds an element, which is what a real "click, then the
    // dialog opens" does to the DOM.
    page.onAct = () => {
      page.onAct = undefined;
      page.setDom("0BODY>1DIALOG");
    };

    const first = await guarded(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        expectedState: token,
      }),
    );
    expect(first.ok).toBe(true);

    const second = await guarded(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [2, 2] },
        expectedState: token,
        observe: "a11y",
      }),
    );

    expect(second.ok).toBe(false);
    expect(second.staleObservation).toBe(true);
    expect(second.error).toBe("stale_observation");
    // THE POINT: the refusal carries the page, so re-deciding costs no extra
    // call. Told only "re-read the page", the model spends exactly the round
    // trip the token exists to save.
    const output = second.output as { a11y: string; url: string };
    expect(output.a11y).toContain('- button "Submit" [ref=e1]');
    expect(output.url).toBe("https://x.test/");
    expect(second.stateToken).toEqual(
      await driver.currentStateToken("@session"),
    );
    // And the click never landed: one act was dispatched, not two.
    expect(page.calls.acts).toEqual(["click:1,1"]);
  });

  it("admits the second act when the first only TYPED into the page", async () => {
    // A field's value is not part of the DOM skeleton, so "fill the email,
    // then fill the password" is one step that must survive. Refusing every
    // act after any act would make batching useless.
    const { page, guarded, token } = await pinned();

    const first = await guarded(
      cmd({
        kind: "act",
        verb: "type",
        target: { selector: "#email" },
        value: "a@b.c",
        expectedState: token,
      }),
    );
    expect(first.ok).toBe(true);

    const second = await guarded(
      cmd({
        kind: "act",
        verb: "type",
        target: { selector: "#password" },
        value: "hunter2",
        expectedState: token,
      }),
    );

    expect(second.ok).toBe(true);
    expect(second.staleObservation).toBeUndefined();
    expect(page.calls.acts).toEqual([
      "fill:#email:a@b.c",
      "fill:#password:hunter2",
    ]);
  });

  it("hands back a person taking the browser DURING the recovery read, not 'stale'", async () => {
    // Two refusals are in play and only one is true: the page did move, but a
    // person now holds the browser. Answering "stale" would send the model to
    // re-read a page it is not allowed to see.
    const lease = new HandoffLease();
    // Armed only for the RECOVERY read: the person takes the browser between
    // the guard's token read and the observation it owes the refusal.
    let armed = false;
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [{ role: "button", name: "Private", id: 62 }],
        }),
      },
      onA11y: () => {
        if (armed) lease.acquire("person-1", 60_000);
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    const guarded = guardStaleness(driver);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const observed = await driver.execute(
      cmd({ kind: "observe", mode: "screenshot" }),
    );
    page.setDom("0BODY>1DIALOG");
    armed = true;

    const refused = await guarded(
      cmd({
        kind: "act",
        verb: "click",
        target: { coordinates: [1, 1] },
        expectedState: observed.stateToken,
        observe: "a11y",
      }),
    );

    expect(refused.leaseBlocked).toBe(true);
    expect(refused.staleObservation).toBeUndefined();
    expect(JSON.stringify(refused)).not.toContain("Private");
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

describe("ChromiumDriver — a handoff's console does not outlive it (W4)", () => {
  it("DISCARDS console captured while a person held the browser", async () => {
    // The 423 gate stops an agent reading DURING a handoff. But the console
    // ring fills from an eager page listener that knows nothing about leases,
    // so without this the token a login page logged while someone signed in is
    // readable the instant they hand back — making the guarantee "you have to
    // wait to read it" rather than "it is private".
    let now = 1_000;
    const lease = new HandoffLease({ now: () => now });
    const page = fakePage({
      url: "https://bank.test/",
      console: [{ type: "log", text: "before the handoff", at: 500 }],
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://bank.test/" }));

    // A person takes the browser and signs in; the page logs as they go.
    lease.acquire("panel-a", 60_000);
    now = 2_000;
    page.pushConsole({ type: "log", text: "auth token: SECRET", at: 2_100 });
    page.pushConsole({ type: "error", text: "password field: hunter2", at: 2_200 });
    now = 3_000;
    lease.resume("panel-a");

    const observed = await driver.execute(cmd({ kind: "observe", mode: "console" }));
    const text = JSON.stringify(observed.output);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("hunter2");
    // What was logged BEFORE the handoff is ordinary page output and stays.
    expect(text).toContain("before the handoff");
  });

  it("purges once, not on every later command", async () => {
    let now = 1_000;
    const lease = new HandoffLease({ now: () => now });
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    lease.acquire("panel-a", 60_000);
    now = 2_000;
    lease.resume("panel-a");
    await driver.execute(cmd({ kind: "observe", mode: "url" })); // consumes it

    // Anything logged AFTER the handoff is normal traffic and must survive.
    page.pushConsole({ type: "log", text: "after the handoff", at: 4_000 });
    const observed = await driver.execute(cmd({ kind: "observe", mode: "console" }));
    expect(JSON.stringify(observed.output)).toContain("after the handoff");
  });

  it("purges every tab, not just the one being read", async () => {
    // A person may open a tab; a leak in one nobody is watching is still a leak.
    let now = 1_000;
    const lease = new HandoffLease({ now: () => now });
    const first = fakePage({ url: "https://a.test/" });
    const second = fakePage({ url: "https://b.test/" });
    const { context } = fakeContext({ pages: [first, second] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://a.test/" }));
    await driver.execute(
      cmd({ kind: "navigate", url: "https://b.test/", newTab: true }, "tab-2"),
    );

    lease.acquire("panel-a", 60_000);
    now = 2_000;
    first.pushConsole({ type: "log", text: "LEAK-A", at: 2_100 });
    second.pushConsole({ type: "log", text: "LEAK-B", at: 2_100 });
    now = 3_000;
    lease.resume("panel-a");

    const a = await driver.execute(cmd({ kind: "observe", mode: "console" }));
    const b = await driver.execute(cmd({ kind: "observe", mode: "console" }, "tab-2"));
    expect(JSON.stringify(a.output)).not.toContain("LEAK-A");
    expect(JSON.stringify(b.output)).not.toContain("LEAK-B");
  });

  it("DISCARDS both holds when two handoffs run back to back with no command between", async () => {
    // The realistic shape: sign in, hand back, a CAPTCHA appears, take it again,
    // hand back — and only THEN does the model get a turn. The purge is consumed
    // lazily, so at that point two holds are pending against one window. Keeping
    // the later start would drop the CAPTCHA's console and serve the sign-in's.
    let now = 1_000;
    const lease = new HandoffLease({ now: () => now });
    const page = fakePage({
      url: "https://bank.test/",
      console: [{ type: "log", text: "before any handoff", at: 500 }],
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://bank.test/" }));

    // Hold #1 — the sign-in.
    lease.acquire("panel-a", 60_000);
    now = 2_000;
    page.pushConsole({ type: "log", text: "auth token: SECRET-ONE", at: 2_100 });
    now = 3_000;
    lease.resume("panel-a");

    // Hold #2 — the CAPTCHA, before the model has run anything at all.
    now = 4_000;
    lease.acquire("panel-a", 60_000);
    now = 5_000;
    page.pushConsole({ type: "log", text: "captcha answer: SECRET-TWO", at: 5_100 });
    now = 6_000;
    lease.resume("panel-a");

    const observed = await driver.execute(cmd({ kind: "observe", mode: "console" }));
    const text = JSON.stringify(observed.output);
    expect(text).not.toContain("SECRET-ONE");
    expect(text).not.toContain("SECRET-TWO");
    expect(text).toContain("before any handoff");
  });
});

describe("ChromiumDriver — a handoff that happens MID-command (W4/L6)", () => {
  it("takes no screenshot when a person grabs the browser while the page settles", async () => {
    const lease = new HandoffLease();
    const page = fakePage({ url: "https://example.com/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });

    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));
    const shotsBefore = page.calls.shots;

    // The click dispatches, and the person takes control while the page is
    // still settling — exactly the window the handler's 423 cannot see.
    page.onAct = () => lease.acquire("rail-1", 60_000);

    const result = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [5, 5] } }),
    );

    expect(result.ok).toBe(false);
    expect(result.leaseBlocked).toBe(true);
    expect(result.error).toMatch(/^lease_held:/);
    // The act itself ran — we say so rather than pretending it did not — but
    // nothing looked at the page afterwards.
    expect(page.calls.acts).toHaveLength(1);
    expect(page.calls.shots).toBe(shotsBefore);
    expect(result.output).toBeUndefined();
    expect(result.stateToken).toBeUndefined();
  });

  it("reports a handoff during a FAILED act's read as the handoff, not as the failure", async () => {
    // Both are true — the selector missed AND a person took the browser — but
    // only one of them is what the caller must act on. The `leaseBlocked` flag
    // is what maps to 423 and what makes the turn drop its cached tokens; lose
    // it and the model is told to re-aim at a page somebody else is now using.
    const lease = new HandoffLease();
    let armed = false;
    const page = fakePage({
      url: "https://example.com/",
      actError: new Error("Timeout 15000ms exceeded waiting for locator"),
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [{ role: "button", name: "Private", id: 88 }],
        }),
      },
      // The person takes the browser during the post-failure read, not before
      // it — the pre-act snapshot must still let the act through.
      onA11y: () => {
        if (armed) lease.acquire("rail-1", 60_000);
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));
    armed = true;

    const result = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { selector: "#gone" },
        observe: "a11y",
      }),
    );

    expect(result.leaseBlocked).toBe(true);
    expect(result.error).toMatch(/^lease_held:/);
    expect(result.output).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Private");
  });

  it("does not dispatch the verb when the handoff lands during the PRE-ACT read", async () => {
    // The post-act observation is the easy half: `afterAct` can decline to
    // LOOK at the page. The act itself cannot be taken back — a password typed
    // into a person's browser is typed — so the permit is re-asked after the
    // one await that now sits between `execute`'s check and the dispatch.
    const lease = new HandoffLease();
    const page = fakePage({ url: "https://example.com/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));

    // The person clicks "Take control" while the pre-act snapshot evaluates.
    const original = page.domStructureSignal.bind(page);
    page.domStructureSignal = async () => {
      lease.acquire("rail-1", 60_000);
      return original();
    };

    const result = await driver.execute(
      cmd({
        kind: "act",
        verb: "type",
        target: { selector: "#password" },
        value: "hunter2",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.leaseBlocked).toBe(true);
    // NOTHING was typed into the browser the person is now holding.
    expect(page.calls.acts).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("still serves the holder's own commands while they hold it", async () => {
    const lease = new HandoffLease();
    lease.acquire("rail-1", 60_000);
    const page = fakePage({ url: "https://example.com/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });

    const result = await driver.execute({
      commandId: "m1",
      source: "manual",
      holder: "rail-1",
      action: { kind: "navigate", url: "https://example.com/login" },
    });

    expect(result.ok).toBe(true);
    expect(page.calls.goto).toEqual(["https://example.com/login"]);
  });
});

/**
 * The gap the earlier mid-command tests left: those pin the checks the driver
 * made BEFORE a read. These pin the ones it makes after, because every read
 * crosses an `await` and a handoff can land inside it. A result that is built
 * from the page must not be handed back by a driver that no longer has the
 * right to look at it.
 */
describe("ChromiumDriver — a handoff that lands DURING the read", () => {
  it("drops an a11y tree read while the lease was being taken", async () => {
    const lease = new HandoffLease();
    const page = fakePage({
      url: "https://example.com/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [{ role: "button", name: "private" }],
        }),
      },
      // The person clicks "Take control" while the tree is being walked.
      onA11y: () => lease.acquire("rail-1", 60_000),
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));

    const result = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    expect(result.ok).toBe(false);
    expect(result.leaseBlocked).toBe(true);
    expect(result.output).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("drops a console read the same way", async () => {
    const lease = new HandoffLease();
    const page = fakePage({
      url: "https://example.com/",
      console: [{ type: "log", text: "SECRET-IN-RING", at: 1 }],
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));
    // The ring is copied first, then the frame is read; take the browser in
    // between, which is the moment the copy is already in hand.
    const original = page.domStructureSignal.bind(page);
    page.domStructureSignal = async () => {
      lease.acquire("rail-1", 60_000);
      return original();
    };

    const result = await driver.execute(
      cmd({ kind: "observe", mode: "console" }),
    );

    expect(result.leaseBlocked).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET-IN-RING");
  });

  it("drops a WebMCP tool result that arrived after the handoff", async () => {
    const lease = new HandoffLease();
    const page = fakePage({
      url: "https://example.com/",
      onWebmcp: () => lease.acquire("rail-1", 60_000),
      webmcp: {
        isSupported: () => true,
        list: () => [],
        async invoke() {
          return { invocationId: "inv-1", output: "ACCOUNT-BALANCE" };
        },
        async cancel() {
          return true;
        },
      } as never,
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));

    const result = await driver.execute(
      cmd({ kind: "webmcp_invoke", toolKey: "read_account", input: {} }),
    );

    expect(result.ok).toBe(false);
    expect(result.leaseBlocked).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ACCOUNT-BALANCE");
  });

  it("does not take the unstable-page FALLBACK screenshot after a handoff", async () => {
    const lease = new HandoffLease();
    let shot = 0;
    const page = fakePage({
      url: "https://example.com/",
      // Never settles: every capture moves the DOM, so both attempts fail the
      // before/after comparison and the method reaches its fallback capture —
      // the one shot that used to be taken with no permit check at all.
      onScreenshot: ({ setDom }) => {
        shot += 1;
        setDom(`0BODY>${shot}DIV`);
        if (shot === 2) lease.acquire("rail-1", 60_000);
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));

    const result = await driver.execute(
      cmd({ kind: "observe", mode: "screenshot" }),
    );

    expect(result.ok).toBe(false);
    expect(result.leaseBlocked).toBe(true);
    // Two attempts, and NOT the third: the fallback capture never happened.
    expect(page.calls.shots).toBe(2);
    expect(result.output).toBeUndefined();
  });

  it("does not CALL a page's tool once control has changed", async () => {
    // Not just "withhold the result": a WebMCP tool changes the page. Running
    // one under somebody else's hands is the agent acting during a handoff,
    // whatever we then decide to return.
    const lease = new HandoffLease();
    const invocations: string[] = [];
    const page = fakePage({
      url: "https://example.com/",
      onWebmcp: () => lease.acquire("rail-1", 60_000),
      webmcp: {
        isSupported: () => true,
        list: () => [],
        async invoke({ toolName }: { toolName: string }) {
          invocations.push(toolName);
          return { invocationId: "inv-1", output: "ok" };
        },
        async cancel() {
          return true;
        },
      } as never,
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));

    const result = await driver.execute(
      cmd({ kind: "webmcp_invoke", toolKey: "transfer_funds", input: {} }),
    );

    expect(result.leaseBlocked).toBe(true);
    expect(invocations).toEqual([]);
  });

  it("withholds the page state a FAILED act would otherwise report", async () => {
    // The failure branch hands back the current URL and a fresh token so the
    // model can see what it hit. That is still a read of the page.
    const lease = new HandoffLease();
    const page = fakePage({
      url: "https://example.com/",
      actError: new Error("no element matches #pay"),
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));

    page.onAct = () => lease.acquire("rail-1", 60_000);
    const result = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { selector: "#pay" } }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.stateToken).toBeUndefined();
  });

  it("says the ACT ran even though its result is withheld", async () => {
    const lease = new HandoffLease();
    const page = fakePage({ url: "https://example.com/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://example.com/" }));

    page.onAct = () => lease.acquire("rail-1", 60_000);
    const result = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [1, 1] } }),
    );

    expect(result.error).toContain("the action ran");
  });
});

/**
 * The viewport cache is keyed by tabId; its contents belong to a PAGE. Every
 * case here is one where those two came apart.
 */
describe("ChromiumDriver — the viewport follows its page, not its name", () => {
  it("retires a closed tab's viewport instead of handing it out again", async () => {
    const first = fakePage({ url: "https://a.test/" });
    const second = fakePage({ url: "https://b.test/" });
    const { context } = fakeContext({ pages: [first, second] });
    const driver = new ChromiumDriver(context);

    await driver.execute(
      cmd({ kind: "navigate", url: "https://a.test/", newTab: true }, "tab-1"),
    );
    const before = await driver.viewport("tab-1");
    expect(before).not.toBeNull();

    await driver.execute(
      cmd({ kind: "act", verb: "close_tab" }, "tab-1"),
    );
    await driver.execute(
      cmd({ kind: "navigate", url: "https://b.test/", newTab: true }, "tab-1"),
    );
    const after = await driver.viewport("tab-1");

    // A fresh one, bound to the live page. The old viewport held the closed
    // page's CDP session: it would publish no frames and swallow every key.
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("drops a viewport whose page closed itself", async () => {
    const page = fakePage({ url: "https://a.test/" });
    const { context } = fakeContext({ pages: [page, fakePage()] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://a.test/" }));
    const before = await driver.viewport();

    // `window.close()`, or a crashed renderer: nothing went through the
    // driver, so only the freshness check here can notice.
    await page.close();
    const after = await driver.viewport();

    expect(after).not.toBe(before);
  });

  it("answers `viewportIfWatched` null until somebody actually watches", async () => {
    // The whole point of the second accessor: the frame-rate boost after an
    // agent command must not be what CREATES a viewport. On a box with no pane
    // open, going through `viewport()` would attach a CDP screencast and
    // start encoding JPEGs for nobody, on the same two cores the agent uses.
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);

    await driver.execute(cmd({ kind: "navigate", url: "https://a.test/" }));
    expect(driver.viewportIfWatched()).toBeNull();
    // ...and asking did not open anything, either.
    expect(created).toHaveLength(1);

    const watched = await driver.viewport();
    expect(await driver.viewportIfWatched()).toBe(watched);
  });

  it("never opens a tab of its own to answer `viewportIfWatched`", async () => {
    // `viewport()` opens the startup page on a miss (a person opening the pane
    // should see a browser, not an error). This must not.
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);

    expect(driver.viewportIfWatched()).toBeNull();
    expect(driver.viewportIfWatched("tab-9")).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("hands back the cached promise rather than doing any work of its own", async () => {
    // It reads the map and returns what is in it — the same promise
    // `viewport()` registered, not a second creation racing the first. Two
    // screencasts on one page is two encoders for one picture.
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);

    const watched = await driver.viewport();
    const openedSoFar = created.length;

    expect(driver.viewportIfWatched()).toBe(driver.viewportIfWatched());
    expect(await driver.viewportIfWatched()).toBe(watched);
    expect(created).toHaveLength(openedSoFar);
  });

  it("opens ONE page when two callers ask for the same tab at once", async () => {
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);

    const [a, b] = await Promise.all([driver.viewport(), driver.viewport()]);

    expect(created).toHaveLength(1);
    // ...and one viewport on it: two screencasts is two encoders for one
    // picture, and subscribers split between them.
    expect(a).toBe(b);
  });

  it("does not create a second page for a concurrent navigate and watch", async () => {
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);

    await Promise.all([
      driver.execute(cmd({ kind: "navigate", url: "https://a.test/" })),
      driver.viewport(),
    ]);

    expect(created).toHaveLength(1);
  });
});

describe("ChromiumDriver — teardown is bounded, and nothing opens behind it", () => {
  /** A context whose `newPage()` resolves only when the test says so. */
  function stallingContext() {
    const { context: base, created } = fakeContext();
    let release: ((page: FakePage) => void) | undefined;
    const context: DriverContext = {
      ...base,
      newPage: () =>
        new Promise<FakePage>((resolve) => {
          release = resolve;
        }),
    };
    return {
      context,
      created,
      /** Let the in-flight creation finish, returning the page it produced. */
      async land() {
        const page = fakePage({ url: "https://late.test/" });
        release?.(page);
        await Promise.resolve();
        await Promise.resolve();
        return page;
      },
    };
  }

  it("gives up on a tab creation that never lands rather than hanging shutdown", async () => {
    // A `newPage()` against a browser that has stopped answering never
    // settles. Waiting on it forever is not caution: `close()` runs on the
    // server's shutdown path, so the process never exits and the Chromium it
    // was trying to close is orphaned — the exact outcome the wait was added
    // to prevent.
    vi.useFakeTimers();
    try {
      const { context } = stallingContext();
      const driver = new ChromiumDriver(context);
      void driver.viewport().catch(() => {});
      await Promise.resolve();
      await Promise.resolve();

      let settled = false;
      const closing = driver.close().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      await closing;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a page that lands after teardown instead of adopting it", async () => {
    vi.useFakeTimers();
    try {
      const { context, land } = stallingContext();
      const driver = new ChromiumDriver(context);
      void driver.viewport().catch(() => {});
      await Promise.resolve();
      await Promise.resolve();

      const closing = driver.close();
      await vi.advanceTimersByTimeAsync(2_000);
      await closing;

      const late = await land();
      // Registering it would leave a renderer nobody will ever close, which is
      // the leak `pendingTabs` exists to prevent — moved one tick later.
      expect(late.isClosed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to open a tab once teardown has begun", async () => {
    const { context, created } = fakeContext();
    const driver = new ChromiumDriver(context);
    await driver.close();

    const result = await driver.execute(
      cmd({ kind: "navigate", url: "https://a.test/" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^driver_closed:/);
    expect(created).toHaveLength(0);
  });
});

describe("ChromiumDriver — the human pane's tab strip", () => {
  it("keeps the tab the video is showing inside the bounded strip", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    for (let at = 0; at < 20; at += 1) {
      await driver.execute(
        cmd({ kind: "navigate", url: `https://t${at}.test/` }, `t${at}`),
      );
    }
    const snapshot = driver.tabsSnapshot();
    expect(snapshot.list).toHaveLength(16);
    // The last one opened is the one Chromium is showing, which is what the
    // encoder is grabbing. Cutting the strip at sixteen dropped it, `active`
    // then fell away, and the picture changed with nothing highlighted.
    expect(snapshot.active).toBe("t19");
    expect(snapshot.list.map((tab) => tab.id)).toContain("t19");
  });

  it("bounds the strip by what JSON actually costs, not by raw length", async () => {
    // Every character here is two bytes once serialised, and the estimate that
    // sums raw lengths cannot see that. Eight of these pass a 4 KiB
    // raw-length budget and blow straight through it as JSON — which is the
    // form the 8 KiB record limit is applied to, by dropping the stream.
    const quotes = '"'.repeat(500);
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    for (let at = 0; at < 8; at += 1) {
      await driver.execute(
        cmd({ kind: "navigate", url: `https://t${at}.test/` }, `${quotes}${at}`),
      );
    }
    const snapshot = driver.tabsSnapshot();
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(4_096);
    expect(snapshot.active).toBe(`${quotes}7`);
  });

  it("never serialises an id the estimate has already rejected", async () => {
    // The estimate only ever UNDERCOUNTS, so "over budget by raw length" is
    // proof on its own. Without that shortcut the exact pass stringified a
    // megabyte of caller-chosen id on every heartbeat of every open stream,
    // only to throw the result away — attacker-priced CPU, several times a
    // second, for a strip that was always going to be empty.
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    await driver.execute(
      cmd({ kind: "navigate", url: "https://t.test/" }, "x".repeat(1_000_000)),
    );
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const snapshot = driver.tabsSnapshot();
      expect(snapshot.list).toHaveLength(0);
      expect(snapshot.active).toBeUndefined();
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("counts the bytes that go on the wire, not the characters", async () => {
    // One of these is 1 UTF-16 unit and 3 UTF-8 bytes. `.length` says the
    // strip fits; the reader, which applies its 8 KiB limit to bytes and drops
    // the stream when a record is over, says it does not.
    const cjk = "\u4e2d".repeat(400);
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    for (let at = 0; at < 6; at += 1) {
      await driver.execute(
        cmd({ kind: "navigate", url: `https://t${at}.test/` }, `${cjk}${at}`),
      );
    }
    const snapshot = driver.tabsSnapshot();
    expect(
      Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
    ).toBeLessThanOrEqual(4_096);
    expect(snapshot.active).toBe(`${cjk}5`);
  });

  it("bounds the strip in bytes, not just in entries", async () => {
    // A tab id is whatever the caller asked for — `getOrCreateTab` opens a
    // page under any string — so eight tabs is well inside the entry bound and
    // still over the reader's record limit.
    const long = "x".repeat(1_000);
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    for (let at = 0; at < 8; at += 1) {
      await driver.execute(
        cmd({ kind: "navigate", url: `https://t${at}.test/` }, `${long}-${at}`),
      );
    }
    const snapshot = driver.tabsSnapshot();
    expect(snapshot.list.length).toBeLessThan(8);
    expect(JSON.stringify(snapshot).length).toBeLessThan(8 * 1_024);
    // And what survives the trim is the one on screen.
    expect(snapshot.active).toBe(`${long}-7`);
  });
});

describe("ChromiumDriver — WebMCP revision cache", () => {
  /**
   * A bridge whose tool set a test can change, with a real subscription. The
   * driver's whole revision story is push-driven, so a stub with a no-op
   * `subscribe` would pin nothing.
   */
  function liveBridge(initial: Array<Record<string, unknown>> = []) {
    let tools = initial;
    const listeners = new Set<(t: unknown[]) => void>();
    let supported = true;
    return {
      bridge: {
        isSupported: () => supported,
        list: () => tools,
        async probeSettled() {},
        subscribe(listener: (t: unknown[]) => void) {
          listeners.add(listener);
          listener(tools);
          return () => listeners.delete(listener);
        },
        registrationSeqFor: (frameId: string, name: string) =>
          (
            tools.find(
              (tool) => tool.frameId === frameId && tool.name === name,
            ) as { registrationSeq?: number } | undefined
          )?.registrationSeq,
        invoke: async () => ({ invocationId: "inv-1", output: { ok: true } }),
        cancel: async () => true,
      } as never,
      set(next: Array<Record<string, unknown>>) {
        tools = next;
        for (const listener of listeners) listener(tools);
      },
      setSupported(value: boolean) {
        supported = value;
      },
    };
  }

  async function withLiveBridge(live: ReturnType<typeof liveBridge>) {
    const page = fakePage({ url: "https://x.test/", webmcp: live.bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    return driver;
  }

  const TOOL = {
    name: "book",
    description: "Book it",
    frameId: "frame-main",
    origin: "https://x.test",
    isMainFrame: true,
    registrationSeq: 1,
  };

  it("answers webmcp_revision without touching the page", async () => {
    const live = liveBridge([TOOL]);
    const page = fakePage({ url: "https://x.test/", webmcp: live.bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const shotsBefore = page.calls.shots;

    const res = await driver.execute(
      cmd({ kind: "observe", mode: "webmcp_revision" }),
    );
    expect(res.ok).toBe(true);
    expect(res.webmcpTools).toMatchObject({ count: 1, supported: true });
    // No screenshot, no settle — this is the read the server makes before EVERY
    // model step, and one that reached into the page would make discovery cost
    // a page load per step.
    expect(page.calls.shots).toBe(shotsBefore);
    // And no state token: nothing observed a rendered state, so there is none
    // to pin an act to.
    expect(res.stateToken).toBeUndefined();
  });

  it("bumps the revision when the page adds and removes a tool", async () => {
    const live = liveBridge([TOOL]);
    const driver = await withLiveBridge(live);
    const first = driver.webmcpToolsSnapshot()!;

    live.set([TOOL, { ...TOOL, name: "cancel", registrationSeq: 2 }]);
    const second = driver.webmcpToolsSnapshot()!;
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.hash).not.toBe(first.hash);
    expect(second.count).toBe(2);

    live.set([TOOL]);
    const third = driver.webmcpToolsSnapshot()!;
    expect(third.revision).toBeGreaterThan(second.revision);
    // Back to the same SET, and the hash says so — which is what lets the
    // server skip re-fetching definitions it already has.
    expect(third.hash).toBe(first.hash);
  });

  it("bumps the revision on a navigation even when the tools are identical", async () => {
    // A same-origin reload re-registers the same names in the same frame. It is
    // a NEW document all the same, and every binding against the old one is
    // void — a revision that held still there would tell the server nothing
    // changed about a page that had been replaced.
    const live = liveBridge([TOOL]);
    const driver = await withLiveBridge(live);
    const before = driver.webmcpToolsSnapshot()!;
    await driver.execute(cmd({ kind: "reload" }));
    const after = driver.webmcpToolsSnapshot()!;
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.hash).not.toBe(before.hash);
  });

  it("rides along on every observation", async () => {
    const live = liveBridge([TOOL]);
    const driver = await withLiveBridge(live);
    for (const mode of ["url", "screenshot", "dom"] as const) {
      const res = await driver.execute(cmd({ kind: "observe", mode }));
      expect(res.webmcpTools?.count).toBe(1);
    }
    // Including the navigate that CAUSED the change, so a tool the model's own
    // action registered is seen without a second round trip.
    const navigated = await driver.execute(
      cmd({ kind: "navigate", url: "https://x.test/next" }),
    );
    expect(navigated.webmcpTools).toBeDefined();
  });

  it("reports an unknown tab as no snapshot at all", async () => {
    const { context } = fakeContext();
    const driver = new ChromiumDriver(context);
    expect(driver.webmcpToolsSnapshot("never-opened")).toBeUndefined();
  });
});

describe("ChromiumDriver — webmcp_invoke bindings", () => {
  function bindingBridge(tools: Array<Record<string, unknown>>) {
    const invoked: Array<Record<string, unknown>> = [];
    return {
      invoked,
      bridge: {
        isSupported: () => true,
        list: () => tools,
        async probeSettled() {},
        subscribe(listener: (t: unknown[]) => void) {
          listener(tools);
          return () => {};
        },
        registrationSeqFor: (frameId: string, name: string) =>
          (
            tools.find(
              (tool) => tool.frameId === frameId && tool.name === name,
            ) as { registrationSeq?: number } | undefined
          )?.registrationSeq,
        invoke: async (args: Record<string, unknown>) => {
          invoked.push(args);
          (args.onStarted as ((id: string) => void) | undefined)?.("inv-42");
          return { invocationId: "inv-42", output: { ok: true } };
        },
        cancel: async () => true,
      } as never,
    };
  }

  const MAIN_TOOL = {
    name: "pay",
    frameId: "frame-main",
    origin: "https://x.test",
    isMainFrame: true,
    registrationSeq: 5,
  };

  async function driverWith(bridge: unknown) {
    const page = fakePage({ url: "https://x.test/", webmcp: bridge as never });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    return driver;
  }

  /** The binding a caller holds after listing on the first navigation. */
  const BINDING = {
    bootId: "boot-1",
    tabId: "@session",
    navCounter: 1,
    frameId: "frame-main",
    registrationSeq: 5,
  };

  it("invokes when the binding still describes the live tool", async () => {
    const live = bindingBridge([MAIN_TOOL]);
    const driver = await driverWith(live.bridge);
    const res = await driver.execute(
      cmd({
        kind: "webmcp_invoke",
        toolKey: "pay",
        input: {},
        expectedBinding: BINDING,
      }),
    );
    expect(res.ok).toBe(true);
    // Bound callers get the EXACT frame, never a resolved-by-name substitute.
    expect(live.invoked[0]).toMatchObject({
      frameId: "frame-main",
      strictFrame: true,
    });
  });

  it("refuses stale_binding after a navigation, without invoking", async () => {
    // The main frame KEEPS its id across navigation, so name + origin + frame
    // id all still match — `navCounter` is the only thing that separates this
    // page from the page that replaced it.
    const live = bindingBridge([MAIN_TOOL]);
    const driver = await driverWith(live.bridge);
    await driver.execute(cmd({ kind: "reload" }));

    const res = await driver.execute(
      cmd({
        kind: "webmcp_invoke",
        toolKey: "pay",
        input: {},
        expectedBinding: BINDING,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("stale_binding");
    expect(live.invoked).toEqual([]);
    // The fresh revision rides along so the caller re-reads rather than
    // retrying the binding it already holds.
    expect(res.webmcpTools).toBeDefined();
  });

  it("refuses stale_binding after a same-origin re-registration", async () => {
    // Nothing navigated and nothing moved frames: the page unregistered and
    // re-registered the tool, so the handler behind the name is different.
    const live = bindingBridge([{ ...MAIN_TOOL, registrationSeq: 6 }]);
    const driver = await driverWith(live.bridge);
    const res = await driver.execute(
      cmd({
        kind: "webmcp_invoke",
        toolKey: "pay",
        input: {},
        expectedBinding: BINDING,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("re-registered");
    expect(live.invoked).toEqual([]);
  });

  it("refuses stale_binding when the bound frame is gone", async () => {
    const live = bindingBridge([
      { ...MAIN_TOOL, frameId: "frame-other", isMainFrame: false },
    ]);
    const driver = await driverWith(live.bridge);
    const res = await driver.execute(
      cmd({
        kind: "webmcp_invoke",
        toolKey: "pay",
        input: {},
        expectedBinding: BINDING,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("stale_binding");
    // Emphatically NOT resolved to the same-named tool in the other frame.
    expect(live.invoked).toEqual([]);
  });

  it("refuses a binding minted for another tab", async () => {
    const live = bindingBridge([MAIN_TOOL]);
    const driver = await driverWith(live.bridge);
    const res = await driver.execute(
      cmd({
        kind: "webmcp_invoke",
        toolKey: "pay",
        input: {},
        expectedBinding: { ...BINDING, tabId: "other-tab" },
      }),
    );
    expect(res.error).toContain("stale_binding");
  });

  it("leaves an UNBOUND invoke exactly as it was", async () => {
    // The legacy `browser_webmcp_invoke` sends no binding and must keep its
    // resolve-by-name behaviour.
    const live = bindingBridge([MAIN_TOOL]);
    const driver = await driverWith(live.bridge);
    const res = await driver.execute(
      cmd({ kind: "webmcp_invoke", toolKey: "pay", input: {} }),
    );
    expect(res.ok).toBe(true);
    expect(live.invoked[0].strictFrame).toBeUndefined();
  });
});

describe("ChromiumDriver — cancelling by commandId", () => {
  it("cancels the invocation a command started, mid-flight", async () => {
    // The gap this closes: `webmcp_invoke` is synchronous, so a caller wanting
    // to stop a running page tool has never known the invocation id — its own
    // commandId is the only handle it holds before the call.
    const cancelled: string[] = [];
    let releaseInvoke: (() => void) | undefined;
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async (args: Record<string, unknown>) => {
        (args.onStarted as ((id: string) => void) | undefined)?.("inv-77");
        await new Promise<void>((resolve) => {
          releaseInvoke = resolve;
        });
        return { invocationId: "inv-77", output: { ok: true } };
      },
      cancel: async (invocationId: string) => {
        cancelled.push(invocationId);
        return true;
      },
    } as never;
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const invoking = driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "slow", input: {} }),
      commandId: "cmd-abc",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancel = await driver.execute(
      cmd({ kind: "webmcp_cancel", commandId: "cmd-abc" }),
    );
    expect(cancel.ok).toBe(true);
    expect(cancelled).toEqual(["inv-77"]);

    releaseInvoke?.();
    await invoking;
  });

  it("reports a cancel with nothing to stop as an ordinary answer", async () => {
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async () => ({ invocationId: "x", output: {} }),
      cancel: async () => true,
    } as never;
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    // A cancel that beats the browser's acceptance of the invocation has
    // nothing to stop, and nothing went wrong — reporting a failure would make
    // an ordinary race look like a broken cancel path.
    const res = await driver.execute(
      cmd({ kind: "webmcp_cancel", commandId: "never-started" }),
    );
    expect(res).toMatchObject({ ok: true, output: { cancelled: false, known: false } });
  });

  it("REMEMBERS a cancel that beat the invocation's id", async () => {
    // The narrow window this closes: Stop pressed while `WebMCP.invokeTool` is
    // in flight. The browser has the call, no id exists yet, so there is
    // nothing to name — and answering "nothing to stop" and forgetting let the
    // invocation start a moment later and run to completion under a
    // cancellation the user had already made.
    const cancelled: string[] = [];
    let startInvocation: (() => void) | undefined;
    let releaseInvoke: (() => void) | undefined;
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async (args: Record<string, unknown>) => {
        // The browser has not answered yet: no id to report.
        await new Promise<void>((resolve) => {
          startInvocation = resolve;
        });
        (args.onStarted as ((id: string) => void) | undefined)?.("inv-late");
        await new Promise<void>((resolve) => {
          releaseInvoke = resolve;
        });
        return { invocationId: "inv-late", output: { ok: true } };
      },
      cancel: async (invocationId: string) => {
        cancelled.push(invocationId);
        return true;
      },
    } as never;
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const invoking = driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "slow", input: {} }),
      commandId: "cmd-race",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Stop, while the invocation is still nameless.
    const cancel = await driver.execute(
      cmd({ kind: "webmcp_cancel", commandId: "cmd-race" }),
    );
    expect(cancel).toMatchObject({ output: { known: false } });
    expect(cancelled).toEqual([]);

    // The browser answers. The intent recorded above is delivered on sight.
    startInvocation?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toEqual(["inv-late"]);

    releaseInvoke?.();
    await invoking;
  });

  it("FORGETS a remembered cancel once its command is over", async () => {
    // Only `onStarted` cleared these. An invocation that threw, timed out, or
    // never got that far left its entry behind for the life of the daemon —
    // and once the set filled, every later race-window Stop was dropped in
    // silence, which is the failure the set exists to prevent.
    const cancelled: string[] = [];
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async () => {
        throw new Error("the page threw before reporting an id");
      },
      cancel: async (invocationId: string) => {
        cancelled.push(invocationId);
        return true;
      },
    } as never;
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const failed = await driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "boom", input: {} }),
      commandId: "cmd-dead",
    });
    expect(failed.ok).toBe(false);
    // A Stop for a command that is already over finds nothing and leaves
    // nothing: re-answering it must not re-arm anything either.
    await driver.execute(cmd({ kind: "webmcp_cancel", commandId: "cmd-dead" }));
    expect(cancelled).toEqual([]);
  });

  it("cancels on the tab the invocation RAN on, not the one the Stop names", async () => {
    // An invocation id is meaningful only to the bridge that issued it, and
    // `webmcp_cancel {commandId}` is a valid shape with no tab at all — which
    // resolves to the default one. Resolving the bridge from the CANCEL's tab
    // and handing it another tab's id sends a stop to a page that never
    // started the thing: the invocation runs on, and a colliding id would stop
    // something unrelated.
    const cancelledOn: Array<[string, string]> = [];
    let releaseInvoke: (() => void) | undefined;
    const bridgeFor = (label: string) => ({
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async (args: Record<string, unknown>) => {
        (args.onStarted as ((id: string) => void) | undefined)?.("inv-other");
        await new Promise<void>((resolve) => {
          releaseInvoke = resolve;
        });
        return { invocationId: "inv-other", output: { ok: true } };
      },
      cancel: async (invocationId: string) => {
        cancelledOn.push([label, invocationId]);
        return true;
      },
    });
    const session = fakePage({
      url: "https://first.test/",
      webmcp: bridgeFor("@session") as never,
    });
    const other = fakePage({
      url: "https://second.test/",
      webmcp: bridgeFor("tab-2") as never,
    });
    const { context } = fakeContext({ pages: [session, other] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://first.test/" }));
    await driver.execute({
      ...cmd({ kind: "navigate", url: "https://second.test/", newTab: true }),
      tabId: "tab-2",
    } as never);

    // The invocation runs on tab-2.
    const invoking = driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "slow", input: {} }),
      tabId: "tab-2",
      commandId: "cmd-cross",
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The Stop names no tab, so it resolves to the default one.
    await driver.execute(cmd({ kind: "webmcp_cancel", commandId: "cmd-cross" }));

    // It reached tab-2's bridge, which is the only one that knows this id.
    expect(cancelledOn).toEqual([["tab-2", "inv-other"]]);

    releaseInvoke?.();
    await invoking;
  });

  it("latches a Stop that lands while the BRIDGE is still resolving", async () => {
    // The window before `bridge.invoke` is reached at all: resolving the page's
    // bridge and settling its probe are both awaits, and a Stop landing in them
    // has no invocation to name AND, if the command is not yet registered as in
    // flight, nothing to latch onto either. It was dropped, and the invoke then
    // proceeded under a cancellation that had already arrived — the same
    // failure as the `onStarted` race, one await earlier.
    const cancelled: string[] = [];
    let resolveBridge: ((bridge: unknown) => void) | undefined;
    let releaseInvoke: (() => void) | undefined;
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async (args: Record<string, unknown>) => {
        (args.onStarted as ((id: string) => void) | undefined)?.("inv-slowb");
        await new Promise<void>((resolve) => {
          releaseInvoke = resolve;
        });
        return { invocationId: "inv-slowb", output: { ok: true } };
      },
      cancel: async (invocationId: string) => {
        cancelled.push(invocationId);
        return true;
      },
    };
    const page = fakePage({ url: "https://x.test/", webmcp: bridge as never });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    // From here the bridge resolves only when this test says so.
    page.webmcp = () =>
      new Promise((resolve) => {
        resolveBridge = resolve;
      }) as never;

    const invoking = driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "slow", input: {} }),
      commandId: "cmd-slowb",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Stop, with the bridge not yet resolved — before `invoke` is even called.
    await driver.execute(cmd({ kind: "webmcp_cancel", commandId: "cmd-slowb" }));
    expect(cancelled).toEqual([]);

    resolveBridge?.(bridge);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toEqual(["inv-slowb"]);

    releaseInvoke?.();
    await invoking;
  });

  it("never evicts a LIVE invocation's latch, however many ghosts arrive", async () => {
    // A cancel can arrive long after its invoke failed early — a refused
    // binding, no bridge, a lease — or for a command that never existed. Those
    // ARE latched now (a Stop for a still-queued invoke looks exactly like one
    // of them, and has to be kept), so the latch is bounded by a ceiling and a
    // TTL instead. What the bound must never do is take the one latch that
    // belongs to an invocation in flight: enough ghosts would otherwise lose a
    // real Stop — the failure the latch exists to prevent, reached by filling
    // it with commands that were never running.
    const cancelled: string[] = [];
    let startInvocation: (() => void) | undefined;
    let releaseInvoke: (() => void) | undefined;
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async (args: Record<string, unknown>) => {
        // NAMELESS UNTIL RELEASED, so the Stop below lands in the latch window
        // rather than the ordinary by-id path — which is the only window this
        // test is about.
        await new Promise<void>((resolve) => {
          startInvocation = resolve;
        });
        (args.onStarted as ((id: string) => void) | undefined)?.("inv-live");
        await new Promise<void>((resolve) => {
          releaseInvoke = resolve;
        });
        return { invocationId: "inv-live", output: { ok: true } };
      },
      cancel: async (invocationId: string) => {
        cancelled.push(invocationId);
        return true;
      },
    } as never;
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    // A real invocation, and a Stop while it is still nameless. This is the
    // latch that has to survive.
    const invoking = driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "slow", input: {} }),
      commandId: "cmd-live",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await driver.execute(cmd({ kind: "webmcp_cancel", commandId: "cmd-live" }));

    // THEN cancels for commands that never ran, more than the ceiling. Order
    // is the whole test: recording these would push the live one out.
    for (let index = 0; index < 400; index += 1) {
      await driver.execute(
        cmd({ kind: "webmcp_cancel", commandId: `ghost-${index}` }),
      );
    }

    // The browser answers only now.
    startInvocation?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // It survived the ghosts: eviction never takes a running command's latch.
    expect(cancelled).toEqual(["inv-live"]);

    releaseInvoke?.();
    await invoking;
  });

  it("honours a Stop that arrived while the invoke was still QUEUED", async () => {
    // The window every earlier fix left open, one queue position earlier: the
    // model issues a page tool beside an observe on the same tab, the user
    // presses Stop during the observe, and the cancel finds nothing in flight
    // to attach to — the invoke has not been dequeued yet. Answering "nothing
    // to stop" and forgetting let the invoke run to completion a moment later.
    // Now the intent waits in the latch, and the invoke honours it at dequeue,
    // before the bridge is even resolved.
    const invoked: string[] = [];
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async (args: Record<string, unknown>) => {
        invoked.push(String(args.toolName));
        return { invocationId: "inv-should-not-run", output: { ok: true } };
      },
      cancel: async () => true,
    } as never;
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    // The Stop lands FIRST: from the driver's point of view the command it
    // names does not exist yet.
    const cancel = await driver.execute(
      cmd({ kind: "webmcp_cancel", commandId: "cmd-queued" }),
    );
    expect(cancel).toMatchObject({ output: { known: false } });

    // Then the command is dequeued.
    const result = await driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "submit_order", input: {} }),
      commandId: "cmd-queued",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("webmcp_cancelled");
    // The page was never touched.
    expect(invoked).toEqual([]);

    // The latch was consumed: the same command id later runs normally.
    const again = await driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "submit_order", input: {} }),
      commandId: "cmd-queued",
    });
    expect(again.ok).toBe(true);
    expect(invoked).toEqual(["submit_order"]);
  });

  it("latches a queued Stop even when the invoke's tab does not exist yet", async () => {
    // The same queued Stop, one step harder: the invoke is queued behind a
    // `navigate {newTab: true}`, so the tab it names has not been created. The
    // cancel carries that tab id (the arming copies the invoke's), and
    // resolving a tab BEFORE latching answered `unknown_tab` and dropped the
    // Stop — the tool then ran on the tab the navigate went on to open, after
    // the user had already cancelled it.
    //
    // The latch is keyed by COMMAND. It never needed a page.
    const invoked: string[] = [];
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async (args: Record<string, unknown>) => {
        invoked.push(String(args.toolName));
        return { invocationId: "inv-should-not-run", output: { ok: true } };
      },
      cancel: async () => true,
    } as never;
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);

    // NO navigate first: nothing has created a tab, which is the whole point.
    const cancel = await driver.execute({
      ...cmd({ kind: "webmcp_cancel", commandId: "cmd-newtab" }),
      tabId: "not-open-yet",
    });
    // Answered as "nothing to stop yet", NOT as a tab error — an `unknown_tab`
    // here is the regression: it means the latch was skipped.
    expect(cancel).toMatchObject({ ok: true, output: { known: false } });

    // The tab now exists and the invoke is dequeued onto it.
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const result = await driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "submit_order", input: {} }),
      commandId: "cmd-newtab",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("webmcp_cancelled");
    expect(invoked, "the page ran a tool the user had cancelled").toEqual([]);
  });

  it("does NOT deliver a remembered cancel under a handoff", async () => {
    // The named-id path re-asks the lease after its await because cancelling
    // reaches into the page. This delivery can span the whole accept window,
    // which is longer — so it asks too, or a person who took the browser mid
    // invocation has it touched under their hands.
    const cancelled: string[] = [];
    let startInvocation: (() => void) | undefined;
    let releaseInvoke: (() => void) | undefined;
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async (args: Record<string, unknown>) => {
        await new Promise<void>((resolve) => {
          startInvocation = resolve;
        });
        (args.onStarted as ((id: string) => void) | undefined)?.("inv-held");
        await new Promise<void>((resolve) => {
          releaseInvoke = resolve;
        });
        return { invocationId: "inv-held", output: { ok: true } };
      },
      cancel: async (invocationId: string) => {
        cancelled.push(invocationId);
        return true;
      },
    } as never;
    const lease = new HandoffLease();
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    const invoking = driver.execute({
      ...cmd({ kind: "webmcp_invoke", toolKey: "slow", input: {} }),
      commandId: "cmd-handoff",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await driver.execute(
      cmd({ kind: "webmcp_cancel", commandId: "cmd-handoff" }),
    );

    // A person takes the browser while the invocation is still nameless.
    lease.acquire("rail-1", 60_000);
    startInvocation?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toEqual([]);

    releaseInvoke?.();
    await invoking;
  });

  it("still cancels by invocationId for a caller that knows one", async () => {
    const cancelled: string[] = [];
    const bridge = {
      isSupported: () => true,
      list: () => [],
      async probeSettled() {},
      subscribe: () => () => {},
      registrationSeqFor: () => undefined,
      invoke: async () => ({ invocationId: "x", output: {} }),
      cancel: async (id: string) => {
        cancelled.push(id);
        return true;
      },
    } as never;
    const page = fakePage({ url: "https://x.test/", webmcp: bridge });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.execute(cmd({ kind: "webmcp_cancel", invocationId: "inv-9" }));
    expect(cancelled).toEqual(["inv-9"]);
  });
});

describe("ChromiumDriver — the page-tool revision on the heartbeat", () => {
  it("bounds the URL it reports", async () => {
    // This rides an 8 KiB heartbeat record beside up to sixteen tabs' URLs,
    // and a page can make its URL as long as it likes.
    const long = `https://x.test/${"a".repeat(2_000)}`;
    const page = fakePage({ url: long });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: long }));
    const snapshot = driver.webmcpToolsSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot!.url!.length).toBeLessThanOrEqual(256);
    expect(long.length).toBeGreaterThan(256);
  });
});

/**
 * Acting on a ref — the target a model can produce without reading pixels.
 *
 * The whole point of these is the difference between a click that lands where
 * the model looked and one that lands where it guessed. So they pin the two
 * halves that make that true: the node is the one the tree named (identity,
 * and recovery when the id dies under a re-render), and nothing is on top of
 * it when the click goes out.
 */
describe("ChromiumDriver — acting on a ref", () => {
  /** A box whose centre is (100, 50). */
  const BOX = { model: { content: [80, 40, 120, 40, 120, 60, 80, 60] } };

  /**
   * Observe, then act — the real sequence, and the only one that mints a ref.
   *
   * `acted` cannot express it: a ref exists only because an observation put it
   * in the tab's map, so the act has to follow one in the same driver.
   */
  async function observedThenActed(
    action: Extract<Parameters<typeof cmd>[0], { kind: "act" }>,
    replies: Record<string, unknown> = {},
    opts: { navigateBetween?: string } = {},
  ) {
    // Replies go through `cdpReplies` rather than a hand-built session: the
    // fake's default session carries the baseline every observation needs, and
    // replacing it wholesale leaves the a11y read with nothing to answer from.
    // The calls a test asserts on are recorded by wrapping those replies.
    const sent: Array<{ method: string; params?: Record<string, unknown> }> =
      [];
    const base: Record<string, unknown> = {
      "Accessibility.getFullAXTree": axTree({
        role: "RootWebArea",
        children: [
          { role: "button", name: "Sign in", id: 41 },
          { role: "textbox", name: "Email", id: 42 },
        ],
      }),
      "DOM.getBoxModel": BOX,
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      ...replies,
    };
    const recorded: Record<string, unknown> = { ...base };
    for (const method of [
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "DOM.focus",
      "Input.insertText",
      "Runtime.callFunctionOn",
    ]) {
      const reply = base[method] ?? {};
      recorded[method] = (params?: Record<string, unknown>) => {
        sent.push({ method, ...(params ? { params } : {}) });
        return typeof reply === "function"
          ? (reply as (p?: Record<string, unknown>) => unknown)(params)
          : reply;
      };
    }
    const page = fakePage({ url: "https://x.test/", cdpReplies: recorded });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const observed = await driver.execute(
      cmd({ kind: "observe", mode: "a11y" }),
    );
    if (opts.navigateBetween) {
      await driver.execute(
        cmd({ kind: "navigate", url: opts.navigateBetween }),
      );
    }
    const res = await driver.execute(cmd(action));
    return { res, page, driver, observed, sent };
  }

  it("clicks the centre of the node the tree named", async () => {
    const { res, page, observed } = await observedThenActed({
      kind: "act",
      verb: "click",
      target: { a11yRef: "e1" },
    });
    // e1 is the button, so the ref the model read is the node that got clicked.
    expect(
      (observed.output as { refs: Record<string, { name: string }> }).refs.e1,
    ).toMatchObject({ role: "button", name: "Sign in" });
    expect(res.ok).toBe(true);
    expect(page.calls.acts).toContain("click:100,50");
  });

  it("aims at the node's box, not at the coordinates of anything else", async () => {
    const { page } = await observedThenActed(
      { kind: "act", verb: "click", target: { a11yRef: "e2" } },
      {
        // The textbox sits somewhere else on the page; a ref that ignored the
        // box model would still click the first element's centre.
        "DOM.getBoxModel": (params?: Record<string, unknown>) =>
          params?.backendNodeId === 42
            ? { model: { content: [10, 200, 30, 200, 30, 220, 10, 220] } }
            : BOX,
      },
    );
    expect(page.calls.acts).toContain("click:20,210");
  });

  it("scrolls the target into view before measuring it", async () => {
    const { sent } = await observedThenActed({
      kind: "act",
      verb: "click",
      target: { a11yRef: "e1" },
    });
    // Off-screen is the common case on a real page, and a click at unscrolled
    // coordinates lands on whatever is actually at those pixels.
    const order = sent.map((call) => call.method);
    expect(order).toContain("DOM.scrollIntoViewIfNeeded");
    expect(order.indexOf("DOM.scrollIntoViewIfNeeded")).toBeLessThan(
      order.lastIndexOf("DOM.getBoxModel"),
    );
  });

  it("RECOVERS by exact role and name when the node id died under a re-render", async () => {
    // The React case: same button, same label, new backend id. Refusing here
    // would cost the model an observe/act round trip to arrive at the element
    // it already named.
    const { res, page } = await observedThenActed(
      { kind: "act", verb: "click", target: { a11yRef: "e1" } },
      {
        "DOM.describeNode": (params?: Record<string, unknown>) => {
          if (params?.backendNodeId === 41) throw new Error("no node with id");
          return {};
        },
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [
            { role: "button", name: "Sign in", id: 91 },
            { role: "textbox", name: "Email", id: 92 },
          ],
        }),
        "DOM.getBoxModel": (params?: Record<string, unknown>) =>
          params?.backendNodeId === 91 ? BOX : {},
      },
    );
    expect(res.ok).toBe(true);
    expect(page.calls.acts).toContain("click:100,50");
  });

  it("REFUSES rather than recovering when the page itself has changed", async () => {
    // A backend node id is only unique within a document, and a new page can
    // reuse the number. Recovering by name across a navigation would click a
    // same-labelled control on a page the model never asked about.
    const { res, page } = await observedThenActed(
      { kind: "act", verb: "click", target: { a11yRef: "e1" } },
      {},
      { navigateBetween: "https://y.test/" },
    );
    expect(res.ok).toBe(false);
    // Either refusal is correct and both send the model to a fresh
    // observation: a navigation drops the tab's ref map outright, and the
    // token check behind it catches a map that somehow outlived its page.
    expect(res.error).toMatch(/stale_ref|unknown_ref/);
    expect(res.error).toContain("observe again");
    expect(page.calls.acts).not.toContain("click:100,50");
  });

  it("refuses when neither the id nor the role and name are still there", async () => {
    const { res } = await observedThenActed(
      { kind: "act", verb: "click", target: { a11yRef: "e1" } },
      (() => {
        // First read mints the refs; the second is the recovery's, against a
        // page that has replaced the button with a confirmation.
        let reads = 0;
        return {
          "DOM.describeNode": () => {
            throw new Error("no node with id");
          },
          "Accessibility.getFullAXTree": () => {
            reads += 1;
            return reads === 1
              ? axTree({
                  role: "RootWebArea",
                  children: [{ role: "button", name: "Sign in", id: 41 }],
                })
              : axTree({
                  role: "RootWebArea",
                  children: [{ role: "heading", name: "Signed in", id: 99 }],
                });
          },
        };
      })(),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("stale_ref");
    expect(res.error).toContain("Sign in");
  });

  it("REFUSES a click on a covered target, naming what is on top", async () => {
    const { res, page } = await observedThenActed(
      { kind: "act", verb: "click", target: { a11yRef: "e1" } },
      {
        "Runtime.callFunctionOn": {
          result: { value: "div.cookie-bar inside div#consent" },
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("target_covered");
    expect(res.error).toContain("div.cookie-bar inside div#consent");
    // Named the recovery, and did not click.
    expect(res.error).toMatch(/Dismiss or interact/);
    expect(page.calls.acts).not.toContain("click:100,50");
  });

  it("never runs the occlusion check on a coordinate target", async () => {
    // Coordinates are the model's own claim about where to click. There is no
    // element to ask about, and refusing a bare point would be inventing one.
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Runtime.callFunctionOn": { result: { value: "div.overlay" } },
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [7, 9] } }),
    );
    expect(res.ok).toBe(true);
    expect(page.calls.acts).toContain("click:7,9");
  });

  it("REPLACES a field's contents when typing at a ref", async () => {
    // The same meaning `type` already has at a selector. A ref that appended
    // would make one verb mean two things depending on how the target was named.
    const { res, sent } = await observedThenActed({
      kind: "act",
      verb: "type",
      target: { a11yRef: "e2" },
      value: "someone@example.com",
    });
    expect(res.ok).toBe(true);
    expect(sent.map((c) => c.method)).toContain("DOM.focus");
    const inserted = sent.find((c) => c.method === "Input.insertText");
    expect(inserted?.params).toMatchObject({ text: "someone@example.com" });
  });

  it("focuses the ref before pressing a key, so Enter lands where it was aimed", async () => {
    const { res, page, sent } = await observedThenActed({
      kind: "act",
      verb: "press",
      target: { a11yRef: "e2" },
      value: "Enter",
    });
    expect(res.ok).toBe(true);
    expect(sent.map((c) => c.method)).toContain("DOM.focus");
    expect(page.calls.acts).toContain("press:Enter");
  });

  it("names the page's own options when a select has no such value", async () => {
    // Recoverable in one turn: a model told only "no such option" guesses
    // again; told what the control offers, it picks.
    const { res } = await observedThenActed(
      {
        kind: "act",
        verb: "select",
        target: { a11yRef: "e1" },
        value: "XL",
      },
      { "Runtime.callFunctionOn": { result: { value: "no_option:S, M, L" } } },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("S, M, L");
  });

  it("answers unsupported_target when the engine has no CDP session at all", async () => {
    // An engine that cannot resolve nodes can still be driven by selector and
    // coordinates, so this is a capability answer rather than a fault.
    const page = fakePage({ url: "https://x.test/" });
    // `null` is the fake's "this engine has no CDP session at all", as opposed
    // to `undefined`, which takes its default one.
    page.cdpSession = null;
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { a11yRef: "e1" } }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown_ref|unsupported_target/);
  });
});

/**
 * JavaScript dialogs.
 *
 * A dialog stops the renderer. Before this the daemon did not know what one
 * was, so a page that called `confirm()` on a click left the tab blocked for
 * the life of the browser and every command afterwards reported the page
 * "unsettled" — true, and no help at all. These pin the three things that make
 * that recoverable: it is answered, the answer is recorded, and it is never
 * answered on behalf of the person who is holding the browser.
 */
describe("ChromiumDriver — JavaScript dialogs", () => {
  const CONFIRM = {
    kind: "confirm" as const,
    message: "Delete this account?",
    at: 1,
  };

  it("CANCELS a confirm on the agent's behalf, and says so", async () => {
    // Cancel, not accept: a dialog is the one place a page asks a question
    // whose default answer we are choosing for an absent user, and "Delete
    // this account?" defaults to no.
    const page = fakePage({ url: "https://x.test/", dialog: CONFIRM });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "dom" }));
    expect(res.ok).toBe(true);
    expect(page.dialogAnswers).toEqual([{ accept: false }]);
    expect(res.output).toMatchObject({
      dialog: {
        kind: "confirm",
        message: "Delete this account?",
        choice: "dismissed",
        auto: true,
      },
    });
  });

  it("ACCEPTS a beforeunload, because the agent asked to navigate", async () => {
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    // Raised the way a real one is: the page asks on the way OUT, so the tab
    // already exists and the next navigate is what meets it.
    page.setDialog({ kind: "beforeunload", message: "Leave site?", at: 1 });
    await driver.execute(cmd({ kind: "navigate", url: "https://y.test/" }));
    expect(page.dialogAnswers).toEqual([{ accept: true }]);
  });

  it("reports the decision ONCE, not on every later result", async () => {
    // It describes one moment. Repeating it would tell the model a dialog
    // keeps appearing on a page where nothing is happening.
    const page = fakePage({ url: "https://x.test/", dialog: CONFIRM });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const first = await driver.execute(cmd({ kind: "observe", mode: "url" }));
    const second = await driver.execute(cmd({ kind: "observe", mode: "url" }));
    expect(first.output).toMatchObject({ dialog: { kind: "confirm" } });
    expect(second.output).not.toHaveProperty("dialog");
  });

  it("answers a dialog the ACT ITSELF raised, before settling on it", async () => {
    // The real sequence: the click runs, the page calls `confirm()`, and the
    // renderer stops. Settling against that burns the whole budget to report
    // a page "unsettled", so the dialog is answered first.
    const page = fakePage({
      url: "https://x.test/",
      dialogOnAct: CONFIRM,
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { coordinates: [5, 6] } }),
    );
    expect(page.calls.acts).toContain("click:5,6");
    expect(page.dialogAnswers).toEqual([{ accept: false }]);
    expect(res.output).toMatchObject({ dialog: { choice: "dismissed" } });
  });

  it("NEVER answers the dialog of a person who is holding the browser", async () => {
    // Their dialog, their answer. Dismissing it out from under someone signing
    // in is exactly the surprise the handoff exists to prevent.
    const page = fakePage({ url: "https://x.test/", dialog: CONFIRM });
    const { context } = fakeContext({ pages: [page] });
    const lease = new HandoffLease();
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    lease.acquire("someone-else");
    const res = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));
    expect(res.ok).toBe(false);
    expect(page.dialogAnswers).toEqual([]);
    // A lease refusal is the one the caller gets, because it is the one that
    // says who to wait for.
    expect(res.leaseBlocked ?? String(res.error)).toBeTruthy();
  });

  it("still answers a screenshot and a URL while a dialog is open", async () => {
    // The page is blocked, so anything that touches it hangs or lies — but the
    // frame and the URL are exactly what a caller needs to make sense of the
    // refusal it just got. This is checked with the lease HELD so the dialog
    // stays pending for the duration.
    const page = fakePage({ url: "https://x.test/", dialog: CONFIRM });
    const { context } = fakeContext({ pages: [page] });
    const lease = new HandoffLease();
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    lease.acquire("holder");
    // As the HOLDER, which is what the lease is for: their own commands run.
    const shot = await driver.execute({
      commandId: "c-shot",
      source: "manual",
      holder: "holder",
      action: { kind: "observe", mode: "screenshot" },
    });
    expect(shot.ok).toBe(true);
    expect(page.dialogAnswers).toEqual([]);
  });

  it("does nothing at all on a page with no dialog", async () => {
    const page = fakePage({ url: "https://x.test/" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "url" }));
    expect(res.ok).toBe(true);
    expect(page.dialogAnswers).toEqual([]);
    expect(res.output).not.toHaveProperty("dialog");
  });
});

/**
 * `observe {mode:"network"}` — the question the other modes cannot answer.
 *
 * A page whose layout is right, whose list is empty and whose console is
 * silent. The cause is on the wire, and until this existed a model could only
 * re-read a page that would keep looking exactly the same.
 */
describe("ChromiumDriver — observing the network", () => {
  const ROWS = [
    {
      requestId: "r1",
      method: "GET",
      url: "https://x.test/api/items",
      status: 401,
      at: 10,
    },
    {
      requestId: "r2",
      method: "GET",
      url: "https://x.test/logo.png",
      status: 200,
      at: 20,
    },
  ];

  it("lists what the page requested and what came back", async () => {
    const page = fakePage({ url: "https://x.test/", network: ROWS });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "network" }));
    expect(res.ok).toBe(true);
    expect((res.output as { network: unknown[] }).network).toHaveLength(2);
    expect(
      (res.output as { network: Array<{ status?: number }> }).network[0],
    ).toMatchObject({ status: 401 });
  });

  it("reads ONE exchange when asked for a request id", async () => {
    const page = fakePage({ url: "https://x.test/", network: ROWS });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(
      cmd({ kind: "observe", mode: "network", requestId: "r1" }),
    );
    const rows = (res.output as { network: Array<{ requestId: string }> })
      .network;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe("r1");
  });

  it("says the row has scrolled off rather than reporting no such request", async () => {
    const page = fakePage({ url: "https://x.test/", network: ROWS });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(
      cmd({ kind: "observe", mode: "network", requestId: "gone" }),
    );
    expect((res.output as { network: unknown[] }).network).toHaveLength(0);
    expect(res.output).toMatchObject({ omitted: 1 });
  });

  it("distinguishes 'this browser cannot tell you' from 'no requests'", async () => {
    // Two very different facts. An empty list for the first sends a model
    // looking for a cause that was never captured in the first place.
    const page = fakePage({ url: "https://x.test/", network: null });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "network" }));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("does not record network requests");
  });

  it("answers an empty list for a page that genuinely requested nothing", async () => {
    const page = fakePage({ url: "https://x.test/", network: [] });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "network" }));
    expect(res.ok).toBe(true);
    expect((res.output as { network: unknown[] }).network).toEqual([]);
  });

  it("PURGES what a person's session requested when they hand the browser back", async () => {
    // The same guarantee the console ring has, and this ring needs it more: it
    // records the URLs someone visited and the requests their signing-in
    // produced. Purging one and not the other would make the lease's promise
    // "you must wait to read it" rather than "it is private".
    const page = fakePage({ url: "https://x.test/", network: [] });
    const { context } = fakeContext({ pages: [page] });
    const lease = new HandoffLease();
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));

    lease.acquire("someone");
    page.pushNetwork({
      requestId: "login",
      method: "POST",
      url: "https://x.test/session",
      at: Date.now() + 5,
    });
    lease.release("someone");
    lease.resume("someone");

    const res = await driver.execute(cmd({ kind: "observe", mode: "network" }));
    expect(res.ok).toBe(true);
    expect((res.output as { network: unknown[] }).network).toEqual([]);
  });
});

/**
 * Review catches — the two windows the ref and dialog work opened.
 *
 * Both are the same shape of mistake: a new `await` between the last check and
 * the thing the check was protecting. Worth their own block because the
 * guarantee they restore is the one the whole handoff design rests on.
 */
describe("ChromiumDriver — the lease across the awaits refs added", () => {
  it("does NOT click when a person takes the browser during ref resolution", async () => {
    // Resolving a ref is a node lookup, sometimes a whole AX tree re-read, a
    // scroll and a box measurement. The permit check used to be the last word
    // only because nothing yielded between it and the click; these awaits
    // changed that, and a person taking control inside them would have got the
    // agent's click in their own browser a beat later.
    const lease = new HandoffLease();
    let resolves = 0;
    const page = fakePage({
      url: "https://x.test/",
      cdpReplies: {
        "Accessibility.getFullAXTree": axTree({
          role: "RootWebArea",
          children: [{ role: "button", name: "Sign in", id: 41 }],
        }),
        "DOM.resolveNode": { object: { objectId: "obj-1" } },
        "DOM.getBoxModel": () => {
          // The handoff lands while the target is being MEASURED — after the
          // node resolved and before the click goes out, which is the window
          // that had no check in it.
          resolves += 1;
          lease.acquire("someone-else");
          return { model: { content: [80, 40, 120, 40, 120, 60, 80, 60] } };
        },
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { a11yRef: "e1" } }),
    );
    expect(res.ok).toBe(false);
    expect(res.leaseBlocked).toBe(true);
    // The whole point: nothing reached the page.
    expect(page.calls.acts).not.toContain("click:100,50");
  });

  it("REPORTS a dialog the act raised rather than settling through it", async () => {
    // A person's own click raising `confirm()`. Their dialog, so it is not
    // answered — and the settle and capture that used to follow would each
    // spend their full budget against a stopped renderer and then describe the
    // frame from before, which reads as an action that quietly did nothing.
    const lease = new HandoffLease();
    const page = fakePage({
      url: "https://x.test/",
      dialogOnAct: { kind: "confirm", message: "Delete this account?", at: 1 },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    await driver.execute(cmd({ kind: "navigate", url: "https://x.test/" }));
    lease.acquire("holder");

    const res = await driver.execute({
      commandId: "c-manual",
      source: "manual",
      holder: "holder",
      action: { kind: "act", verb: "click", target: { coordinates: [5, 6] } },
    });
    // The act RAN, so this is not a refusal — a caller told nothing happened
    // would do it again.
    expect(res.ok).toBe(true);
    expect(res.settled).toBe(false);
    expect(page.calls.acts).toContain("click:5,6");
    // Unanswered, and named.
    expect(page.dialogAnswers).toEqual([]);
    expect(res.output).toMatchObject({
      dialog: { kind: "confirm", pending: true },
    });
  });
});
