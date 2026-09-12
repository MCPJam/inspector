/**
 * The accessibility tree over raw CDP — the ONE reader, for every engine.
 *
 * It used to live under `electron/` because Playwright had its own path:
 * `locator.ariaSnapshot()` returned YAML that a hand-written parser rebuilt
 * into a tree. That parser is gone and both engines read
 * `Accessibility.getFullAXTree` — the domain `ariaSnapshot` is itself built on
 * — through `DriverPage.cdp()`. Two consequences, and both are the point:
 * a tree observed on one engine now reads identically on the other, and every
 * node keeps its `backendDOMNodeId`, which is what an act can be aimed at. YAML
 * had no node identity in it at all, so no amount of parsing could have
 * produced a ref that survived the trip back.
 *
 * Pure CDP and dependency-free: unit-testable against a fake `CdpLike`.
 */

import {
  MAX_A11Y_FRAMES,
  MAX_A11Y_FRAME_DEPTH,
  type A11yNode,
} from "./observation-budget";
import type { CdpLike } from "./webmcp-bridge";

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
 * The outcome of a read: whether the page could ANSWER, and what it said.
 *
 * The two used to collapse into `null`, and the driver reported the result as
 * a successful observation of a page with no controls. Those are opposite
 * instructions: "there is nothing to click here" tells a model to go
 * elsewhere, while "I could not read this page" tells it to look again or
 * fall back to text. A reader that cannot tell them apart makes the model
 * confidently wrong about a page it never read.
 */
export type AxTreeRead = { ok: true; tree: A11yNode | null } | { ok: false };

/**
 * Read the tree, rooted at the whole document or at one node.
 *
 * `{ok: false}` means the page could not answer at all — the domain is
 * unavailable, the page is mid-navigation. `{ok: true, tree: null}` means it
 * answered with nothing, which for a requested root means that root is gone;
 * the driver decides what each means, because only it knows whether it asked
 * for a root.
 */
export async function readAxTree(
  cdp: CdpLike,
  rootBackendNodeId?: number,
  options: {
    /**
     * Backend ids of elements that SCROLL, from `DOM.getDocument`.
     *
     * A scroll container is almost always a `generic` — a `div` with
     * `overflow:auto` — and `build` folds every `generic` away, so today the
     * model cannot see one at all: it reads a list of items with no indication
     * that the list itself moves, tries `scroll`, and moves the document
     * behind it instead.
     *
     * Passing the set keeps those generics and stamps them `scrollable: true`.
     * Passing NOTHING is byte-identical to the behaviour before this argument
     * existed, which is what the eval goldens depend on.
     */
    scrollable?: ReadonlySet<number>;
  } = {},
): Promise<AxTreeRead> {
  try {
    await cdp.send("Accessibility.enable");
    const response = (await cdp.send("Accessibility.getFullAXTree")) as
      { nodes?: AxNode[] } | undefined;
    return buildFromNodes(
      response?.nodes,
      rootBackendNodeId,
      options.scrollable,
    );
  } catch {
    return { ok: false };
  }
}

/**
 * Turn CDP's flat, id-joined node list into a tree.
 *
 * Extracted so a FRAME-SCOPED read (`readAxTreeForFrame`, below) builds
 * through exactly the same code. Two builders would be two sets of folding
 * rules, and a frame's subtree that folded differently from the page it sits
 * in would be visibly inconsistent in one rendered tree.
 */
