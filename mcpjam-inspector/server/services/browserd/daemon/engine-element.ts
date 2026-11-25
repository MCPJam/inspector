/**
 * One element, found the way an act's selector is found: by Playwright's own
 * selector engine, which reads CSS and also `role=`, `text=`, `>>` chains and
 * `nth=`.
 *
 * Observations reach an element over CDP, whose `DOM.querySelector` reads CSS
 * only, so a selector in that syntax used to match nothing there. These are
 * the Playwright page adapter's answers for it (`chromium-launch.ts` wires
 * them in); they take the page's locator rather than importing Playwright.
 */
import { randomUUID } from "node:crypto";
import { resolveBackendNodeId } from "./cdp-a11y";
import type { CdpLike } from "./webmcp-bridge";

/** The little of a Playwright `Locator` these need. Structural, like `AnyPage`. */
export type AnyLocator = {
  first(): AnyLocator;
  count(): Promise<number>;
  innerText(options?: { timeout?: number }): Promise<string>;
  elementHandle(options?: { timeout?: number }): Promise<AnyElementHandle>;
};

/** The little of a Playwright `ElementHandle` the mark needs. */
export type AnyElementHandle = {
  evaluate<R, A>(
    fn: (element: MarkableElement, arg: A) => R,
    arg: A,
  ): Promise<R>;
  dispose(): Promise<void>;
};

/** A DOM element, as far as the mark touches one. */
type MarkableElement = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/** The local engine's own read timeout, so both answer alike. */
const READ_TIMEOUT_MS = 2_000;
/** The element went away, or its page navigated, between finding and reading it. */
const VANISHED =
  /TimeoutError|Execution context was destroyed|frame was detached/;
/** Carried only while CDP looks the element up by it. */
const MARK = "data-mcpjam-element";

function vanished(error: unknown): boolean {
  return (
    error instanceof Error && VANISHED.test(`${error.name} ${error.message}`)
  );
}

/**
 * The first match's `innerText`, read as the local engine reads it; `null`
 * when nothing matches.
 */
export async function elementText(
  locator: (selector: string) => AnyLocator,
  selector: string,
): Promise<string | null> {
  const first = locator(selector).first();
  if ((await first.count()) === 0) return null;
  try {
    return await first.innerText({ timeout: READ_TIMEOUT_MS });
  } catch (error) {
    if (vanished(error)) return null;
    throw error;
  }
}

/**
 * The first match's backend node id, through the same CDP lookup a CSS
 * selector gets: the element carries a one-off attribute while CDP finds it
 * by that, and loses it again straight after. `null` when nothing matches.
 */
export async function elementNodeId(
  locator: (selector: string) => AnyLocator,
  cdp: CdpLike,
  selector: string,
): Promise<number | null> {
  const first = locator(selector).first();
  if ((await first.count()) === 0) return null;
  let handle: AnyElementHandle;
  try {
    handle = await first.elementHandle({ timeout: READ_TIMEOUT_MS });
  } catch (error) {
    if (vanished(error)) return null;
    throw error;
  }
  const token = randomUUID();
  try {
    await handle.evaluate(
      (element, [name, value]) => element.setAttribute(name, value),
      [MARK, token] as const,
    );
    const marked = `[${MARK}="${token}"]`;
    return (
      (await resolveBackendNodeId(cdp, marked)) ??
      (await markedInShadowRoot(cdp, marked))
    );
  } finally {
    await unmark(handle);
  }
}

/**
 * Finds `selector` through every open shadow root, from the page itself. A
 * plain string, so bundling can't rename what runs in the page.
 */
const FIND_THROUGH_SHADOW_ROOTS = `(selector) => {
  const walk = (root) => {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    for (const host of root.querySelectorAll("*")) {
      const inner = host.shadowRoot ? walk(host.shadowRoot) : null;
      if (inner) return inner;
    }
    return null;
  };
  return walk(document);
}`;

/**
 * The marked element's backend node id when it sits in an open shadow root:
 * Playwright's engines reach it there and CDP's `DOM.querySelector` doesn't.
 */
async function markedInShadowRoot(
  cdp: CdpLike,
  selector: string,
): Promise<number | null> {
  try {
    const found = (await cdp.send("Runtime.evaluate", {
      expression: `(${FIND_THROUGH_SHADOW_ROOTS})(${JSON.stringify(selector)})`,
    })) as { result?: { objectId?: string } };
    const objectId = found?.result?.objectId;
    if (!objectId) return null;
    try {
      const described = (await cdp.send("DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      return described?.node?.backendNodeId ?? null;
    } finally {
      try {
        await cdp.send("Runtime.releaseObject", { objectId });
      } catch {
        // A page that navigated has let the object go already.
      }
    }
  } catch {
    return null;
  }
}

/** Takes the mark off again and lets the handle go. */
async function unmark(handle: AnyElementHandle): Promise<void> {
  try {
    await handle.evaluate(
      (element, name) => element.removeAttribute(name),
      MARK,
    );
  } catch (error) {
    // A page that navigated took the element, and its mark, with it.
    if (!vanished(error)) throw error;
  } finally {
    await handle.dispose();
  }
}
