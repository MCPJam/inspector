/**
 * Aiming at a node the model NAMED, rather than at a point it guessed.
 *
 * A ref is the only target a model can produce without reading pixels: the
 * accessibility tree already tells it `button "Sign in" [ref=e7]`, and until
 * this file existed the only thing it could do with that was refuse. The
 * coordinate path asks the model to translate a description into a pixel and
 * be right about it; the selector path asks it to invent CSS for a page it has
 * only seen as a tree. Both are guesses. A ref is not.
 *
 * EVERYTHING HERE IS CDP, and deliberately so. `DriverPage` (`browser-page.ts`)
 * is the per-engine seam, and node resolution is the same protocol on both
 * engines — Electron already did all of this by hand for its selector path
 * (`electron/electron-page.ts`), and Playwright's own selector path never
 * learns a node id at all. So the shared code lives here and each engine
 * contributes only its `cdp()`, exactly as the a11y tree does (`cdp-a11y.ts`).
 *
 * TWO COORDINATE SPACES, and they are not interchangeable:
 *
 *   - `DOM.getBoxModel` answers in the TOP frame's viewport, which is the
 *     space `Input.dispatchMouseEvent` and `DriverPage.clickAt` take. That is
 *     the point we click.
 *   - `document.elementFromPoint` answers in ITS OWN document's viewport. So
 *     the occlusion check never carries a point across the boundary: it runs
 *     inside the element's own document and computes the centre there.
 *
 * Mixing them is how an occlusion check on an iframe reports the wrong element
 * with total confidence, so the two are computed separately from the same node
 * and never converted into each other.
 */
import type { CdpLike } from "./webmcp-bridge";
import type { ActPoint } from "./browser-page";
import type { RefEntry } from "./a11y-refs";
import { readAxTree } from "./cdp-a11y";
import type { A11yNode } from "./observation-budget";

/**
 * A node id the caller can act on, and how we arrived at it.
 *
 * `recovered` is not decoration: the id in the ref map was minted against a
 * DOM that has since changed, and the model is entitled to know its target was
 * re-found by role and name rather than by identity — that is the difference
 * between "the button you meant" and "a button with the same label".
 */
export interface ResolvedRefNode {
  backendNodeId: number;
  recovered: boolean;
}

/**
 * The centre of a node's content box, in the top frame's viewport.
 *
 * Scrolls first, because the common case on a real page is a target below the
 * fold: a click at its unscrolled coordinates lands on whatever happens to be
 * at those pixels, which is the silent mis-click this whole file exists to
 * stop. Lifted from `electron-page.ts`'s `pointFor`, which had it right and
 * had it alone.
 */
export async function pointForBackendNodeId(
  cdp: CdpLike,
  backendNodeId: number,
  label: string,
): Promise<ActPoint> {
  await cdp
    .send("DOM.scrollIntoViewIfNeeded", { backendNodeId })
    .catch(() => {});
  const box = (await cdp
    .send("DOM.getBoxModel", { backendNodeId })
    .catch(() => undefined)) as { model?: { content?: number[] } } | undefined;
  const quad = box?.model?.content;
  if (!quad || quad.length < 8) {
    // A node that resolves but has no box is `display:none`, or zero-sized.
    // "There is nothing to click" is the truthful answer, and it is a
    // different answer from "that ref is stale" — the element is exactly
    // where the model left it, and still cannot be clicked.
    throw new Error(
      `target_not_found: ${label} is on the page but has no visible box to ` +
        "aim at (it may be hidden or collapsed); observe again and pick a " +
        "target that is showing",
    );
  }
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return {
    x: Math.round(xs.reduce((a, b) => a + b, 0) / 4),
    y: Math.round(ys.reduce((a, b) => a + b, 0) / 4),
  };
}

/**
 * Resolve a ref to a live node, recovering by role and name when its id died.
 *
 * The two failures are different and the model can act on the difference:
 *
 *   - The id still resolves ⇒ act, no note.
 *   - The id is gone but ONE node still carries that exact role and name at
 *     that ordinal ⇒ act, and say it was recovered. This is the ordinary React
 *     re-render: the button the model read is still on screen, wearing a new
 *     backend id. Refusing here would send it round a whole observe/act loop
 *     to arrive at the same element.
 *   - Neither ⇒ `stale_ref`, which the caller pairs with a fresh observation.
 *
 * The role and name are matched EXACTLY and case-sensitively. A looser match
 * is how "Save" finds "Save as…" and clicks the wrong menu item, and a wrong
 * click is worse than a refusal the model can recover from in one turn.
 */
