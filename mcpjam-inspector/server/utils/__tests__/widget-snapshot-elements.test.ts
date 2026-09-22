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
      { role: { role: "button", name: "Submit", exact: true } },
      { role: { role: "textbox", name: "Email address", exact: true } },
      { role: { role: "link", name: "Docs", exact: true } },
    ]);
  });

  it("emits EXACT targets so a name is not a substring match", () => {
    // Playwright's getByRole name matching is substring and case-insensitive
    // by default. Without `exact`, these two are unambiguous by name yet
    // `{ name: "Save" }` matches both, and posting it back fails the step with
    // a strict-mode violation — the target the snapshot handed you.
    const parsed = parseSnapshotElements(
      ['- button "Save"', '- button "Save as"'].join("\n"),
    );
    expect(parsed.every((entry) => entry.role?.exact === true)).toBe(true);
    expect(parsed.every((entry) => entry.ambiguous)).toBeFalsy();
  });

  it("lists only roles a step can act on", () => {
    // A target the caller cannot use is noise they still pay tokens for.
    const tree = [
      '- heading "Checkout"',
      '- paragraph "Enter your details"',
      '- button "Pay"',
    ].join("\n");
    expect(parseSnapshotElements(tree)).toEqual([
      { role: { role: "button", name: "Pay", exact: true } },
    ]);
  });

  it("flags EVERY occurrence of a duplicated (role, name) and numbers them", () => {
    // Only the second sighting proves the collision, but the caller needs to
    // know before using either one — otherwise they discover it when the step
    // fails on a strict-mode violation. `nth` ships with the flag so the
    // target is disambiguable in the same object.
    const tree = ['- button "Delete"', '- button "Delete"'].join("\n");
    const parsed = parseSnapshotElements(tree);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((entry) => entry.ambiguous === true)).toBe(true);
    expect(parsed.map((entry) => entry.nth)).toEqual([0, 1]);
  });

  it("omits nth on a unique target", () => {
    // `nth` on a unique match adds nothing and reads like a warning.
    const parsed = parseSnapshotElements('- button "Only"');
    expect(parsed[0]).not.toHaveProperty("nth");
  });

  it("keeps an unnamed control addressable by role alone", () => {
    expect(parseSnapshotElements("- textbox")).toEqual([
      { role: { role: "textbox" } },
    ]);
  });

  it("unescapes a quoted name", () => {
    expect(parseSnapshotElements(String.raw`- button "Say \"hi\""`)).toEqual([
      { role: { role: "button", name: 'Say "hi"', exact: true } },
    ]);
  });
});