function buildFromNodes(
  nodes: AxNode[] | undefined,
  rootBackendNodeId: number | undefined,
  scrollable: ReadonlySet<number> | undefined,
): AxTreeRead {
  // No nodes at all is the page failing to answer, not a page with nothing
  // in it: every document has at least a root.
  if (!nodes || nodes.length === 0) return { ok: false };

  const byId = new Map<string, AxNode>();
  for (const node of nodes) byId.set(node.nodeId, node);

  const root = rootBackendNodeId
    ? nodes.find((n) => n.backendDOMNodeId === rootBackendNodeId)
    : nodes[0];
  // A requested root that is not in the tree ANSWERED — with "that element
  // is gone". The whole-document case cannot reach this.
  if (!root) return { ok: true, tree: null };

  // `getFullAXTree` answers a flat list joined by ids, and a malformed or
  // cyclic set would otherwise walk forever. Visiting each id once bounds it.
  const seen = new Set<string>();
  const built = build(root, byId, seen, scrollable);
  // A root that folds away entirely (a bare `generic` wrapper) still has to
  // answer with its children rather than with nothing.
  if (built.length === 0) return { ok: true, tree: null };
  return {
    ok: true,
    tree:
      built.length === 1
        ? built[0]!
        : { role: "RootWebArea", children: built },
  };
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
  scrollable?: ReadonlySet<number>,
): A11yNode[] {
  if (seen.has(node.nodeId)) return [];
  seen.add(node.nodeId);

  const children: A11yNode[] = [];
  for (const childId of node.childIds ?? []) {
    const child = byId.get(childId);
    if (child) children.push(...build(child, byId, seen, scrollable));
  }

  const role = scalar(node.role);
  const name = scalar(node.name);

  // An ignored node contributes nothing itself but may still parent something
  // that matters — an `aria-hidden` wrapper around a live region, say.
  if (node.ignored) return children;

  /**
   * Does this node move its own content when you wheel over it?
   *
   * Checked BEFORE the folding rule below and not after, because the answer
   * is the reason to break that rule: a scroll container is almost always a
   * bare `generic`, which is exactly what `UNINTERESTING_ROLES` exists to
   * throw away. Without the set, this is always false and the fold is
   * untouched.
   */
  const scrolls =
    scrollable !== undefined &&
    typeof node.backendDOMNodeId === "number" &&
    scrollable.has(node.backendDOMNodeId);

  if (typeof role === "string" && UNINTERESTING_ROLES.has(role) && !scrolls) {
    // Text with content is the exception: a `StaticText` IS the page's words,
    // and folding it away leaves a tree of labels with nothing written in it.
    if (role === "StaticText" && typeof name === "string") {
      return [{ role: "text", name }];
    }
    return children;
  }

  const built: A11yNode = {};
  if (typeof role === "string") built.role = role;
  // Carried so an act can be aimed at what an observation named. This is the
  // whole reason the tree is read over CDP rather than parsed out of YAML:
  // without a node identity, a ref could only ever be a guess at a coordinate.
  if (typeof node.backendDOMNodeId === "number") {
    built.backendDOMNodeId = node.backendDOMNodeId;
  }
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
  // Stamped last so it cannot be shadowed by a carried CDP property, and only
  // when true: a `scrollable: false` on every node would be a new key on every
  // line of every tree, which is the one thing the byte-identity rule forbids.
  if (scrolls) built.scrollable = true;
  if (children.length > 0) built.children = children;
  return [built];
}

/**
 * Which elements on this page scroll their own content.
 *
 * ONE CALL, answered by the DOM domain rather than computed: `DOM.getDocument`
 * with `pierce` reports `isScrollable` per node, which is Chromium's own
 * layout answer and cannot drift from what a wheel event will actually do. The
 * alternative — evaluating `getComputedStyle` over every element — is a script
 * in the page, on a page that may be hostile, to re-derive something the
 * browser already knows.
 *
 * THE DOCUMENT SCROLLER IS EXCLUDED. `html`/`body` scroll on almost every page
 * and are what a bare `scroll` already moves, so marking them would put
 * `[scrollable]` on the root of every tree and tell the model nothing.
 *
 * Best-effort: a page that cannot answer yields an empty set, and the tree is
 * read exactly as it is today.
 */
export async function readScrollableNodes(
  cdp: CdpLike,
): Promise<Set<number>> {
  const found = new Set<number>();
  try {
    const doc = (await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as { root?: DomNode };
    const root = doc?.root;
    if (!root) return found;
    // ITERATIVE, like every other walk over page-controlled structure here: a
    // hostile or merely deep page must not be able to end the daemon with a
    // stack overflow on a walk it asked for.
    const stack: DomNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (
        node.isScrollable === true &&
        typeof node.backendNodeId === "number" &&
        !DOCUMENT_SCROLLER_NAMES.has(node.nodeName ?? "")
      ) {
        found.add(node.backendNodeId);
      }
      for (const child of node.children ?? []) stack.push(child);
      for (const child of node.shadowRoots ?? []) stack.push(child);
      if (node.contentDocument) stack.push(node.contentDocument);
    }
  } catch {
    // No answer is an empty set, not a failed observation: the tree is worth
    // returning without the markers, and the markers are worth nothing
    // without the tree.
  }
  return found;
}

/** `html` and `body` scroll on almost every page; a bare `scroll` moves them. */
const DOCUMENT_SCROLLER_NAMES: ReadonlySet<string> = new Set(["HTML", "BODY"]);