export async function resolveRefNode(
  cdp: CdpLike,
  ref: string,
  entry: RefEntry,
  /**
   * Asked before the recovery re-reads the page.
   *
   * Reading a page is an observation, and the lease forbids observing as
   * firmly as it forbids acting — so a handoff landing inside the node lookup
   * must stop the tree read that would otherwise follow it. Throws, which the
   * driver classifies as the lease refusal.
   */
  guard: () => void = () => {},
): Promise<ResolvedRefNode> {
  const known = entry.backendDOMNodeId;
  if (known !== undefined && (await nodeResolves(cdp, known))) {
    return { backendNodeId: known, recovered: false };
  }
  guard();
  const recovered = await findByRoleAndName(cdp, entry);
  if (recovered !== undefined) {
    return { backendNodeId: recovered, recovered: true };
  }
  throw new Error(
    `stale_ref: ${ref} pointed at ${describeEntry(entry)}, which is no longer ` +
      "on this page; observe again and use a ref from the new tree",
  );
}

/** Does this backend node id still name something in the live DOM? */
async function nodeResolves(
  cdp: CdpLike,
  backendNodeId: number,
): Promise<boolean> {
  // ASKED, NOT PARSED — the same reasoning as `electron-page.ts`'s
  // `nodeIsGone`. Whether a node resolves is a question the protocol answers
  // directly, and matching CDP's failure prose is a regex that silently stops
  // matching on the next Chromium.
  return cdp.send("DOM.describeNode", { backendNodeId }).then(
    () => true,
    () => false,
  );
}

/**
 * The backend id of the `nth` node with this exact role and name, if any.
 *
 * `nth` is absent on a ref that was unique when it was minted (`assignRefs`
 * records it only to disambiguate), and absent means the first — which is the
 * same thing when there is only one.
 */
async function findByRoleAndName(
  cdp: CdpLike,
  entry: RefEntry,
): Promise<number | undefined> {
  const read = await readAxTree(cdp);
  if (!read.ok || !read.tree) return undefined;
  const wanted = entry.nth ?? 0;
  let seen = 0;
  let found: number | undefined;
  // ITERATIVE. A hostile or merely deep page must not be able to end the
  // daemon with a stack overflow on a walk it asked for.
  const stack: A11yNode[] = [read.tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node.role === entry.role &&
      (typeof node.name === "string" ? node.name : "") === entry.name &&
      typeof node.backendDOMNodeId === "number"
    ) {
      if (seen === wanted) {
        found = node.backendDOMNodeId;
        break;
      }
      seen += 1;
    }
    const children = node.children ?? [];
    // Pushed in reverse so `pop` yields document order, which is the order
    // `assignRefs` counted in — an ordinal against a different traversal is
    // an ordinal against a different element.
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
  return found;
}

function describeEntry(entry: RefEntry): string {
  const name = entry.name ? ` "${entry.name}"` : "";
  return `${entry.role}${name}`;
}

/** Put the caret in a node, so the next keystrokes land in it. */
export async function focusBackendNodeId(
  cdp: CdpLike,
  backendNodeId: number,
): Promise<void> {
  await cdp.send("DOM.focus", { backendNodeId });
}

/**
 * Replace a field's contents with `text`.
 *
 * REPLACE, because that is what `type` at a selector already means
 * (`fillSelector`), and a ref that appended instead would make the same verb
 * mean two things depending on how the model named its target.
 *
 * Focus, select everything, then insert: `Input.insertText` fires the input
 * events a page's own handlers listen for, which setting `.value` does not.
 */
