import { describe, expect, it } from "vitest";
import { parseAriaSnapshot } from "../aria-snapshot";
import { capA11yTree } from "../observation-budget";

describe("parseAriaSnapshot", () => {
  it("returns null for an empty or missing snapshot", () => {
    expect(parseAriaSnapshot("")).toBeNull();
    expect(parseAriaSnapshot(null)).toBeNull();
    expect(parseAriaSnapshot("\n\n  \n")).toBeNull();
  });

  it("reads a role, its quoted name, and its bracketed attributes", () => {
    expect(parseAriaSnapshot('- heading "Welcome" [level=2]')).toEqual({
      role: "heading",
      name: "Welcome",
      level: 2,
    });
  });

  it("stores a bare attribute as a flag and a non-numeric one as a string", () => {
    expect(parseAriaSnapshot('- checkbox "Agree" [checked] [ref=e7]')).toEqual({
      role: "checkbox",
      name: "Agree",
      checked: true,
      ref: "e7",
    });
  });

  it("nests by indentation", () => {
    const tree = parseAriaSnapshot(
      ['- main:', '  - heading "Title"', '  - list:', '    - listitem "One"'].join(
        "\n",
      ),
    );
    expect(tree).toEqual({
      role: "main",
      children: [
        { role: "heading", name: "Title" },
        { role: "list", children: [{ role: "listitem", name: "One" }] },
      ],
    });
  });

  it("closes a subtree correctly when indentation steps back OUT", () => {
    // The bug this guards: treating the dedented sibling as a child of the
    // deepest open node, which silently reparents half the page.
    const tree = parseAriaSnapshot(
      [
        "- main:",
        "  - list:",
        '    - listitem "One"',
        '  - button "Submit"',
      ].join("\n"),
    );
    expect(tree).toEqual({
      role: "main",
      children: [
        { role: "list", children: [{ role: "listitem", name: "One" }] },
        { role: "button", name: "Submit" },
      ],
    });
  });

  it("wraps SEVERAL top-level nodes in a document root, and leaves a single one alone", () => {
    // A rootSelector-scoped snapshot is normally one node; a page is normally
    // several. `capA11yTree` takes exactly one root either way.
    const many = parseAriaSnapshot("- banner:\n  - text: hi\n- contentinfo");
    expect(many).toEqual({
      role: "document",
      children: [
        { role: "banner", children: [{ role: "text", name: "hi" }] },
        { role: "contentinfo" },
      ],
    });
    expect(parseAriaSnapshot("- contentinfo")).toEqual({ role: "contentinfo" });
  });

  it("reads property lines (`text:`, `/url:`) as named nodes", () => {
    const tree = parseAriaSnapshot(
      ['- link "Home":', "  - /url: /home", "- text: Hello world"].join("\n"),
    );
    expect(tree).toEqual({
      role: "document",
      children: [
        { role: "link", name: "Home", children: [{ role: "/url", name: "/home" }] },
        { role: "text", name: "Hello world" },
      ],
    });
  });

  it("collects a `|` block scalar as one node's text, not as structure", () => {
    // Without block handling the indented continuation lines are read as
    // entries and the tree grows garbage nodes.
    const tree = parseAriaSnapshot(
      ["- paragraph: |", "    first line", "    second line", '- button "Next"'].join(
        "\n",
      ),
    );
    expect(tree).toEqual({
      role: "document",
      children: [
        { role: "paragraph", name: "first line\nsecond line" },
        { role: "button", name: "Next" },
      ],
    });
  });

  it("unescapes quotes inside a name", () => {
    expect(parseAriaSnapshot('- button "Say \\"hi\\""')).toEqual({
      role: "button",
      name: 'Say "hi"',
    });
  });

  it("degrades an unrecognised line to a text node instead of throwing", () => {
    // Tolerance is the contract: this is a text format from a pinned but
    // unowned dependency, read against arbitrary pages. A line that does not
    // start with a role token keeps its content as text rather than vanishing.
    expect(() => parseAriaSnapshot('- "orphaned quoted run"')).not.toThrow();
    expect(parseAriaSnapshot('- "orphaned quoted run"')).toEqual({
      role: "text",
      name: '"orphaned quoted run"',
    });
    // An unfamiliar bare token is read as a role, which is the useful reading.
    expect(parseAriaSnapshot("- someFutureRole")).toEqual({
      role: "someFutureRole",
    });
  });

  it("produces a tree the L9 budget can omit subtrees from", () => {
    // The reason we rebuild a tree at all rather than pass the YAML through as
    // text: omit-don't-truncate needs to see where a subtree ends.
    const yaml = [
      "- main:",
      "  - list:",
      ...Array.from({ length: 10 }, (_, i) => `    - listitem "Item ${i}"`),
    ].join("\n");
    const tree = parseAriaSnapshot(yaml);
    const capped = capA11yTree(tree, { maxNodes: 400, maxDepth: 1 });
    expect(capped.omittedSubtrees).toBe(1);
    expect(JSON.stringify(capped.tree)).toContain("rootSelector");
    expect(JSON.stringify(capped.tree)).not.toContain("Item 9");
  });
});
