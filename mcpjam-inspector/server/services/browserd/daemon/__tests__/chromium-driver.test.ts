import { describe, expect, it, vi } from "vitest";
import { ChromiumDriver } from "../chromium-driver";
import { shortHash } from "../state-token";
import type { BrowserCommand } from "../../protocol";
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