export async function replaceTextInNode(
  cdp: CdpLike,
  backendNodeId: number,
  text: string,
  /** Asked immediately before the keystrokes land. See `resolveRefNode`. */
  guard: () => void = () => {},
): Promise<void> {
  await focusBackendNodeId(cdp, backendNodeId);
  const objectId = await resolveObjectId(cdp, backendNodeId);
  if (objectId) {
    await cdp
      .send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          if (typeof this.select === "function") { this.select(); return; }
          const doc = this.ownerDocument;
          const view = doc && doc.defaultView;
          if (!view || !doc.createRange) return;
          const range = doc.createRange();
          range.selectNodeContents(this);
          const selection = view.getSelection();
          if (!selection) return;
          selection.removeAllRanges();
          selection.addRange(range);
        }`,
      })
      .catch(() => {});
  }
  // THE LAST WORD BEFORE THE TEXT LANDS. Focusing and selecting are awaits,
  // and what is on the other side of them is an agent's keystrokes going into
  // a page somebody else now has their hands on.
  guard();
  // Insert even when the selection could not be cleared: typing into a field
  // that kept its old value is a visibly wrong result the model can see and
  // correct, and silently doing nothing is not.
  await cdp.send("Input.insertText", { text });
}

/**
 * Choose an option in a `<select>`, by value or by visible label.
 *
 * Both, because a model reading an accessibility tree sees the LABEL and has
 * no way to know the value attribute behind it — and a select that only took
 * values would be unusable from the one observation that names it.
 */
export async function selectOptionOnNode(
  cdp: CdpLike,
  backendNodeId: number,
  value: string,
  label: string,
): Promise<void> {
  const objectId = await resolveObjectId(cdp, backendNodeId);
  if (!objectId) {
    throw new Error(
      `target_not_found: ${label} could not be resolved to select an option`,
    );
  }
  const outcome = (await cdp.send("Runtime.callFunctionOn", {
    objectId,
    returnByValue: true,
    arguments: [{ value }],
    functionDeclaration: `function (wanted) {
      if (this.tagName !== "SELECT") return "not_select";
      const options = Array.from(this.options || []);
      const match =
        options.find((o) => o.value === wanted) ||
        options.find((o) => (o.label || o.textContent || "").trim() === wanted);
      if (!match) {
        return "no_option:" + options
          .slice(0, 12)
          .map((o) => (o.label || o.textContent || "").trim())
          .join(", ");
      }
      this.value = match.value;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return "ok";
    }`,
  })) as { result?: { value?: string } };
  const answer = outcome?.result?.value ?? "";
  if (answer === "ok") return;
  if (answer === "not_select") {
    throw new Error(
      `target_not_found: ${label} is not a <select>; use click or type instead`,
    );
  }
  // The page's OWN option labels, which is what makes this recoverable: a
  // model told only "no such option" guesses again, told the options it picks.
  const offered = answer.startsWith("no_option:") ? answer.slice(10) : "";
  throw new Error(
    `target_not_found: ${label} has no option matching "${value}"` +
      (offered ? `; it offers: ${offered}` : ""),
  );
}

/**
 * What is on top of this node at its own centre, if anything.
 *
 * Returns a short description of the covering element, or `null` when the node
 * would receive the click. This is the difference between a timeout the model
 * cannot diagnose and a sentence it can act on: a consent banner, a modal, a
 * sticky header. Chromium reports none of that — a click on a covered element
 * just goes somewhere else, and the observation afterwards looks like a click
 * that did nothing.
 *
 * RUNS IN THE ELEMENT'S OWN DOCUMENT, computing its own centre there (see the
 * two-coordinate-spaces note at the top). An overlay in a PARENT document
 * covering an iframe is therefore not detected — the check fails open, which
 * is the right direction: a missed detection costs the model the diagnosis it
 * would have had anyway, and a false one would refuse a click that works.
 */
export async function coveringElementAt(
  cdp: CdpLike,
  backendNodeId: number,
): Promise<string | null> {
  const objectId = await resolveObjectId(cdp, backendNodeId);
  // No object id means we could not ask. Not covered, as far as we know.
  if (!objectId) return null;
  const outcome = (await cdp
    .send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const el = this;
        const doc = el.ownerDocument;
        if (!doc || typeof doc.elementFromPoint !== "function") return null;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        let hit = doc.elementFromPoint(x, y);
        if (!hit) return null;
        // Shadow roots answer for their host, so descend to what a click
        // would really reach.
        let guard = 0;
        while (hit.shadowRoot && guard < 32) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === hit) break;
          hit = inner;
          guard += 1;
        }
        // Walk upward THROUGH shadow boundaries: a node inside a shadow root
        // has the root as its parent, and the root's host is the next element.
        const up = (n) => {
          const p = n.parentNode;
          if (!p) return null;
          return p.nodeType === 11 && p.host ? p.host : p;
        };
        const reaches = (from, to) => {
          let n = from;
          let steps = 0;
          while (n && steps < 256) {
            if (n === to) return true;
            n = up(n);
            steps += 1;
          }
          return false;
        };
        // The element itself, anything inside it, or anything it sits inside:
        // in all three the click reaches the node the model named.
        if (hit === el || reaches(hit, el) || reaches(el, hit)) return null;
        // A label drives its own control, so a click on it is a click on this.
        try {
          if (hit.control === el || (hit.tagName === "LABEL" && reaches(el, hit))) return null;
          const labels = el.labels ? Array.from(el.labels) : [];
          if (labels.some((l) => l === hit || reaches(hit, l))) return null;
        } catch (_) {}
        const describe = (n) => {
          if (!n || !n.tagName) return "another element";
          const tag = n.tagName.toLowerCase();
          if (n.id) return tag + "#" + n.id;
          const cls = (n.className && typeof n.className === "string" ? n.className : "")
            .trim().split(/\\s+/).filter(Boolean).slice(0, 2);
          return cls.length ? tag + "." + cls.join(".") : tag;
        };
        let named = describe(hit);
        // The nearest identified ancestor, which is usually what a person
        // would call the thing ("inside div#cookie-banner").
        let owner = up(hit);
        let steps = 0;
        while (owner && steps < 32) {
          if (owner.id) { named += " inside " + describe(owner); break; }
          owner = up(owner);
          steps += 1;
        }
        return named.slice(0, 120);
      }`,
    })
    .catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
  const value = outcome?.result?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A remote object handle for a backend node, or `undefined` if it is gone. */
async function resolveObjectId(
  cdp: CdpLike,
  backendNodeId: number,
): Promise<string | undefined> {
  const resolved = (await cdp
    .send("DOM.resolveNode", { backendNodeId })
    .catch(() => undefined)) as
    | { object?: { objectId?: string } }
    | undefined;
  return resolved?.object?.objectId;
}
