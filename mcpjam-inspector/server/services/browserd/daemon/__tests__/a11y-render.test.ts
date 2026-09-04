/**
 * The rendered tree, line by line.
 *
 * These strings are what the model actually reads, and they end up in eval
 * transcripts and in diffs between two runs of one page — so they are pinned
 * exactly, including attribute order. A renderer whose output shifted with
 * object key insertion would make every re-observation look like a change.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_PAGE,
  NO_INTERACTIVE_ELEMENTS,
  renderA11yTree,
} from "../a11y-render";

describe("renderA11yTree — a line per node", () => {
  it("indents by depth and quotes the name", () => {
    expect(
      renderA11yTree({
        role: "navigation",
        name: "Primary",
        ref: "e1",
        children: [{ role: "link", name: "Docs", ref: "e2" }],
      }),
    ).toBe(
      ['- navigation "Primary" [ref=e1]', '  - link "Docs" [ref=e2]'].join(
        "\n",
      ),
    );
  });

  it("quotes a name that could otherwise forge the shape of its own line", () => {
    const text = renderA11yTree({
      role: "button",
      name: 'Save" [ref=e99] fake',
      ref: "e1",
    });
    // The injected ref is inside the quoted string, not a second attribute.
    expect(text).toBe('- button "Save\\" [ref=e99] fake" [ref=e1]');
  });

  it("orders attributes the same way every time", () => {
    expect(
      renderA11yTree({
        role: "checkbox",
        name: "Remember me",
        level: 2,
        checked: "mixed",
        expanded: false,
        selected: true,
        disabled: true,
        required: true,
        ref: "e1",
        url: "https://x.test/",
      }),
    ).toBe(
      '- checkbox "Remember me" [level=2 checked=mixed expanded=false selected ' +
        "disabled required ref=e1 url=https://x.test/]",
    );
  });

  it("renders checked=false, which is not the same as absent", () => {
    // "not ticked" and "not a checkbox" are different answers, and a model
    // that cannot tell them apart clicks a box that was already right.
    expect(
      renderA11yTree({ role: "checkbox", name: "A", checked: false }),
    ).toBe('- checkbox "A" [checked=false]');
  });

  it("appends a value that says something the name does not", () => {
    expect(
      renderA11yTree({ role: "textbox", name: "Email", value: "a@b.c" }),
    ).toBe('- textbox "Email": a@b.c');
    // A value echoing the name is noise.
    expect(
      renderA11yTree({ role: "textbox", name: "Email", value: "Email" }),
    ).toBe('- textbox "Email"');
  });
});

describe("renderA11yTree — what folds away", () => {
  it("drops the document root without shifting its children sideways", () => {
    expect(
      renderA11yTree({
        role: "RootWebArea",
        children: [{ role: "button", name: "Go", ref: "e1" }],
      }),
    ).toBe('- button "Go" [ref=e1]');
  });

  it("drops a single-child generic wrapper, keeping the indent", () => {
    expect(
      renderA11yTree({
        role: "RootWebArea",
        children: [
          {
            role: "generic",
            children: [
              {
                role: "generic",
                children: [{ role: "button", name: "Deep", ref: "e1" }],
              },
            ],
          },
        ],
      }),
    ).toBe('- button "Deep" [ref=e1]');
  });

  it("KEEPS a generic that holds several children — it is grouping something", () => {
    const text = renderA11yTree({
      role: "generic",
      children: [
        { role: "button", name: "A", ref: "e1" },
        { role: "button", name: "B", ref: "e2" },
      ],
    });
    expect(text).toBe(
      ["- generic", '  - button "A" [ref=e1]', '  - button "B" [ref=e2]'].join(
        "\n",
      ),
    );
  });

  it("drops whitespace-only text", () => {
    expect(
      renderA11yTree({
        role: "main",
        children: [
          { role: "text", name: "   " },
          { role: "text", name: "real" },
        ],
      }),
    ).toBe(["- main", '  - text "real"'].join("\n"));
  });
});

describe("renderA11yTree — omissions", () => {
  it("names the ref that retrieves an omitted subtree", () => {
    expect(
      renderA11yTree({
        role: "region",
        name: "Results",
        ref: "e1",
        children: [{ role: "omitted", hiddenNodes: 42 }],
      }),
    ).toBe(
      [
        '- region "Results" [ref=e1]',
        '  - … [42 node(s) omitted; observe {mode:"a11y", rootRef:"e1"} to read it]',
      ].join("\n"),
    );
  });

  it("inherits the nearest ancestor's ref when the parent has none", () => {
    // The marker replaces a subtree of an unnamed wrapper; the nearest handle
    // the caller actually holds is the landmark above it.
    const text = renderA11yTree({
      role: "region",
      name: "Panel",
      ref: "e1",
      children: [
        { role: "group", children: [{ role: "omitted", hiddenNodes: 3 }] },
      ],
    });
    expect(text).toContain('rootRef:"e1"');
  });

  it("still says how many are missing when nothing can retrieve them", () => {
    // No ref anywhere above: the count is still the honest half of the answer.
    const text = renderA11yTree({
      role: "main",
      children: [{ role: "omitted", hiddenNodes: 7 }],
    });
    expect(text).toContain("7 node(s) omitted]");
    expect(text).not.toContain("rootRef");
  });
});

describe("renderA11yTree — nothing to show", () => {
  it("says an interactive view found nothing, rather than looking broken", () => {
    expect(renderA11yTree(null, { interactiveOnly: true })).toBe(
      NO_INTERACTIVE_ELEMENTS,
    );
  });

  it("distinguishes an empty page from an empty interactive view", () => {
    expect(renderA11yTree(null)).toBe(EMPTY_PAGE);
    expect(renderA11yTree({ role: "RootWebArea" })).toBe(EMPTY_PAGE);
  });
});
