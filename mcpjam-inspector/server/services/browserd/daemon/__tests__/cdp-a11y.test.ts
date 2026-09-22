import { describe, expect, it } from "vitest";
import {
  readAxForest,
  readAxTree,
  readScrollableNodes,
  resolveBackendNodeId,
} from "../cdp-a11y";
import type { A11yNode } from "../observation-budget";

/**
 * The tree from a read that was expected to SUCCEED.
 *
 * The reader answers `{ok}` because "could not read this page" and "this page
 * has nothing on it" are opposite instructions to a model; most cases here are
 * about the tree's shape, so they unwrap and let the two failures below assert
 * the distinction directly.
 */
async function treeOf(read: ReturnType<typeof readAxTree>): Promise<A11yNode | null> {
  const result = await read;
  if (!result.ok) throw new Error("expected the page to answer a tree");
  return result.tree;
}
import type { CdpLike } from "../webmcp-bridge";

/** A `CdpLike` that answers from a table and records what it was asked. */
function fakeCdp(replies: Record<string, unknown>) {
  const sent: string[] = [];
  /** The params of each call, so a fixture can assert on the REQUEST. */
  const params: Array<Record<string, unknown> | undefined> = [];
  const cdp: CdpLike = {
    async send(method, callParams) {
      sent.push(method);
      params.push(callParams);
      if (method in replies) {
        const reply = replies[method];
        if (reply instanceof Error) throw reply;
        return reply;
      }
      return {};
    },
    on() {},
  };
  return { cdp, sent, params };
}

const TREE = {
  nodes: [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3", "4"] },
    {
      nodeId: "2",
      role: { value: "checkbox" },
      name: { value: "Remember me" },
      properties: [
        { name: "checked", value: { value: "true" } },
        { name: "focused", value: { value: false } },
        // Not in the carried set; must not leak through as a stray key.
        { name: "live", value: { value: "off" } },
      ],
      backendDOMNodeId: 21,
    },
    {
      nodeId: "3",
      role: { value: "heading" },
      name: { value: "Settings" },
      properties: [{ name: "level", value: { value: 2 } }],
    },
    {
      nodeId: "4",
      role: { value: "link" },
      name: { value: "Docs" },
      properties: [{ name: "url", value: { value: "https://docs.test/" } }],
    },
  ],
};

