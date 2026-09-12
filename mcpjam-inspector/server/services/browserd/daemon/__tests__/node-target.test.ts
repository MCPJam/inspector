/**
 * Aiming at a node the model NAMED — the module nothing tested directly.
 *
 * `node-target.ts` is where a `ref` becomes a click, and every one of its
 * decisions is one the model cannot see it make: which of three failures it
 * reports, whether it recovered a re-rendered element or found a different one
 * with the same label, whether it clicked a covered element or refused. The
 * driver's own suite exercises the happy paths through `browser_act`; the
 * distinctions below are only visible from inside.
 */
import { describe, expect, it } from "vitest";
import type { CdpLike } from "../webmcp-bridge";
import {
  coveringElementAt,
  focusBackendNodeId,
  pointForBackendNodeId,
  replaceTextInNode,
  resolveRefNode,
  selectOptionOnNode,
} from "../node-target";
import type { RefEntry } from "../a11y-refs";

/** A `CdpLike` that answers from a table and records every call with params. */
function fakeCdp(
  replies: Record<
    string,
    unknown | ((params?: Record<string, unknown>) => unknown)
  > = {},
) {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const cdp: CdpLike = {
    async send(method, params) {
      sent.push({ method, ...(params ? { params } : {}) });
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      if (typeof reply === "function") {
        return (reply as (p?: Record<string, unknown>) => unknown)(params);
      }
      return reply ?? {};
    },
    on() {},
  };
  return { cdp, sent, methods: () => sent.map((call) => call.method) };
}

/** A content quad: eight numbers, corners clockwise from top-left. */
const boxAt = (x: number, y: number, w = 40, h = 20) => ({
  model: { content: [x, y, x + w, y, x + w, y + h, x, y + h] },
});

const entry = (over: Partial<RefEntry> = {}): RefEntry =>
  ({ role: "button", name: "Sign in", backendDOMNodeId: 41, ...over }) as RefEntry;

/** An AX tree reply in CDP's flat, id-joined form. */
function axNodes(
  nodes: Array<{
    id: string;
    role: string;
    name?: string;
    backend?: number;
    children?: string[];
  }>,
) {
  return {
    nodes: nodes.map((node) => ({
      nodeId: node.id,
      ...(node.backend === undefined
        ? {}
        : { backendDOMNodeId: node.backend }),
      role: { type: "role", value: node.role },
      ...(node.name === undefined
        ? {}
        : { name: { type: "computedString", value: node.name } }),
      properties: [],
      childIds: node.children ?? [],
    })),
  };
}

describe("pointForBackendNodeId", () => {
  it("scrolls the node into view before it reads the box", () => {
    // THE ORDER IS THE POINT. A box read before the scroll describes where the
    // element was, and a click at those pixels lands on whatever is there now.
    const { cdp, methods } = fakeCdp({ "DOM.getBoxModel": boxAt(10, 20) });
    return pointForBackendNodeId(cdp, 41, "e7").then(() => {
      expect(methods()).toEqual(["DOM.scrollIntoViewIfNeeded", "DOM.getBoxModel"]);
    });
  });

  it("aims at the centre of the content box", async () => {
    const { cdp } = fakeCdp({ "DOM.getBoxModel": boxAt(10, 20, 40, 20) });
    expect(await pointForBackendNodeId(cdp, 41, "e7")).toEqual({ x: 30, y: 30 });
  });

  it("still reads the box when the scroll itself fails", async () => {
    // A node in a container that cannot scroll is still clickable where it is.
    const { cdp } = fakeCdp({
      "DOM.scrollIntoViewIfNeeded": new Error("Node does not have a layout object"),
      "DOM.getBoxModel": boxAt(0, 0, 10, 10),
    });
    expect(await pointForBackendNodeId(cdp, 41, "e7")).toEqual({ x: 5, y: 5 });
  });

  it("says a node with no box is present but unclickable, not stale", async () => {
    // A DIFFERENT ANSWER from `stale_ref`: the element is exactly where the
    // model left it and still cannot be clicked, so re-observing finds the
    // same thing. Conflating them sends the model round a loop for nothing.
    const { cdp } = fakeCdp({ "DOM.getBoxModel": {} });
    await expect(pointForBackendNodeId(cdp, 41, "e7")).rejects.toThrow(
      /target_not_found: e7 is on the page but has no visible box/,
    );
  });

  it("refuses a truncated quad rather than averaging undefined", async () => {
    const { cdp } = fakeCdp({ "DOM.getBoxModel": { model: { content: [1, 2, 3, 4] } } });
    await expect(pointForBackendNodeId(cdp, 41, "e7")).rejects.toThrow(
      /target_not_found/,
    );
  });
});

