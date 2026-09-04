/**
 * The accessibility tree over raw CDP.
 *
 * The Playwright engine gets its tree from `ariaSnapshot`, which returns YAML
 * that `parseAriaSnapshot` rebuilds. Electron has no Playwright, so it reads
 * the same tree from `Accessibility.getFullAXTree` — the domain `ariaSnapshot`
 * is itself built on — and shapes it into the `A11yNode` the L9 budget already
 * knows how to trim.
 *
 * WHY IT LIVES HERE AND NOT IN `daemon/`. I-2b replaces `ariaSnapshot` for
 * every engine and moves this next to the driver, gated on a golden fixture
 * proving the CDP tree reads at least as well as today's YAML. That gate
 * matters for the Playwright engine, which has output a model already depends
 * on. It does not apply to Electron, which has no a11y output at all today —
 * so this ships here, serving the one engine that would otherwise have none,
 * and moves when the fixture says the other engine may follow.
 *
 * Pure CDP and dependency-free: unit-testable against a fake `CdpLike`.
 */

import type { A11yNode } from "../daemon/observation-budget";
import type { CdpLike } from "../daemon/webmcp-bridge";

/**
 * Roles that carry no meaning of their own.
 *
 * `ariaSnapshot` folds these away and the budget's node count is spent on what
 * is left, so keeping them would both change what the model sees and waste the
 * budget on `generic > generic > generic` chains that describe nothing.
 */
const UNINTERESTING_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "StaticText",
]);

interface AxValue {
  type?: string;
  value?: unknown;
}

/**
 * AX properties whose value arrives as `"true"` / `"false"` / `"mixed"`.
 *
 * Only these two are `tristate` in the CDP Accessibility domain — `selected`
 * and `expanded` are plain booleans and were in this set on a wrong reading of
 * the spec. Including them was harmless (the string comparison never fires on
 * a real boolean) and misleading, which is the worse half: a maintainer would
 * have taken the grouping as evidence about the protocol.
 */
const TRISTATE_PROPERTIES = new Set(["checked", "pressed"]);