describe("cdp-a11y — the tree says what the page means", () => {
  it("carries the properties that change what an element IS", async () => {
    // Without these the tree reads the same shape while saying strictly less —
    // the kind of gap nobody notices until an agent confidently clicks a
    // checkbox that was already ticked.
    const { cdp } = fakeCdp({ "Accessibility.getFullAXTree": TREE });
    const tree = await treeOf(readAxTree(cdp));

    const [checkbox, heading, link] = tree?.children ?? [];
    // A BOOLEAN, matching what `ariaSnapshot` gives the Playwright engine.
    // CDP reports the tristates as strings, and a consumer written against one
    // engine would read `checked: "false"` as truthy — an empty box reported
    // as ticked.
    expect(checkbox).toMatchObject({ role: "checkbox", checked: true });
    expect(heading).toMatchObject({ role: "heading", level: 2 });
    expect(link).toMatchObject({ role: "link", url: "https://docs.test/" });
  });

  it('keeps "mixed" as a string, because it is not a boolean', async () => {
    const { cdp } = fakeCdp({
      "Accessibility.getFullAXTree": {
        nodes: [
          {
            nodeId: "1",
            role: { value: "checkbox" },
            properties: [{ name: "checked", value: { value: "mixed" } }],
          },
        ],
      },
    });
    expect(await treeOf(readAxTree(cdp))).toMatchObject({ checked: "mixed" });
  });

  it("keeps a false, because false is an answer", async () => {
    // "not focused" and "not focusable" are different things to a model
    // deciding where to type.
    const { cdp } = fakeCdp({ "Accessibility.getFullAXTree": TREE });
    const tree = await treeOf(readAxTree(cdp));
    expect(tree?.children?.[0]).toMatchObject({ focused: false });
  });

  it("does not leak properties nobody asked for", async () => {
    const { cdp } = fakeCdp({ "Accessibility.getFullAXTree": TREE });
    const tree = await treeOf(readAxTree(cdp));
    expect(tree?.children?.[0]).not.toHaveProperty("live");
  });

  it("folds a generic wrapper away and keeps its text", async () => {
    // A tree of `generic > generic > generic` describes nothing and spends the
    // whole node budget doing it, which is why `ariaSnapshot` folds them.
    const { cdp } = fakeCdp({
      "Accessibility.getFullAXTree": {
        nodes: [
          { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
          { nodeId: "2", role: { value: "generic" }, childIds: ["3"] },
          {
            nodeId: "3",
            role: { value: "StaticText" },
            name: { value: "Hello" },
          },
        ],
      },
    });

    const tree = await treeOf(readAxTree(cdp));
    // `RootWebArea` is a real role and stays; the `generic` between it and the
    // text is what disappears, so the text becomes the root's own child.
    expect(tree).toMatchObject({
      role: "RootWebArea",
      children: [{ role: "text", name: "Hello" }],
    });
  });

  it("keeps what an ignored node was wrapping", async () => {
    // An `aria-hidden` wrapper around a live region contributes nothing itself
    // and still parents something that matters.
    const { cdp } = fakeCdp({
      "Accessibility.getFullAXTree": {
        nodes: [
          { nodeId: "1", ignored: true, childIds: ["2"] },
          { nodeId: "2", role: { value: "button" }, name: { value: "Go" } },
        ],
      },
    });

    expect(await treeOf(readAxTree(cdp))).toMatchObject({ role: "button", name: "Go" });
  });

  it("does not walk forever on a cyclic tree", async () => {
    const { cdp } = fakeCdp({
      "Accessibility.getFullAXTree": {
        nodes: [
          { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
          { nodeId: "2", role: { value: "list" }, childIds: ["1"] },
        ],
      },
    });

    expect(await treeOf(readAxTree(cdp))).toMatchObject({
      role: "RootWebArea",
      children: [{ role: "list" }],
    });
  });

  it("says it COULD NOT READ, rather than answering an empty page", async () => {
    // "There is nothing to click here" sends a model elsewhere; "I could not
    // read this page" sends it back to look again. A reader that collapses
    // both into an empty tree makes the model confidently wrong about a page
    // it never read.
    const { cdp } = fakeCdp({ "Accessibility.getFullAXTree": { nodes: [] } });
    expect(await readAxTree(cdp)).toEqual({ ok: false });

    const failing = fakeCdp({
      "Accessibility.getFullAXTree": new Error("target closed"),
    });
    expect(await readAxTree(failing.cdp)).toEqual({ ok: false });
  });

  it("roots the tree at a node when asked", async () => {
    const { cdp } = fakeCdp({ "Accessibility.getFullAXTree": TREE });
    expect(await treeOf(readAxTree(cdp, 21))).toMatchObject({ role: "checkbox" });
  });
});

describe("cdp-a11y — resolving a root selector", () => {
  it("answers the backend node id", async () => {
    const { cdp } = fakeCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 42 },
      "DOM.describeNode": { node: { backendNodeId: 99 } },
    });
    expect(await resolveBackendNodeId(cdp, "#main")).toBe(99);
  });

  it("answers null for a selector that matches nothing", async () => {
    const { cdp } = fakeCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 0 },
    });
    expect(await resolveBackendNodeId(cdp, "#gone")).toBeNull();
  });
});

