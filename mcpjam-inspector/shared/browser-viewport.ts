/**
 * The session viewport: how big the agent's page is, and who decides.
 *
 * Until now the answer was a constant. `BROWSER_AGENT_VIEWPORT` fixed 1024×768
 * and four independent places restated it — the Playwright context, the
 * daemon's bounds check, the tool schema handed to the model, and the X screen
 * a hosted box draws on. A constant is the right shape for an EVAL, where a
 * replay artifact is only comparable against a run at the same size, and the
 * wrong shape for a person who has just dragged the browser panel wider: the
 * page they are looking at is 1600 wide and every coordinate the model reasons
 * about is still clipped at 1023.
 *
 * So the size becomes session state, and this module is the vocabulary for it.
 * Three ideas, and each exists because collapsing it into another one lost
 * something:
 *
 *   1. A POLICY, chosen when the session opens. `followPane` sessions resize
 *      with the panel; `fixed` sessions never do. It is chosen at the door
 *      rather than inferred per resize because "may this session change size"
 *      is a property of what opened it — an interactive Playground chat, or an
 *      unattended eval — and not of whoever happens to be watching.
 *   2. A REVISION, bumped on every accepted change. The DOM hash cannot stand
 *      in for it: a CSS breakpoint crossing at 900px reflows a page from three
 *      columns to one with the identical tag skeleton, so a click decided from
 *      the wide screenshot passes the staleness check and lands on whatever
 *      moved into that rectangle.
 *   3. A NEGOTIATION, before a caller is attached. A client written against
 *      the old contract reads coordinates out of a screenshot it assumes is
 *      1024 wide. Letting it join a session that resizes underneath it is
 *      worse than refusing it, because the failure is a click landing in the
 *      wrong place rather than an error anybody can see.
 *
 * Pure data and pure functions — no I/O, no daemon imports — because `shared/`
 * is what leaves this repository and every layer from the Electron main
 * process to the hosted encoder has to agree on these numbers.
 */

/**
 * Who decides this session's size.
 *
 * `fixed` is the default everywhere it is not explicitly asked for. An
 * existing caller — an eval, a swarm, a CLI run, an SDK consumer pinned to
 * contract v1 — gets exactly the session it got before this module existed,
 * and the one that opts in is the one that asked.
 */
export type SessionViewportPolicy = "followPane" | "fixed";

/**
 * The size a `fixed` session runs at, and what every session starts at.
 *
 * The same 1024×768 the contract has always published. It stays a constant
 * because a `fixed` session's whole promise is that it is one — an eval
 * recorded last month and one recorded today have to be comparable frame for
 * frame, and a default that drifted with a UI change would silently
 * invalidate a corpus.
 */
export const DEFAULT_SESSION_VIEWPORT = { width: 1024, height: 768 } as const;

/**
 * The bounds a session may be resized within.
 *
 * The floor is not cosmetic. Below roughly 400 CSS pixels a responsive site
 * switches to its mobile layout, which is a legitimate thing to test but not
 * something a person should fall into by dragging a divider — and Chromium
 * refuses some viewport sizes outright. The ceiling is a cost limit: the
 * hosted encoder's work is linear in pixels on a two-core box, and a person
 * with a 6K display who expands the panel would otherwise ask it to encode
 * five times the area it was measured at.
 */
export const MIN_SESSION_VIEWPORT = { width: 400, height: 300 } as const;
export const MAX_SESSION_VIEWPORT = { width: 2560, height: 1600 } as const;

/** A size, plus the revision that names this particular one. */
export interface SessionViewport {
  width: number;
  height: number;
  /**
   * Bumped on every ACCEPTED change, never on a request.
   *
   * Monotonic within a session and meaningless across sessions. An observation
   * carries the revision it was taken at and an act may carry the revision it
   * was decided from; the daemon refuses the act when they differ, which is
   * the layout-change half of staleness that the DOM hash cannot see.
   *
   * Starts at 0 — the size the session launched at — so a session that never
   * resizes has one revision for its whole life and nothing to compare.
   */
  revision: number;
}

/** The viewport a session begins at, before anything has resized it. */
export const INITIAL_SESSION_VIEWPORT: SessionViewport = {
  width: DEFAULT_SESSION_VIEWPORT.width,
  height: DEFAULT_SESSION_VIEWPORT.height,
  revision: 0,
};

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Bring a requested size inside the bounds, and make it an integer.
 *
 * CLAMPED rather than refused, deliberately, and this is the one place in the
 * viewport path that does not refuse bad input. The caller is a resize
 * observer on a panel somebody is dragging: it reports a fractional width
 * because CSS layout is fractional, and it reports 40px for one frame while a
 * collapse animation runs. Refusing those would make the pane show an error
 * because a person dragged a divider, and there is no correction they could
 * make. A coordinate is different — nobody drags a click — and
 * `isPointInSessionViewport` below refuses.
 *
 * NaN and infinity land on the floor rather than propagating: a measurement
 * from a detached element is a missing measurement, and the smallest legal
 * size is the safest thing to show while one arrives.
 */