describe("resolveRefNode", () => {
  it("acts on the known id when it still resolves, and reads no tree", async () => {
    const { cdp, methods } = fakeCdp();
    expect(await resolveRefNode(cdp, "e7", entry())).toEqual({
      backendNodeId: 41,
      recovered: false,
    });
    // The recovery read is a whole accessibility tree. Paying for it on the
    // ordinary path would make every ref act cost an observation.
    expect(methods()).toEqual(["DOM.describeNode"]);
  });

  it("recovers a re-rendered element by exact role and name, and says so", async () => {
    // The ordinary React re-render: same button, new backend id. Refusing here
    // would send the model round an observe/act loop to the same element.
    const { cdp } = fakeCdp({
      "DOM.describeNode": new Error("Could not find node with given id"),
      "Accessibility.getFullAXTree": axNodes([
        { id: "1", role: "RootWebArea", children: ["2"] },
        { id: "2", role: "button", name: "Sign in", backend: 99 },
      ]),
    });
    expect(await resolveRefNode(cdp, "e7", entry())).toEqual({
      backendNodeId: 99,
      recovered: true,
    });
  });

  it("matches role and name exactly, so Save does not find Save as…", async () => {
    // A looser match is how the wrong menu item gets clicked, and a wrong click
    // is worse than a refusal the model recovers from in one turn.
    const { cdp } = fakeCdp({
      "DOM.describeNode": new Error("gone"),
      "Accessibility.getFullAXTree": axNodes([
        { id: "1", role: "RootWebArea", children: ["2"] },
        { id: "2", role: "menuitem", name: "Save as…", backend: 99 },
      ]),
    });
    await expect(
      resolveRefNode(cdp, "e7", entry({ role: "menuitem", name: "Save" })),
    ).rejects.toThrow(/stale_ref: e7 pointed at menuitem "Save"/);
  });

  it("counts in document order when a ref was disambiguated by ordinal", async () => {
    // `assignRefs` counted in document order; an ordinal against any other
    // traversal names a different element with total confidence.
    const { cdp } = fakeCdp({
      "DOM.describeNode": new Error("gone"),
      "Accessibility.getFullAXTree": axNodes([
        { id: "1", role: "RootWebArea", children: ["2", "3", "4"] },
        { id: "2", role: "button", name: "Delete", backend: 10 },
        { id: "3", role: "button", name: "Delete", backend: 11 },
        { id: "4", role: "button", name: "Delete", backend: 12 },
      ]),
    });
    expect(
      await resolveRefNode(cdp, "e9", entry({ name: "Delete", nth: 1 })),
    ).toEqual({ backendNodeId: 11, recovered: true });
  });

  it("refuses when the page can no longer be read at all", async () => {
    const { cdp } = fakeCdp({
      "DOM.describeNode": new Error("gone"),
      "Accessibility.getFullAXTree": new Error("Session closed"),
    });
    await expect(resolveRefNode(cdp, "e7", entry())).rejects.toThrow(/stale_ref/);
  });

  it("asks the guard before the recovery reads the page, not after", async () => {
    // Reading a page IS an observation, so a handoff landing inside the lookup
    // has to stop the tree read rather than be noticed once it has happened.
    const order: string[] = [];
    const { cdp } = fakeCdp({
      "DOM.describeNode": new Error("gone"),
      "Accessibility.getFullAXTree": () => {
        order.push("read");
        return axNodes([{ id: "1", role: "RootWebArea" }]);
      },
    });
    await expect(
      resolveRefNode(cdp, "e7", entry(), () => {
        order.push("guard");
        throw new Error("lease_held: somebody took the browser");
      }),
    ).rejects.toThrow(/lease_held/);
    expect(order).toEqual(["guard"]);
  });

  it("does not ask the guard at all when the known id still resolves", async () => {
    let asked = 0;
    const { cdp } = fakeCdp();
    await resolveRefNode(cdp, "e7", entry(), () => {
      asked += 1;
    });
    expect(asked).toBe(0);
  });

  it("recovers a ref that never carried a backend id", async () => {
    const { cdp } = fakeCdp({
      "Accessibility.getFullAXTree": axNodes([
        { id: "1", role: "RootWebArea", children: ["2"] },
        { id: "2", role: "button", name: "Sign in", backend: 77 },
      ]),
    });
    expect(
      await resolveRefNode(cdp, "e7", entry({ backendDOMNodeId: undefined })),
    ).toEqual({ backendNodeId: 77, recovered: true });
  });
});

