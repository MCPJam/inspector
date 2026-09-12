/**
 * What an act CHANGED, beside the page it changed.
 *
 * Every act returns the whole accessibility tree, and on a real page that is
 * hundreds of lines of which one or two moved. The model reads all of it to
 * find out whether the menu opened — and a model that cannot cheaply tell what
 * its click did tends to click again.
 *
 * So this reports the lines an act ADDED and REMOVED, alongside the full tree
 * rather than instead of it. Not instead, because a diff is only meaningful
 * against a tree the reader already has, and the first act of a turn has no
 * previous render to diff against.
 *
 * REFS ARE STRIPPED BEFORE COMPARING, and this is the whole reason the diff is
 * line-wise-with-a-rule rather than a plain set difference. `assignRefs` numbers
 * `e1..eN` in document order, so ONE inserted node renumbers every line after
 * it — and an honest textual diff would then report the entire rest of the page
 * as changed by a click that opened a dropdown.
 *
 * Which side keeps its refs is not symmetric:
 *
 *   - `added` lines are emitted VERBATIM, refs and all. They name elements
 *     that exist right now, and a ref is the only handle the model can act on.
 *   - `removed` lines are emitted with refs STRIPPED. Those refs are dead by
 *     definition, and quoting a dead `[ref=e7]` back at a model is an
 *     invitation to aim at it.
 */

/** `- button "Save" [ref=e7]` → `- button "Save" []`, for comparison only. */
const REF_ATTR = /\bref=e\d+/g;

/**
 * The comparison key for a rendered line.
 *
 * The ref is replaced rather than deleted so two lines that differ ONLY by
 * having a ref at all stay distinguishable — a node that gained a ref because
 * it became interactive really is a change worth reporting.
 */
function keyOf(line: string): string {
  return line.replace(REF_ATTR, "ref=•");
}

/** The same substitution, for a line that is going to be SHOWN to the model. */
function stripRefs(line: string): string {
  return line.replace(REF_ATTR, "ref=gone");
}

export interface A11yDiff {
  added: string[];
  removed: string[];
}

/**
 * Cap on either side of the diff.
 *
 * OMIT, DON'T TRUNCATE — the rule the rest of this daemon's budgets follow. A
 * diff of 200+ lines is not a diff the model was going to read anyway, and a
 * truncated one is worse than none: it says "these things changed" while
 * quietly meaning "some of the things that changed".
 */
export const MAX_CHANGED_LINES = 200;

/**
 * The lines `next` has that `previous` did not, and vice versa.
 *
 * A SET difference, not an edit script. The tree is a rendering of a structure,
 * not prose: a model asking "what did my click do" wants "this appeared, that
 * went away", and the line-by-line alignment an edit script computes would
 * report a moved subtree as a large rewrite. Duplicate identical lines (two
 * `- listitem "Row"` in the same list) collapse to one occurrence on each side,
 * which is a deliberate limitation: reporting "a third identical row appeared"
 * is not worth the bookkeeping to tell it from the other two.
 *
 * Returns `null` when either side would exceed the cap, so the caller omits the
 * section rather than showing a partial one.
 */
export function diffA11yLines(
  previous: string,
  next: string,
): A11yDiff | null {
  const previousKeys = new Set(previous.split("\n").map(keyOf));
  const nextKeys = new Set(next.split("\n").map(keyOf));

  const added: string[] = [];
  const seenAdded = new Set<string>();
  for (const line of next.split("\n")) {
    const key = keyOf(line);
    if (previousKeys.has(key) || seenAdded.has(key)) continue;
    seenAdded.add(key);
    // VERBATIM: these refs are live, and a ref is the only handle a model can
    // act on without reading pixels.
    added.push(line);
  }

  const removed: string[] = [];
  const seenRemoved = new Set<string>();
  for (const line of previous.split("\n")) {
    const key = keyOf(line);
    if (nextKeys.has(key) || seenRemoved.has(key)) continue;
    seenRemoved.add(key);
    // REFS STRIPPED: every one of them is dead, and quoting a dead `[ref=e7]`
    // back at a model is an invitation to aim at it.
    removed.push(stripRefs(line));
  }

  if (added.length > MAX_CHANGED_LINES || removed.length > MAX_CHANGED_LINES) {
    return null;
  }
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}
