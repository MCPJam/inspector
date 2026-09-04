/**
 * Refs: how an observation names an element, and how an act finds it again.
 *
 * The model could already aim at a coordinate read off a screenshot or at a
 * CSS selector it invented. Both are worse than they look. A coordinate is
 * only valid for the exact frame it was read from — anything that reflows
 * (a banner loading, a font swapping in) silently moves the target while the
 * number stays legal. A selector is the model guessing at markup it has never
 * seen, and `.btn-primary` matching three buttons fails in a way that reads
 * like the page was wrong.
 *
 * A ref is neither: the observation names the element (`ref=e7`), and the act
 * hands that name back. What it resolves to is a `backendDOMNodeId` the reader
 * carried up from the AX tree, so the target is the node the model actually
 * read about.
 *
 * FRESH ON EVERY OBSERVATION, deliberately. A map kept across observations has
 * to answer what `e7` means after the page re-rendered, and every answer is
 * bad: renumber and the model acts on a stale number, keep the number and it
 * points at a node that no longer exists. Numbering per observation makes the
 * contract one sentence — act on refs from your LATEST observation — and the
 * model re-observes after every act anyway, because that is where the result
 * comes from. The map records the state token it was minted against, so a ref
 * from an older page is refused rather than resolved against a new one.
 */

import type { A11yNode } from "./observation-budget";
import type { ObservationStateToken } from "../protocol";

/**
 * Roles a model can act on. These get a ref whether or not they are named,
 * because an unnamed control is exactly the one it cannot describe any other
 * way.
 */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
  "Iframe",
]);

/**
 * Roles that orient rather than act. They earn a ref only when NAMED: an
 * anonymous `region` tells the model nothing it could ask for by name, and
 * numbering it spends a ref on noise.
 */
export const CONTENT_ROLES = new Set([
  "heading",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "listitem",
  "article",
  "region",
  "main",
  "navigation",
]);

/** Does this node get a ref? */
export function isRefWorthy(node: A11yNode): boolean {
  const role = node.role;
  if (typeof role !== "string") return false;
  if (INTERACTIVE_ROLES.has(role)) return true;
  return (
    CONTENT_ROLES.has(role) &&
    typeof node.name === "string" &&
    node.name.length > 0
  );
}

/**
 * What a ref points at, kept per tab until the next observation replaces it.
 *
 * `role`/`name`/`nth` are the recovery path, not decoration: when the node id
 * no longer resolves (a re-render replaced the element with an identical one),
 * an act can still find "the second button called Save" rather than failing at
 * a page that, to the model, has not changed.
 */
export interface RefEntry {
  backendDOMNodeId?: number;
  role: string;
  name: string;
  /** Index among nodes sharing this role+name, set ONLY when it is ambiguous. */
  nth?: number;
}

export interface RefMap {
  /**
   * The observation these refs were minted against. An act carrying a ref from
   * a different token is refused: role+name recovery on a page that has since
   * navigated would find a same-named button on a DIFFERENT page and click it.
   */
  stateToken?: ObservationStateToken;
  entries: Map<string, RefEntry>;
}

/**
 * Keep only what a model can act on, and the structure that leads to it.
 *
 * Runs BEFORE the budget, which is the whole reason it exists as a tree pass
 * rather than a rendering flag: a page whose text outnumbers its controls
 * would otherwise spend the 400-node budget on prose and report the buttons as
 * omitted. Prose is what `observe {mode:"text"}` is for.
 *
 * A node survives if it is ref-worthy or if a descendant is; a dropped node's
 * surviving children take its place, so `div > div > button` collapses to
 * `button` instead of vanishing with its wrapper.
 */
export function filterInteractive(node: A11yNode): A11yNode | null {
  const children: A11yNode[] = [];
  for (const child of node.children ?? []) {
    const kept = filterInteractive(child);
    if (kept) children.push(kept);
  }
  const { children: _dropped, ...rest } = node;
  if (isRefWorthy(node)) {
    return children.length > 0 ? { ...rest, children } : { ...rest };
  }
  if (children.length === 0) return null;
  // Not actionable itself, but on the path to something that is. Keeping the
  // node (rather than splicing its children into the parent) preserves the
  // nesting a model uses to tell one list row's button from the next one's.
  return { ...rest, children };
}

/**
 * Number every ref-worthy node in render order and return what they point at.
 *
 * MUTATES the nodes (setting `ref`), because the renderer and the map must
 * agree by construction: a second pass that recomputed which nodes deserve
 * refs could disagree with this one, and then a rendered `e7` would resolve to
 * a different element than the map says.
 */
export function assignRefs(root: A11yNode | null): Map<string, RefEntry> {
  const entries = new Map<string, RefEntry>();
  if (!root) return entries;
  // How many nodes share each role+name, so `nth` is recorded only where it
  // disambiguates. A page with one "Save" button should not carry an index
  // that implies there are others.
  const seen = new Map<string, number>();
  const count = (node: A11yNode) => {
    if (isRefWorthy(node)) {
      const key = `${node.role}:${node.name ?? ""}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const child of node.children ?? []) count(child);
  };
  count(root);

  const position = new Map<string, number>();
  let next = 1;
  const visit = (node: A11yNode) => {
    if (isRefWorthy(node)) {
      const role = node.role as string;
      const name = typeof node.name === "string" ? node.name : "";
      const key = `${role}:${name}`;
      const index = position.get(key) ?? 0;
      position.set(key, index + 1);
      const ref = `e${next}`;
      next += 1;
      node.ref = ref;
      entries.set(ref, {
        ...(typeof node.backendDOMNodeId === "number"
          ? { backendDOMNodeId: node.backendDOMNodeId }
          : {}),
        role,
        name,
        ...((seen.get(key) ?? 0) > 1 ? { nth: index } : {}),
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return entries;
}

/** Accept `e1`, `@e1`, or `ref=e1` — a model writes all three. */
export function parseRef(raw: string): string | null {
  const match = /^(?:@|ref=)?(e\d+)$/.exec(raw.trim());
  return match ? match[1]! : null;
}