describe("replaceTextInNode", () => {
  it("focuses, selects everything, then inserts", async () => {
    // REPLACE, because `type` at a selector already means replace. A ref that
    // appended would make one verb mean two things depending on the target.
    const { cdp, methods } = fakeCdp({
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
    });
    await replaceTextInNode(cdp, 41, "hello");
    expect(methods()).toEqual([
      "DOM.focus",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Input.insertText",
    ]);
  });

  it("asks the guard immediately before the text lands", async () => {
    // Focus and select are awaits, and on the far side of them is an agent's
    // keystrokes going into a page somebody else now has their hands on.
    const order: string[] = [];
    const { cdp } = fakeCdp({
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Input.insertText": () => {
        order.push("insert");
        return {};
      },
    });
    await expect(
      replaceTextInNode(cdp, 41, "hello", () => {
        order.push("guard");
        throw new Error("lease_held");
      }),
    ).rejects.toThrow(/lease_held/);
    expect(order).toEqual(["guard"]);
  });

  it("types anyway when the selection could not be cleared", async () => {
    // A field that kept its old value is a visibly wrong result the model can
    // see and correct. Silently doing nothing is not.
    const { cdp, sent } = fakeCdp({
      "DOM.resolveNode": { object: {} },
    });
    await replaceTextInNode(cdp, 41, "hello");
    expect(sent.at(-1)).toEqual({
      method: "Input.insertText",
      params: { text: "hello" },
    });
  });
});

describe("selectOptionOnNode", () => {
  const objectId = { "DOM.resolveNode": { object: { objectId: "obj-1" } } };

  it("accepts the page's answer that the option was chosen", async () => {
    const { cdp } = fakeCdp({
      ...objectId,
      "Runtime.callFunctionOn": { result: { value: "ok" } },
    });
    await expect(selectOptionOnNode(cdp, 41, "L", "e7")).resolves.toBeUndefined();
  });

  it("points at the right verb when the target is not a select", async () => {
    const { cdp } = fakeCdp({
      ...objectId,
      "Runtime.callFunctionOn": { result: { value: "not_select" } },
    });
    await expect(selectOptionOnNode(cdp, 41, "L", "e7")).rejects.toThrow(
      /e7 is not a <select>; use click or type instead/,
    );
  });

  it("names the options the page actually offers", async () => {
    // What makes the refusal recoverable: told only "no such option" the model
    // guesses again; told the list, it picks.
    const { cdp } = fakeCdp({
      ...objectId,
      "Runtime.callFunctionOn": { result: { value: "no_option:Small, Medium, Large" } },
    });
    await expect(selectOptionOnNode(cdp, 41, "L", "e7")).rejects.toThrow(
      /has no option matching "L"; it offers: Small, Medium, Large/,
    );
  });

  it("refuses when the node cannot be resolved to an object", async () => {
    const { cdp } = fakeCdp({ "DOM.resolveNode": { object: {} } });
    await expect(selectOptionOnNode(cdp, 41, "L", "e7")).rejects.toThrow(
      /target_not_found: e7 could not be resolved to select an option/,
    );
  });
});

describe("coveringElementAt", () => {
  it("names what is on top, so the model can act on it", async () => {
    const { cdp } = fakeCdp({
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": { result: { value: "div.overlay inside div#cookie-banner" } },
    });
    expect(await coveringElementAt(cdp, 41)).toBe(
      "div.overlay inside div#cookie-banner",
    );
  });

  it("reports nothing covering when the page says nothing is", async () => {
    const { cdp } = fakeCdp({
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": { result: { value: null } },
    });
    expect(await coveringElementAt(cdp, 41)).toBeNull();
  });

  it("FAILS OPEN when it cannot ask", async () => {
    // The direction matters: a missed detection costs the model a diagnosis it
    // would not have had at all, where a false one refuses a click that works.
    const { cdp } = fakeCdp({ "DOM.resolveNode": { object: {} } });
    expect(await coveringElementAt(cdp, 41)).toBeNull();

    const thrown = fakeCdp({
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": new Error("Execution context was destroyed"),
    });
    expect(await coveringElementAt(thrown.cdp, 41)).toBeNull();
  });
});

describe("focusBackendNodeId", () => {
  it("puts the caret in the node so the next keystrokes land in it", async () => {
    const { cdp, sent } = fakeCdp();
    await focusBackendNodeId(cdp, 41);
    expect(sent).toEqual([
      { method: "DOM.focus", params: { backendNodeId: 41 } },
    ]);
  });
});
