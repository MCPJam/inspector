/**
 * What an act changed, and the one thing that would otherwise ruin the answer.
 *
 * `assignRefs` numbers `e1..eN` in document order, so ONE inserted node
 * renumbers every line after it. A plain textual diff would then report the
 * whole rest of the page as changed by a click that opened a dropdown — which
 * is worse than no diff at all, because a model would act on it.
 */
import { describe, expect, it } from "vitest";
import { diffA11yLines, MAX_CHANGED_LINES } from "../a11y-diff";

const lines = (...parts: string[]) => parts.join("\n");

describe("diffA11yLines", () => {
  it("reports the lines an act added and removed", () => {
    expect(
      diffA11yLines(
        lines('- button "Menu" [ref=e1]'),
        lines('- button "Menu" [ref=e1]', '- menuitem "Settings" [ref=e2]'),
      ),
    ).toEqual({
      added: ['- menuitem "Settings" [ref=e2]'],
      removed: [],
    });
  });

  it("IGNORES ref renumbering", () => {
    // THE CASE THIS MODULE EXISTS FOR. One node inserted at the top renumbers
    // every ref below it; an honest textual diff calls that a whole-page
    // rewrite.
    const before = lines(
      '- button "A" [ref=e1]',
      '- button "B" [ref=e2]',
      '- button "C" [ref=e3]',
    );
    const after = lines(
      '- alert "Saved" [ref=e1]',
      '- button "A" [ref=e2]',
      '- button "B" [ref=e3]',
      '- button "C" [ref=e4]',
    );
    expect(diffA11yLines(before, after)).toEqual({
      added: ['- alert "Saved" [ref=e1]'],
      removed: [],
    });
  });

  it("emits ADDED lines verbatim, refs and all", () => {
    // A ref is the only handle a model can act on without reading pixels, and
    // these ones are live.
    const diff = diffA11yLines("", lines('- button "Save" [ref=e7]'));
    expect(diff?.added).toEqual(['- button "Save" [ref=e7]']);
  });

  it("STRIPS refs from removed lines", () => {
    // Every one of them is dead. Quoting `[ref=e7]` back at a model is an
    // invitation to aim at it.
    const diff = diffA11yLines(lines('- dialog "Confirm" [ref=e7]'), "");
    expect(diff?.removed).toEqual(['- dialog "Confirm" [ref=gone]']);
    expect(JSON.stringify(diff)).not.toContain("e7");
  });

  it("still notices a node that GAINED a ref", () => {
    // The substitution keeps a ref-bearing line distinguishable from a
    // ref-less one, so a control that became interactive is a real change.
    const diff = diffA11yLines(
      lines("- generic", '- button "Save"'),
      lines("- generic", '- button "Save" [ref=e1]'),
    );
    expect(diff?.added).toEqual(['- button "Save" [ref=e1]']);
    expect(diff?.removed).toEqual(['- button "Save"']);
  });

  it("returns nothing when nothing changed", () => {
    // Omitted rather than an empty pair: a `changed: {added:[],removed:[]}` on
    // every act is a section the model reads and learns nothing from.
    const same = lines('- button "A" [ref=e1]', '- button "B" [ref=e2]');
    expect(diffA11yLines(same, same)).toBeNull();
  });

  it("returns nothing when only the refs moved", () => {
    expect(
      diffA11yLines(
        lines('- button "A" [ref=e1]', '- button "B" [ref=e2]'),
        lines('- button "A" [ref=e9]', '- button "B" [ref=e8]'),
      ),
    ).toBeNull();
  });

  it("reports a removal and an addition on a replacement", () => {
    expect(
      diffA11yLines(
        lines('- button "Sign in" [ref=e1]'),
        lines('- button "Sign out" [ref=e1]'),
      ),
    ).toEqual({
      added: ['- button "Sign out" [ref=e1]'],
      removed: ['- button "Sign in" [ref=gone]'],
    });
  });

  it("OMITS rather than truncates past the cap", () => {
    // A truncated diff says "these things changed" while quietly meaning "some
    // of them", which is the one failure worse than no diff.
    const after = lines(
      ...Array.from(
        { length: MAX_CHANGED_LINES + 1 },
        (_, i) => `- listitem "Row ${i}" [ref=e${i}]`,
      ),
    );
    expect(diffA11yLines("", after)).toBeNull();
  });

  it("allows a diff exactly at the cap", () => {
    const after = lines(
      ...Array.from(
        { length: MAX_CHANGED_LINES },
        (_, i) => `- listitem "Row ${i}" [ref=e${i}]`,
      ),
    );
    expect(diffA11yLines("", after)?.added).toHaveLength(MAX_CHANGED_LINES);
  });

  it("collapses identical duplicate lines to one occurrence", () => {
    // A documented limitation: telling "a third identical row appeared" from
    // the other two is not worth the bookkeeping, and the tree renders them
    // identically anyway.
    const diff = diffA11yLines(
      "",
      lines('- listitem "Row"', '- listitem "Row"', '- listitem "Row"'),
    );
    expect(diff?.added).toEqual(['- listitem "Row"']);
  });

  it("keeps indentation, which is the tree's structure", () => {
    const diff = diffA11yLines(
      lines('- list "Results" [ref=e1]'),
      lines('- list "Results" [ref=e1]', '  - listitem "First" [ref=e2]'),
    );
    expect(diff?.added).toEqual(['  - listitem "First" [ref=e2]']);
  });
});