interface AxProperty {
  name?: string;
  value?: AxValue;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  properties?: AxProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/**
 * AX properties worth carrying up, and what to call them.
 *
 * Not decoration: these are what let the model tell a ticked box from an empty
 * one, an open menu from a closed one, a disabled button from a live one, and
 * a second-level heading from a top-level one. `ariaSnapshot` renders them
 * inline (`checkbox "Remember me" [checked]`), so dropping them here would
 * have made the Electron engine's tree read the same shape while saying
 * strictly less — the kind of gap nobody notices until an agent confidently
 * clicks a checkbox that was already ticked.
 */
const CARRIED_PROPERTIES: Record<string, string> = {
  checked: "checked",
  disabled: "disabled",
  expanded: "expanded",
  focused: "focused",
  level: "level",
  pressed: "pressed",
  readonly: "readonly",
  required: "required",
  selected: "selected",
  url: "url",
  valuemin: "valueMin",
  valuemax: "valueMax",
  valuetext: "valueText",
};

/** An AX property's value, when it is a string or number worth carrying. */
function scalar(value: AxValue | undefined): string | number | undefined {
  const raw = value?.value;
  if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
  if (typeof raw === "number") return raw;
  return undefined;
}

/**
 * Read the tree, rooted at the whole document or at one node.
 *
 * Resolves `null` when the tree cannot be had — the domain is unavailable, the
 * page is mid-navigation, the root matched nothing. The driver distinguishes
 * "no tree" from "root selector matched nothing" by whether it asked for a
 * root, so this must not invent an empty tree for either case.
 */
export async function readAxTree(
  cdp: CdpLike,
  rootBackendNodeId?: number,
): Promise<A11yNode | null> {
  try {
    await cdp.send("Accessibility.enable");
    const response = (await cdp.send("Accessibility.getFullAXTree")) as
      { nodes?: AxNode[] } | undefined;
    const nodes = response?.nodes;
    if (!nodes || nodes.length === 0) return null;

    const byId = new Map<string, AxNode>();
    for (const node of nodes) byId.set(node.nodeId, node);

    const root = rootBackendNodeId
      ? nodes.find((n) => n.backendDOMNodeId === rootBackendNodeId)
      : nodes[0];
    if (!root) return null;

    // `getFullAXTree` answers a flat list joined by ids, and a malformed or
    // cyclic set would otherwise walk forever. Visiting each id once bounds it.
    const seen = new Set<string>();
    const built = build(root, byId, seen);
    // A root that folds away entirely (a bare `generic` wrapper) still has to
    // answer with its children rather than with nothing.
    if (built.length === 0) return null;
    return built.length === 1
      ? built[0]!
      : { role: "RootWebArea", children: built };
  } catch {
    return null;
  }
}

/**
 * One AX node and its descendants, with uninteresting nodes folded away.
 *
 * Returns a LIST because folding is not one-to-one: a `generic` wrapper
 * disappears and its children take its place in the parent, which is what
 * keeps `div > div > button` reading as `button`.
 */
function build(
  node: AxNode,
  byId: Map<string, AxNode>,
  seen: Set<string>,
): A11yNode[] {
  if (seen.has(node.nodeId)) return [];
  seen.add(node.nodeId);

  const children: A11yNode[] = [];
  for (const childId of node.childIds ?? []) {
    const child = byId.get(childId);
    if (child) children.push(...build(child, byId, seen));
  }

  const role = scalar(node.role);
  const name = scalar(node.name);

  // An ignored node contributes nothing itself but may still parent something
  // that matters — an `aria-hidden` wrapper around a live region, say.
  if (node.ignored) return children;

  if (typeof role === "string" && UNINTERESTING_ROLES.has(role)) {
    // Text with content is the exception: a `StaticText` IS the page's words,
    // and folding it away leaves a tree of labels with nothing written in it.
    if (role === "StaticText" && typeof name === "string") {
      return [{ role: "text", name }];
    }
    return children;
  }

  const built: A11yNode = {};
  if (typeof role === "string") built.role = role;
  if (name !== undefined) built.name = String(name);
  const value = scalar(node.value);
  if (value !== undefined) built.value = value;
  const description = scalar(node.description);
  if (description !== undefined) built.description = String(description);
  for (const property of node.properties ?? []) {
    const key = property.name && CARRIED_PROPERTIES[property.name];
    if (!key) continue;
    const raw = property.value?.value;
    // `false` and `0` are answers, so only absence is skipped. A `false` on
    // `checked` is the difference between "not ticked" and "not a checkbox".
    if (raw === undefined || raw === null || raw === "") continue;
    // CDP reports the tristates as STRINGS — "true" / "false" / "mixed" — where
    // `ariaSnapshot` gives a boolean for the first two. A consumer written
    // against one engine and handed the other would read `checked: "false"` as
    // truthy and call an empty box ticked, so the two booleans are normalised
    // and only "mixed" stays a string, because it is not a boolean.
    built[key] =
      TRISTATE_PROPERTIES.has(property.name!) &&
      (raw === "true" || raw === "false")
        ? raw === "true"
        : raw;
  }
  if (children.length > 0) built.children = children;
  return [built];
}

/**
 * The backend node id for a CSS selector, or `null` when nothing matches.
 *
 * Separate from `readAxTree` because the caller needs to tell an unmatched
 * ROOT SELECTOR (an error the model can act on: "that element isn't there")
 * from an unavailable tree (not the model's fault and not its problem).
 */
export async function resolveBackendNodeId(
  cdp: CdpLike,
  selector: string,
): Promise<number | null> {
  try {
    const doc = (await cdp.send("DOM.getDocument", { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const rootNodeId = doc?.root?.nodeId;
    if (rootNodeId === undefined) return null;
    const found = (await cdp.send("DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    })) as { nodeId?: number };
    if (!found?.nodeId) return null;
    const described = (await cdp.send("DOM.describeNode", {
      nodeId: found.nodeId,
    })) as { node?: { backendNodeId?: number } };
    return described?.node?.backendNodeId ?? null;
  } catch {
    return null;
  }
}
