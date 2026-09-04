/**
 * The accessibility tree as indented text.
 *
 * It used to go to the model as JSON — the whole tree, unindented, every node
 * an object with quoted keys. That costs roughly twice the tokens of the same
 * information as text, and the structure a model actually needs from a tree
 * (what contains what) is carried better by indentation than by nested braces
 * it has to parse. Attributes ride inline, in a fixed order, so a line reads
 * the way the page reads:
 *
 *     - navigation "Primary"
 *       - link "Docs" [ref=e1 url=https://x.test/docs]
 *       - button "Sign in" [disabled ref=e2]
 *     - heading "Pricing" [level=2 ref=e3]
 *       - text "Three plans, billed monthly."
 *
 * Pure: a tree in, a string out. No CDP, no budget, no refs assigned here —
 * `assignRefs` has already stamped `ref` on the nodes, and this renders what
 * it finds. Keeping the two apart is what lets the map and the text agree by
 * construction rather than by two functions making the same decision twice.
 */

import type { A11yNode } from "./observation-budget";

/** What an empty render says, so "nothing here" never reads as a failure. */
export const NO_INTERACTIVE_ELEMENTS = "(no interactive elements)";
export const EMPTY_PAGE = "(empty page)";

/**
 * Attribute order, fixed.
 *
 * Fixed because these lines end up in eval transcripts and in diffs between
 * two runs of the same page: an order that varied with object key insertion
 * would make every re-observation look like a change.
 */
const FLAG_ATTRS = [
  "selected",
  "disabled",
  "required",
  "focused",
  "readonly",
] as const;

/**
 * Roles that carry no information once their children are rendered.
 *
 * `generic` with a single child is a wrapper the page author needed and the
 * model does not; the document root is implied by the observation itself.
 * Their children render at the SAME indent, so removing a wrapper never
 * shifts the tree sideways.
 */
function isTransparent(node: A11yNode): boolean {
  const role = node.role;
  if (typeof role !== "string" || role.length === 0) return true;
  if (role === "RootWebArea" || role === "WebArea") return true;
  if (role === "generic" && node.ref === undefined) {
    return (node.children?.length ?? 0) <= 1;
  }
  if (role === "text") {
    return typeof node.name !== "string" || node.name.trim().length === 0;
  }
  return false;
}

/** The bracketed attribute list, or "" when a node has none. */
function attributes(node: A11yNode): string {
  const parts: string[] = [];
  if (typeof node.level === "number") parts.push(`level=${node.level}`);
  if (node.checked !== undefined) parts.push(`checked=${String(node.checked)}`);
  if (node.expanded !== undefined)
    parts.push(`expanded=${String(node.expanded)}`);
  for (const flag of FLAG_ATTRS) {
    if (node[flag] === true) parts.push(flag);
  }
  if (typeof node.ref === "string") parts.push(`ref=${node.ref}`);
  if (typeof node.url === "string" && node.url.length > 0) {
    parts.push(`url=${node.url}`);
  }
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

/** One node's line, without its children. */
function line(node: A11yNode, indent: number): string {
  const role = typeof node.role === "string" ? node.role : "node";
  let text = `${"  ".repeat(indent)}- ${role}`;
  if (typeof node.name === "string" && node.name.length > 0) {
    // JSON-quoted so a name containing a quote, a newline or a bracket cannot
    // forge the shape of the line it sits on.
    text += ` ${JSON.stringify(node.name)}`;
  }
  text += attributes(node);
  const value = node.value;
  if (
    (typeof value === "string" || typeof value === "number") &&
    String(value).length > 0 &&
    String(value) !== node.name
  ) {
    text += `: ${String(value)}`;
  }
  return text;
}

export interface RenderOptions {
  /** Shapes the "nothing to show" answer; the filtering itself happened earlier. */
  interactiveOnly?: boolean;
}

/** Render a (already filtered, already capped, already ref'd) tree as text. */
export function renderA11yTree(
  root: A11yNode | null | undefined,
  options: RenderOptions = {},
): string {
  const lines: string[] = [];
  const visit = (node: A11yNode, indent: number, parentRef?: string) => {
    if (node.role === "omitted") {
      // The marker is rendered, never dropped: an omission the model cannot
      // see is indistinguishable from a page that ended there. The retrieval
      // verb names the PARENT's ref, because that is the element whose
      // children were dropped — and a ref is the only handle on this tree that
      // an act or a re-observation can actually take.
      const hidden =
        typeof node.hiddenNodes === "number" ? node.hiddenNodes : 0;
      const retrieval = parentRef
        ? `; observe {mode:"a11y", rootRef:"${parentRef}"} to read it`
        : "";
      lines.push(
        `${"  ".repeat(indent)}- … [${hidden} node(s) omitted${retrieval}]`,
      );
      return;
    }
    const transparent = isTransparent(node);
    if (!transparent) lines.push(line(node, indent));
    const ref = typeof node.ref === "string" ? node.ref : parentRef;
    for (const child of node.children ?? []) {
      visit(child, transparent ? indent : indent + 1, ref);
    }
  };
  if (root) visit(root, 0);
  if (lines.length === 0) {
    return options.interactiveOnly ? NO_INTERACTIVE_ELEMENTS : EMPTY_PAGE;
  }
  return lines.join("\n");
}