export function normalizeViewportSize(size: Partial<ViewportSize>): ViewportSize {
  return {
    width: clampDimension(
      size.width,
      MIN_SESSION_VIEWPORT.width,
      MAX_SESSION_VIEWPORT.width,
    ),
    height: clampDimension(
      size.height,
      MIN_SESSION_VIEWPORT.height,
      MAX_SESSION_VIEWPORT.height,
    ),
  };
}

function clampDimension(value: unknown, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

/**
 * The next viewport after a resize request, or the SAME OBJECT if nothing moved.
 *
 * Identity is the signal, and callers depend on it: the revision must not bump
 * for a request that changed no pixel. A resize observer fires on every scroll
 * of an ancestor and on every re-render, so a version that bumped
 * unconditionally would invalidate every outstanding observation token several
 * times a second, and the model would spend a session re-observing a page
 * nobody resized.
 *
 * A `fixed` session returns its current viewport for every request. The refusal
 * is silent here on purpose — the caller is a panel measurement, not a command
 * — and the endpoints that a person or a script can reach refuse loudly.
 */
export function advanceViewport(
  current: SessionViewport,
  requested: Partial<ViewportSize>,
  policy: SessionViewportPolicy,
): SessionViewport {
  if (policy === "fixed") return current;
  const next = normalizeViewportSize(requested);
  if (next.width === current.width && next.height === current.height) {
    return current;
  }
  return { width: next.width, height: next.height, revision: current.revision + 1 };
}

/**
 * Is a coordinate inside this session's page?
 *
 * The session's own numbers, never the constant. This replaces the fixed
 * `isPointInViewport` for every path that has a session to ask; the constant
 * version remains correct only for a `fixed` session, which is exactly the
 * case where the two agree.
 *
 * REFUSES, never clamps, for the reason the original did: Chromium delivers a
 * mouse event outside the viewport happily, it lands on nothing, and the
 * caller gets back an ordinary "here is the page after your action" — a no-op
 * indistinguishable from a click that hit a dead area.
 */
export function isPointInSessionViewport(
  x: number,
  y: number,
  viewport: ViewportSize,
): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= viewport.width - 1 &&
    y <= viewport.height - 1
  );
}

/**
 * What a caller says it can cope with when it attaches.
 *
 * Absent means NO, and that asymmetry is the whole point: every client written
 * before this module omits the field, and every one of them assumes 1024×768.
 * Reading an absent field as "probably fine" would attach exactly the callers
 * that cannot cope.
 */
export interface ViewportCapability {
  /**
   * This caller reads the viewport from each observation rather than assuming
   * one, and re-reads it when the revision changes.
   */
  responsiveViewport?: boolean;
}

export type ViewportNegotiation =
  | { ok: true; policy: SessionViewportPolicy }
  /**
   * The caller cannot join. `reason` is a code rather than prose because it
   * crosses a wire; the surfaces that show it own the sentence.
   */
  | { ok: false; reason: "responsive_viewport_required" };

/**
 * May this caller attach to a session under this policy?
 *
 * The refusal only ever runs one way. A responsive caller joining a `fixed`
 * session is fine — it reads the viewport from the observation, finds the same
 * numbers every time, and never notices. A fixed-coordinate caller joining a
 * `followPane` session is the failure this exists to prevent, and it is not
 * one the caller can detect: it would read coordinates from a screenshot it
 * assumes is 1024 wide, aim at the right pixel of the wrong picture, and
 * report success.
 */
export function negotiateViewport(
  policy: SessionViewportPolicy,
  capability: ViewportCapability | undefined,
): ViewportNegotiation {
  if (policy === "fixed") return { ok: true, policy };
  if (capability?.responsiveViewport === true) return { ok: true, policy };
  return { ok: false, reason: "responsive_viewport_required" };
}

/**
 * Read a policy off the wire, defaulting to `fixed`.
 *
 * An unknown string is `fixed` too, not an error. This parses a field that
 * older callers do not send at all, and the two indistinguishable cases —
 * absent and misspelt — must land on the conservative side, which is the
 * session that never changes size.
 */
export function parseViewportPolicy(value: unknown): SessionViewportPolicy {
  return value === "followPane" ? "followPane" : "fixed";
}

/**
 * Do these two viewports describe the same picture?
 *
 * The REVISION is part of the comparison, not just the pixels. A session that
 * went 1024 → 1400 → 1024 is back at its original size with a page that
 * reflowed twice, and an observation taken before the round trip is stale
 * even though the numbers match.
 */
export function sameViewport(a: SessionViewport, b: SessionViewport): boolean {
  return (
    a.width === b.width && a.height === b.height && a.revision === b.revision
  );
}