describe("scroll containers", () => {
  /** `generic > list`, where the generic is the scroller. */
  const SCROLLER_TREE = {
    nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      {
        nodeId: "2",
        backendDOMNodeId: 77,
        role: { value: "generic" },
        childIds: ["3"],
      },
      {
        nodeId: "3",
        backendDOMNodeId: 78,
        role: { value: "listitem" },
        name: { value: "Row 1" },
      },
    ],
  };

  it("folds a scrollable generic away when no set is given", async () => {
    // THE BYTE-IDENTITY HALF, and the one the eval goldens rest on. Without
    // the set nothing changes, whatever the page's layout says.
    const { cdp } = fakeCdp({ "Accessibility.getFullAXTree": SCROLLER_TREE });
    const tree = await treeOf(readAxTree(cdp));
    expect(tree).toMatchObject({
      role: "RootWebArea",
      children: [{ role: "listitem", name: "Row 1" }],
    });
    expect(JSON.stringify(tree)).not.toContain("scrollable");
  });

  it("keeps a scrollable generic and marks it", async () => {
    // Why this matters: a scroll container is almost always a bare `generic`,
    // so today the model reads a list of rows with no sign that the list
    // itself moves — it asks to scroll and the whole page jumps instead.
    const { cdp } = fakeCdp({ "Accessibility.getFullAXTree": SCROLLER_TREE });
    const tree = await treeOf(
      readAxTree(cdp, undefined, { scrollable: new Set([77]) }),
    );
    expect(tree).toMatchObject({
      role: "RootWebArea",
      children: [
        {
          role: "generic",
          backendDOMNodeId: 77,
          scrollable: true,
          children: [{ role: "listitem", name: "Row 1" }],
        },
      ],
    });
  });

  it("marks a node that would have been kept anyway, without changing it", async () => {
    const { cdp } = fakeCdp({
      "Accessibility.getFullAXTree": {
        nodes: [
          { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
          {
            nodeId: "2",
            backendDOMNodeId: 55,
            role: { value: "list" },
            name: { value: "Results" },
          },
        ],
      },
    });
    const tree = await treeOf(
      readAxTree(cdp, undefined, { scrollable: new Set([55]) }),
    );
    expect(tree?.children?.[0]).toMatchObject({
      role: "list",
      name: "Results",
      scrollable: true,
    });
  });

  it("leaves a generic that does NOT scroll folded, set or no set", async () => {
    const { cdp } = fakeCdp({ "Accessibility.getFullAXTree": SCROLLER_TREE });
    const tree = await treeOf(
      readAxTree(cdp, undefined, { scrollable: new Set([999]) }),
    );
    expect(tree?.children?.[0]).toMatchObject({ role: "listitem" });
  });
});

describe("readScrollableNodes", () => {
  it("reports what Chromium says scrolls, piercing shadow roots and frames", async () => {
    // ASKED, NOT COMPUTED: `isScrollable` is the browser's own layout answer,
    // and it cannot drift from what a wheel event will do. Re-deriving it with
    // `getComputedStyle` would mean running a script in a page that may be
    // hostile to learn something the browser already knows.
    const { cdp, sent, params } = fakeCdp({
      "DOM.getDocument": {
        root: {
          backendNodeId: 1,
          nodeName: "HTML",
          isScrollable: true,
          children: [
            {
              backendNodeId: 2,
              nodeName: "BODY",
              isScrollable: true,
              children: [
                { backendNodeId: 3, nodeName: "DIV", isScrollable: true },
                { backendNodeId: 4, nodeName: "DIV" },
              ],
              shadowRoots: [
                { backendNodeId: 5, nodeName: "SECTION", isScrollable: true },
              ],
            },
          ],
          contentDocument: {
            backendNodeId: 6,
            nodeName: "DIV",
            isScrollable: true,
          },
        },
      },
    });
    // `html` and `body` are EXCLUDED: they scroll on almost every page and are
    // what a bare `scroll` already moves, so marking them would put the flag
    // on the root of every tree and tell the model nothing.
    expect(await readScrollableNodes(cdp)).toEqual(new Set([3, 5, 6]));
    expect(sent).toEqual(["DOM.getDocument"]);
    // THE REQUEST, not just the answer. Nodes 5 and 6 above sit behind a
    // shadow root and a content document, so they are reachable ONLY because
    // the call carries these two — and a fixture that asserts the result alone
    // keeps passing if `pierce` is dropped, while the real daemon quietly
    // stops marking every scroll container inside a shadow DOM, which is most
    // component-library lists.
    expect(params[0]).toEqual({ depth: -1, pierce: true });
  });

  it("answers an empty set rather than failing the observation", async () => {
    // The markers are worth nothing without the tree, and the tree is worth
    // returning without the markers.
    const { cdp } = fakeCdp({ "DOM.getDocument": new Error("Session closed") });
    expect(await readScrollableNodes(cdp)).toEqual(new Set());
  });

  it("survives a page that answers a document with nothing in it", async () => {
    const { cdp } = fakeCdp({ "DOM.getDocument": {} });
    expect(await readScrollableNodes(cdp)).toEqual(new Set());
  });
});