/** The subset of `DOM.getDocument`'s node shape this module reads. */
interface DomNode {
  backendNodeId?: number;
  nodeName?: string;
  isScrollable?: boolean;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
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

/**
 * READING PAST AN IFRAME.
 *
 * `Accessibility.getFullAXTree` answers for ONE document. A document's AX tree
 * does NOT descend into a child document — same-origin or cross-origin, it
 * makes no difference — so today an `<iframe>` is a leaf node with a ref and
 * the model cannot see a single control inside it. A login form, a payment
 * field, an embedded app: all invisible, with nothing saying so.
 *
 * The fix is to read each child frame's own tree and splice it in at the
 * `Iframe` node that owns it. Two mechanisms, and which one applies depends on
 * whether Chromium gave the frame its own target:
 *
 *   - A SAME-PROCESS child is inside its parent's session, so its tree is read
 *     on that session with `{frameId}`.
 *   - An OOPIF is a separate target with its own session, and its tree is read
 *     there with NO `frameId` — it is that session's own root document, and
 *     passing an id its session has never heard of answers nothing.
 *
 * THERE IS NO UNSCOPED RETRY. A frame-scoped read that fails must leave the
 * iframe line as it is: falling back to a plain `getFullAXTree` on the owner
 * session would re-read the WHOLE PAGE and splice it under its own iframe node,
 * producing a tree that contains itself.
 */

/** The frame sessions a reader was given. @see DriverPage.frameSessions */
export interface FrameSession {
  frameId: string;
  cdp: CdpLike;
}

/** A node's provenance, stamped during the splice. @see readAxForest */
export interface FrameStamp {
  /** The CDP frame this node lives in. Absent on the main document. */
  frameId?: string;
  /**
   * The frame whose SESSION answered for it, absent when the page session did.
   *
   * Different from `frameId` for a same-process child: it lives in frame X and
   * was read on the page's session. An act aimed at it has to be dispatched on
   * the session that can resolve its node id, which is this one.
   */
  sessionFrameId?: string;
}

/** Where one spliced frame sits, so an act can translate a point out of it. */
export interface FrameTopology {
  /** The `<iframe>` DOM node that hosts it, IN THE PARENT document. */
  hostBackendNodeId: number;
  /** Its parent's session frame id; absent when the parent is the page. */
  parentSessionFrameId?: string;
  frameId: string;
}

export interface AxForestRead {
  ok: boolean;
  tree: A11yNode | null;
  /** Child frames that could not be read, or that the caps refused. */
  framesOmitted: number;
  /**
   * The frames that got their OWN SESSION, keyed by session frame id.
   *
   * Only those: a same-process child shares its parent's session, so its
   * coordinates already arrive in the top frame's space and there is nothing
   * to translate. Empty for a page with no out-of-process frames, which is why
   * `RefMap.frames` stays absent on almost every observation.
   */
  frames: Map<string, FrameTopology>;
}

/** One entry of `Page.getFrameTree`'s recursive answer. */
interface CdpFrameTree {
  frame?: { id?: string; parentId?: string };
  childFrames?: CdpFrameTree[];
}

/**
 * The page's tree with every readable child frame spliced into it.
 *
 * ZERO EXTRA CDP CALLS for a page with no iframes, which is most pages: the
 * root tree is read exactly as `readAxTree` reads it, and if it contains no
 * `Iframe` node this returns immediately.
 *
 * Any single frame's failure costs that frame and nothing else — its `Iframe`
 * line stays exactly as it is today and `framesOmitted` counts it — because
 * the alternative is an observation that fails because an advertisement would
 * not answer.
 */
export async function readAxForest(
  root: CdpLike,
  frames: ReadonlyArray<FrameSession>,
  options: {
    scrollable?: ReadonlySet<number>;
    maxFrames?: number;
    maxDepth?: number;
  } = {},
): Promise<AxForestRead> {
  const read = await readAxTree(root, undefined, options);
  const frames_ = new Map<string, FrameTopology>();
  if (!read.ok)
    return { ok: false, tree: null, framesOmitted: 0, frames: frames_ };
  if (!read.tree)
    return { ok: true, tree: null, framesOmitted: 0, frames: frames_ };

  // The iframe nodes we could splice into, by the DOM node that owns them.
  const hosts = iframeNodesByBackendId(read.tree);
  // NOTHING TO DO, and nothing spent finding that out. An `Iframe` node is the
  // only place a child tree can attach, so a page without one cannot have a
  // frame worth reading.
  if (hosts.size === 0)
    return { ok: true, tree: read.tree, framesOmitted: 0, frames: frames_ };

  const tree = await root
    .send("Page.getFrameTree")
    .catch(() => undefined) as { frameTree?: CdpFrameTree } | undefined;
  const frameTree = tree?.frameTree;
  if (!frameTree)
    return { ok: true, tree: read.tree, framesOmitted: 0, frames: frames_ };

  const sessionByFrame = new Map(frames.map((f) => [f.frameId, f.cdp]));
  const maxFrames = options.maxFrames ?? MAX_A11Y_FRAMES;
  const maxDepth = options.maxDepth ?? MAX_A11Y_FRAME_DEPTH;
  let framesOmitted = 0;
  let read_ = 0;

  /**
   * Splice every child of `parent` into the tree, depth-first.
   *
   * `ownerCdp` is the session that answers for `parent`'s children: an OOPIF's
   * own session if it has one, otherwise whatever answered for `parent`.
   */
  const walk = async (
    parent: CdpFrameTree,
    ownerCdp: CdpLike,
    ownerFrameId: string | undefined,
    depth: number,
  ): Promise<void> => {
    if (depth > maxDepth) {
      framesOmitted += countFrames(parent);
      return;
    }
    for (const child of parent.childFrames ?? []) {
      const childId = child.frame?.id;
      if (!childId) continue;
      if (read_ >= maxFrames) {
        framesOmitted += 1 + countFrames(child);
        continue;
      }
      const ownSession = sessionByFrame.get(childId);
      // WHICH ELEMENT HOSTS IT, asked on the PARENT's owner session — the only
      // session that has the host element in its DOM. Without a host we cannot
      // say where the tree goes, and guessing would splice a frame's content
      // under an unrelated element.
      const owner = (await ownerCdp
        .send("DOM.getFrameOwner", { frameId: childId })
        .catch(() => undefined)) as { backendNodeId?: number } | undefined;
      const hostNode =
        typeof owner?.backendNodeId === "number"
          ? hosts.get(owner.backendNodeId)
          : undefined;
      if (!hostNode) {
        framesOmitted += 1 + countFrames(child);
        continue;
      }
      // An OOPIF reads on its OWN session with no params: the frame is that
      // session's root document, and an id it has never heard of answers
      // nothing. A same-process child reads on the owner's session, scoped.
      const childRead = ownSession
        ? await readAxTree(ownSession, undefined, options)
        : await readAxTreeForFrame(ownerCdp, childId, options);
      read_ += 1;
      if (!childRead.ok || !childRead.tree) {
        // NO UNSCOPED RETRY. See this section's header: falling back to a
        // whole-document read here splices the page under its own iframe.
        framesOmitted += 1 + countFrames(child);
        continue;
      }
      const childSessionFrameId = ownSession ? childId : ownerFrameId;
      if (ownSession) {
        // ONLY a frame with its own session goes in the topology: a
        // same-process child's coordinates already arrive in the top frame's
        // space, so there is nothing for an act to translate.
        frames_.set(childId, {
          hostBackendNodeId: owner!.backendNodeId!,
          ...(ownerFrameId !== undefined
            ? { parentSessionFrameId: ownerFrameId }
            : {}),
          frameId: childId,
        });
      }
      stampFrame(childRead.tree, childId, childSessionFrameId);
      // AT THE NODE, not merged into it: the child's own `RootWebArea` is
      // transparent to the renderer, so its children land one indent under the
      // `- Iframe "…"` line and read as being inside it.
      hostNode.children = [childRead.tree];
      await walk(
        child,
        ownSession ?? ownerCdp,
        childSessionFrameId,
        depth + 1,
      );
    }
  };

  await walk(frameTree, root, undefined, 1);
  return { ok: true, tree: read.tree, framesOmitted, frames: frames_ };
}

/** Read ONE frame's tree on a session that contains it. */
async function readAxTreeForFrame(
  cdp: CdpLike,
  frameId: string,
  options: { scrollable?: ReadonlySet<number> },
): Promise<AxTreeRead> {
  try {
    await cdp.send("Accessibility.enable");
    const response = (await cdp.send("Accessibility.getFullAXTree", {
      frameId,
    })) as { nodes?: AxNode[] } | undefined;
    return buildFromNodes(response?.nodes, undefined, options.scrollable);
  } catch {
    return { ok: false };
  }
}

/** Every `Iframe` node in a tree, keyed by the DOM node it renders. */
function iframeNodesByBackendId(root: A11yNode): Map<number, A11yNode> {
  const found = new Map<number, A11yNode>();
  // ITERATIVE: a hostile or merely deep page must not end the daemon with a
  // stack overflow on a walk it asked for.
  const stack: A11yNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node.role === "Iframe" &&
      typeof node.backendDOMNodeId === "number"
    ) {
      found.set(node.backendDOMNodeId, node);
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return found;
}

/** Mark a spliced subtree with where it came from and who can answer for it. */
function stampFrame(
  root: A11yNode,
  frameId: string,
  sessionFrameId: string | undefined,
): void {
  const stack: A11yNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.frameId = frameId;
    // `undefined` means the PAGE session, which is the common case for a
    // same-process child — so it is left off rather than written as a
    // sentinel.
    if (sessionFrameId !== undefined) node.sessionFrameId = sessionFrameId;
    for (const child of node.children ?? []) stack.push(child);
  }
}

/** How many frames a subtree contains, for an honest `framesOmitted`. */
function countFrames(node: CdpFrameTree): number {
  let total = 0;
  const stack: CdpFrameTree[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of current.childFrames ?? []) {
      total += 1;
      stack.push(child);
    }
  }
  return total;
}
