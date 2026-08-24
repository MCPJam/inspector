import { describe, expect, it } from "vitest";
import { parseSnapshotElements } from "../mcp-app-browser-harness";

/**
 * Snapshot targets are parsed OUT OF the ARIA tree rather than read off DOM
 * attributes, and that is the whole correctness story.
 *
 * The first implementation used `aria-label` with an `innerText` fallback,
 * which is absent or empty for most real controls — a `<label for>`, an
 * `aria-labelledby`, an image's `alt`, a button's `title`. Those came back
 * role-only and ambiguous while the tree printed directly beside them showed
 * the name perfectly well. The snapshot contradicted itself, and the
 * read-a-control-and-post-it-back workflow it exists for broke on exactly the
 * widgets people build.
 */
describe("parseSnapshotElements", () => {
  it("reads the computed accessible name the tree already carries", () => {
    // None of these would have an `aria-label`; all of them have a name here.
    const tree = [
      '- button "Submit"',
      '  - textbox "Email address"',
      '- link "Docs" [ref=e3]',
    ].join("\n");
    expect(parseSnapshotElements(tree)).toEqual([
      { role: { role: "button", name: "Submit" } },
      { role: { role: "textbox", name: "Email address" } },
      { role: { role: "link", name: "Docs" } },
    ]);
  });

  it("lists only roles a step can act on", () => {
    // A target the caller cannot use is noise they still pay tokens for.
    const tree = [
      '- heading "Checkout"',
      '- paragraph "Enter your details"',
      '- button "Pay"',
    ].join("\n");
    expect(parseSnapshotElements(tree)).toEqual([
      { role: { role: "button", name: "Pay" } },
    ]);
  });

  it("flags EVERY occurrence of a duplicated (role, name), including the first", () => {
    // Only the second sighting proves the collision, but the caller needs to
    // know before using either one — otherwise they discover it when the step
    // fails on a strict-mode violation.
    const tree = ['- button "Delete"', '- button "Delete"'].join("\n");
    const parsed = parseSnapshotElements(tree);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((entry) => entry.ambiguous === true)).toBe(true);
  });

  it("keeps an unnamed control addressable by role alone", () => {
    expect(parseSnapshotElements("- textbox")).toEqual([
      { role: { role: "textbox" } },
    ]);
  });

  it("unescapes a quoted name", () => {
    expect(parseSnapshotElements(String.raw`- button "Say \"hi\""`)).toEqual([
      { role: { role: "button", name: 'Say "hi"' } },
    ]);
  });
});