describe("readAxForest — reading past an iframe", () => {
  /** A page tree with one `<iframe>` at backend node 77. */
  const PAGE_WITH_IFRAME = {
    nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
      {
        nodeId: "2",
        backendDOMNodeId: 10,
        role: { value: "button" },
        name: { value: "Outside" },
      },
      {
        nodeId: "3",
        backendDOMNodeId: 77,
        role: { value: "Iframe" },
        name: { value: "Payment" },
      },
    ],
  };

  const CHILD_TREE = {
    nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      {
        nodeId: "2",
        backendDOMNodeId: 500,
        role: { value: "textbox" },
        name: { value: "Card number" },
      },
    ],
  };

  const FRAME_TREE = {
    frameTree: {
      frame: { id: "main" },
      childFrames: [{ frame: { id: "child-1", parentId: "main" } }],
    },
  };

  it("issues NO frame calls for a page without iframes", async () => {
    // Most pages. The root read is what it has always been, and a
    // `Page.getFrameTree` on every observation would be a round trip bought
    // for nothing.
    const { cdp, sent } = fakeCdp({
      "Accessibility.getFullAXTree": {
        nodes: [{ nodeId: "1", role: { value: "RootWebArea" } }],
      },
    });
    const forest = await readAxForest(cdp, []);
    expect(forest.ok).toBe(true);
    expect(sent).toEqual(["Accessibility.enable", "Accessibility.getFullAXTree"]);
  });

  it("splices a SAME-PROCESS frame's tree under its Iframe node", async () => {
    // A same-process child lives inside its parent's session, so its tree is
    // read there with `{frameId}`.
    const asked: Array<Record<string, unknown> | undefined> = [];
    let call = 0;
    const cdp: CdpLike = {
      async send(method, params) {
        if (method === "Accessibility.getFullAXTree") {
          asked.push(params);
          return call++ === 0 ? PAGE_WITH_IFRAME : CHILD_TREE;
        }
        if (method === "Page.getFrameTree") return FRAME_TREE;
        if (method === "DOM.getFrameOwner") return { backendNodeId: 77 };
        return {};
      },
      on() {},
    };
    const forest = await readAxForest(cdp, []);
    const iframe = forest.tree?.children?.find((n) => n.role === "Iframe");
    expect(iframe?.children?.[0]).toMatchObject({
      role: "RootWebArea",
      children: [{ role: "textbox", name: "Card number" }],
    });
    // Scoped by frame id, which is how a same-process child is addressed.
    expect(asked[1]).toEqual({ frameId: "child-1" });
    // No session of its own, so the PAGE session answers for it.
    expect(iframe?.children?.[0]?.frameId).toBe("child-1");
    expect(iframe?.children?.[0]?.sessionFrameId).toBeUndefined();
    // Nothing to translate: it shares the page's coordinate space.
    expect(forest.frames.size).toBe(0);
  });

  /**
   * A frame INSIDE a frame — the case the depth cap says is allowed and the
   * host index silently forbade.
   *
   * `DOM.getFrameOwner` answers with a backendNodeId from the document it was
   * asked on. At depth 2 that is the CHILD's document, so a host map built once
   * from the ROOT tree could not contain it: `hostNode` came back undefined and
   * the grandchild was counted as omitted. Every nested frame disappeared while
   * `MAX_A11Y_FRAME_DEPTH` said eight levels were fine, and no fixture here
   * built two levels, so nothing noticed.
   */
  it("splices a GRANDCHILD frame, indexing each document's own hosts", async () => {
    // The child document has its own `<iframe>` at backend node 88 — a number
    // the ROOT tree has never heard of, which is the whole point.
    const CHILD_WITH_IFRAME = {
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
        {
          nodeId: "2",
          backendDOMNodeId: 500,
          role: { value: "textbox" },
          name: { value: "Card number" },
        },
        {
          nodeId: "3",
          backendDOMNodeId: 88,
          role: { value: "Iframe" },
          name: { value: "Verification" },
        },
      ],
    };
    const GRANDCHILD_TREE = {
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
        {
          nodeId: "2",
          backendDOMNodeId: 900,
          role: { value: "textbox" },
          name: { value: "One-time code" },
        },
      ],
    };
    const NESTED_FRAME_TREE = {
      frameTree: {
        frame: { id: "main" },
        childFrames: [
          {
            frame: { id: "child-1", parentId: "main" },
            childFrames: [{ frame: { id: "grandchild-1", parentId: "child-1" } }],
          },
        ],
      },
    };
    let call = 0;
    const cdp: CdpLike = {
      async send(method, params) {
        if (method === "Accessibility.getFullAXTree") {
          call += 1;
          if (call === 1) return PAGE_WITH_IFRAME;
          return call === 2 ? CHILD_WITH_IFRAME : GRANDCHILD_TREE;
        }
        if (method === "Page.getFrameTree") return NESTED_FRAME_TREE;
        if (method === "DOM.getFrameOwner") {
          // The page owns `child-1` at 77; the CHILD owns `grandchild-1` at 88.
          return (params as { frameId?: string })?.frameId === "child-1"
            ? { backendNodeId: 77 }
            : { backendNodeId: 88 };
        }
        return {};
      },
      on() {},
    };
    const forest = await readAxForest(cdp, []);
    const iframe = forest.tree?.children?.find((n) => n.role === "Iframe");
    const childRoot = iframe?.children?.[0];
    const innerIframe = childRoot?.children?.find((n) => n.role === "Iframe");
    expect(innerIframe?.children?.[0]).toMatchObject({
      role: "RootWebArea",
      children: [{ role: "textbox", name: "One-time code" }],
    });
    // NOTHING WAS DROPPED. The old behaviour spliced the child and reported
    // the grandchild as omitted, which read as a frame the browser could not
    // describe rather than one it never looked up correctly.
    expect(forest.framesOmitted).toBe(0);
  });

  it("reads an OOPIF on its OWN session, and never sends it a frameId", async () => {
    // An out-of-process frame is that session's ROOT document. Passing an id
    // its session has never heard of answers nothing.
    const childAsked: Array<Record<string, unknown> | undefined> = [];
    const childCdp: CdpLike = {
      async send(method, params) {
        if (method === "Accessibility.getFullAXTree") {
          childAsked.push(params);
          return CHILD_TREE;
        }
        return {};
      },
      on() {},
    };
    const cdp: CdpLike = {
      async send(method) {
        if (method === "Accessibility.getFullAXTree") return PAGE_WITH_IFRAME;
        if (method === "Page.getFrameTree") return FRAME_TREE;
        if (method === "DOM.getFrameOwner") return { backendNodeId: 77 };
        return {};
      },
      on() {},
    };
    const forest = await readAxForest(cdp, [
      { frameId: "child-1", cdp: childCdp },
    ]);
    expect(childAsked).toEqual([undefined]);
    const iframe = forest.tree?.children?.find((n) => n.role === "Iframe");
    expect(iframe?.children?.[0]?.sessionFrameId).toBe("child-1");
    // It HAS its own coordinate space, so the topology records where it sits.
    expect(forest.frames.get("child-1")).toEqual({
      hostBackendNodeId: 77,
      frameId: "child-1",
    });
  });

  it("skips a frame whose host is not in the tree, and counts it", async () => {
    // Without a host element there is nowhere to put the subtree, and guessing
    // would splice a frame's content under an unrelated node.
    const cdp: CdpLike = {
      async send(method) {
        if (method === "Accessibility.getFullAXTree") return PAGE_WITH_IFRAME;
        if (method === "Page.getFrameTree") return FRAME_TREE;
        if (method === "DOM.getFrameOwner") return { backendNodeId: 999 };
        return {};
      },
      on() {},
    };
    const forest = await readAxForest(cdp, []);
    expect(forest.framesOmitted).toBe(1);
    const iframe = forest.tree?.children?.find((n) => n.role === "Iframe");
    expect(iframe?.children).toBeUndefined();
  });

  it("leaves the iframe line AS IT WAS when the frame read is rejected", async () => {
    // NO UNSCOPED RETRY: falling back to a whole-document read here would
    // splice the page under its own iframe and produce a tree containing
    // itself.
    let call = 0;
    const cdp: CdpLike = {
      async send(method) {
        if (method === "Accessibility.getFullAXTree") {
          if (call++ === 0) return PAGE_WITH_IFRAME;
          throw new Error("Frame is not available");
        }
        if (method === "Page.getFrameTree") return FRAME_TREE;
        if (method === "DOM.getFrameOwner") return { backendNodeId: 77 };
        return {};
      },
      on() {},
    };
    const forest = await readAxForest(cdp, []);
    expect(forest.ok).toBe(true);
    expect(forest.framesOmitted).toBe(1);
    const iframe = forest.tree?.children?.find((n) => n.role === "Iframe");
    expect(iframe).toMatchObject({ role: "Iframe", name: "Payment" });
    expect(iframe?.children).toBeUndefined();
    // And the rest of the page is untouched — one frame's failure costs that
    // frame and nothing else.
    expect(forest.tree?.children?.[0]).toMatchObject({ name: "Outside" });
  });

  it("stops at the frame cap and says how many it skipped", async () => {
    const children = Array.from({ length: 5 }, (_, i) => ({
      frame: { id: `child-${i}`, parentId: "main" },
    }));
    const cdp: CdpLike = {
      async send(method) {
        if (method === "Accessibility.getFullAXTree") return PAGE_WITH_IFRAME;
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main" }, childFrames: children } };
        if (method === "DOM.getFrameOwner") return { backendNodeId: 77 };
        return {};
      },
      on() {},
    };
    const forest = await readAxForest(cdp, [], { maxFrames: 2 });
    expect(forest.framesOmitted).toBe(3);
  });

  it("refuses to descend past the depth cap", async () => {
    const deep = {
      frameTree: {
        frame: { id: "main" },
        childFrames: [
          {
            frame: { id: "a" },
            childFrames: [{ frame: { id: "b" } }],
          },
        ],
      },
    };
    const cdp: CdpLike = {
      async send(method) {
        if (method === "Accessibility.getFullAXTree") return PAGE_WITH_IFRAME;
        if (method === "Page.getFrameTree") return deep;
        if (method === "DOM.getFrameOwner") return { backendNodeId: 77 };
        return {};
      },
      on() {},
    };
    const forest = await readAxForest(cdp, [], { maxDepth: 0 });
    // The whole subtree is refused, and counted.
    expect(forest.framesOmitted).toBe(2);
  });

  it("survives a page that cannot answer a frame tree", async () => {
    const cdp: CdpLike = {
      async send(method) {
        if (method === "Accessibility.getFullAXTree") return PAGE_WITH_IFRAME;
        if (method === "Page.getFrameTree") throw new Error("Session closed");
        return {};
      },
      on() {},
    };
    const forest = await readAxForest(cdp, []);
    expect(forest.ok).toBe(true);
    expect(forest.tree?.children).toHaveLength(2);
  });

  it("reports the page's own failure as a failure", async () => {
    const { cdp } = fakeCdp({
      "Accessibility.getFullAXTree": new Error("Session closed"),
    });
    expect(await readAxForest(cdp, [])).toMatchObject({
      ok: false,
      tree: null,
    });
  });
});
