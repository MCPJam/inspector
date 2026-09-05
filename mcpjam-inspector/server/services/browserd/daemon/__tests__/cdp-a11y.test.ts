import { describe, expect, it } from "vitest";
import { readAxTree, resolveBackendNodeId } from "../cdp-a11y";
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
  const cdp: CdpLike = {
    async send(method) {
      sent.push(method);
      if (method in replies) {
        const reply = replies[method];
        if (reply instanceof Error) throw reply;
        return reply;
      }
      return {};
    },
    on() {},
  };
  return { cdp, sent };
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
