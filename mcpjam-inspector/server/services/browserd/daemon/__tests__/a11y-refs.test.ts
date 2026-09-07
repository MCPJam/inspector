/**
 * Refs and the interactive filter — the two decisions that shape what a model
 * is told it can act on.
 *
 * Pure functions over a tree, so everything here is an assertion about policy
 * rather than about plumbing: which nodes earn a name, which get folded away,
 * and what a name resolves back to.
 */
import { describe, expect, it } from "vitest";
import {
  assignRefs,
  filterInteractive,
  isRefWorthy,
  parseRef,
} from "../a11y-refs";
import type { A11yNode } from "../observation-budget";

describe("isRefWorthy", () => {
  it("names every interactive role, named or not", () => {
    // An UNNAMED control is exactly the one a model cannot describe any other
    // way, so it is the one that most needs a ref.
    expect(isRefWorthy({ role: "button" })).toBe(true);
    expect(isRefWorthy({ role: "textbox", name: "Email" })).toBe(true);
    expect(isRefWorthy({ role: "checkbox" })).toBe(true);
  });

  it("names a landmark only when the landmark has a name", () => {
    // An anonymous region tells the model nothing it could ask for by name;
    // numbering it spends a ref on noise.
    expect(isRefWorthy({ role: "region", name: "Results" })).toBe(true);
    expect(isRefWorthy({ role: "region" })).toBe(false);
    expect(isRefWorthy({ role: "heading", name: "Pricing" })).toBe(true);
  });

  it("never names prose or structure", () => {
    expect(isRefWorthy({ role: "text", name: "Some words" })).toBe(false);
    expect(isRefWorthy({ role: "generic" })).toBe(false);
    expect(isRefWorthy({})).toBe(false);
  });
});

describe("filterInteractive", () => {
  it("keeps the path to a control and drops the prose beside it", () => {
    const tree: A11yNode = {
      role: "main",
      children: [
        { role: "text", name: "Some words." },
        {
          role: "form",
          children: [
            { role: "text", name: "Label-ish text" },
            { role: "button", name: "Save" },
          ],
        },
      ],
    };
    const kept = filterInteractive(tree)!;
    expect(kept.children).toHaveLength(1);
    const form = kept.children![0]!;
    expect(form.role).toBe("form");
    expect(form.children).toEqual([{ role: "button", name: "Save" }]);
  });

  it("keeps the nesting, so one row's button is not confused with the next", () => {
    // Splicing survivors into their grandparent would flatten two list rows
    // into one run of buttons, and "the Delete next to Ada" would stop being
    // answerable from the tree.
    const tree: A11yNode = {
      role: "list",
      children: [
        {
          role: "listitem",
          name: "Ada",
          children: [{ role: "button", name: "Delete" }],
        },
        {
          role: "listitem",
          name: "Grace",
          children: [{ role: "button", name: "Delete" }],
        },
      ],
    };
    const kept = filterInteractive(tree)!;
    expect(kept.children).toHaveLength(2);
    expect(kept.children![0]!.children![0]!.name).toBe("Delete");
  });

  it("drops a branch with nothing actionable in it at all", () => {
    expect(
      filterInteractive({
        role: "article",
        children: [{ role: "text", name: "words" }],
      }),
    ).toBeNull();
  });
});

describe("assignRefs", () => {
  it("numbers in render order and records what each ref points at", () => {
    const tree: A11yNode = {
      role: "main",
      children: [
        { role: "button", name: "First", backendDOMNodeId: 11 },
        { role: "link", name: "Second", backendDOMNodeId: 12 },
      ],
    };
    const refs = assignRefs(tree);
    expect(tree.children![0]!.ref).toBe("e1");
    expect(tree.children![1]!.ref).toBe("e2");
    expect(refs.get("e1")).toEqual({
      backendDOMNodeId: 11,
      role: "button",
      name: "First",
    });
  });

  it("records nth ONLY where role+name is ambiguous", () => {
    // An index on a page with one Save implies there are others, and a model
    // that reads it starts hunting for the second one.
    const tree: A11yNode = {
      role: "main",
      children: [
        { role: "button", name: "Delete", backendDOMNodeId: 1 },
        { role: "button", name: "Delete", backendDOMNodeId: 2 },
        { role: "button", name: "Save", backendDOMNodeId: 3 },
      ],
    };
    const refs = assignRefs(tree);
    expect(refs.get("e1")!.nth).toBe(0);
    expect(refs.get("e2")!.nth).toBe(1);
    expect(refs.get("e3")).not.toHaveProperty("nth");
  });

  it("still names a node the page gave no id, so it can at least be recovered", () => {
    // No `backendDOMNodeId` means the direct resolve is impossible, but
    // role+name+nth recovery is not — and a ref that exists is worth more than
    // a control the model cannot refer to.
    const tree: A11yNode = { role: "button", name: "Ghost" };
    const refs = assignRefs(tree);
    expect(refs.get("e1")).toEqual({ role: "button", name: "Ghost" });
  });

  it("starts from e1 every time — refs are per observation, not cumulative", () => {
    const first = assignRefs({ role: "button", name: "A" });
    const second = assignRefs({ role: "button", name: "B" });
    expect([...first.keys()]).toEqual(["e1"]);
    expect([...second.keys()]).toEqual(["e1"]);
  });

  it("answers an empty map for nothing", () => {
    expect(assignRefs(null).size).toBe(0);
  });
});

describe("parseRef", () => {
  it("accepts the three spellings a model writes", () => {
    expect(parseRef("e3")).toBe("e3");
    expect(parseRef("@e3")).toBe("e3");
    expect(parseRef("ref=e3")).toBe("e3");
    expect(parseRef("  e3 ")).toBe("e3");
  });

  it("rejects anything else, rather than guessing at a number", () => {
    expect(parseRef("3")).toBeNull();
    expect(parseRef("button")).toBeNull();
    expect(parseRef("e")).toBeNull();
    expect(parseRef("#e3")).toBeNull();
  });
});
