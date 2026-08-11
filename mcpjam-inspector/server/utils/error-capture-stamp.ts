/**
 * The capture-dedupe stamp, and nothing else.
 *
 * Split out from `error-origin-capture.ts` for one reason: `logger.ts` owns
 * every `Sentry.captureException` in the server (AGENTS.md), so the origin
 * policy has to call INTO the logger — while the logger has to read the stamp
 * to know an error was already ruled on. Those two needs point at each other,
 * and a module that only holds the stamp breaks the cycle without duplicating
 * the walk in both places.
 */

/**
 * A single failure commonly passes two capture points: a route logs it
 * (`logger.error`) and then serializes it into an envelope (`jsonError`), both
 * holding the same object. Symbol-keyed and non-enumerable so it never reaches
 * a JSON body, a log payload, or a structured clone.
 */
const CAPTURE_STAMP = Symbol.for("mcpjam.errorOriginCaptureHandled");

type Stampable = Record<PropertyKey, unknown>;

function isStampable(value: unknown): value is Stampable {
  return typeof value === "object" && value !== null;
}

/**
 * Mark a value as "capture already decided". Non-enumerable and
 * non-writable-by-accident; a frozen or exotic object silently declines the
 * stamp rather than throwing — stamping is an optimization, and failing to
 * stamp can only cost a duplicate event, never correctness.
 */
export function markOriginCaptureHandled(value: unknown): void {
  if (!isStampable(value)) return;
  try {
    Object.defineProperty(value, CAPTURE_STAMP, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen/sealed/proxy-trapped target. Nothing to do.
  }
}

/**
 * Return a value the stamp can actually attach to.
 *
 * `throw "failure"` and `Promise.reject(null)` are legal, and a primitive
 * cannot carry a symbol property. Without this, the capture decision for such
 * a throw would be invisible to every later reader: a declined user-fault
 * primitive would still be captured by `logger.error` (the noise this exists
 * to remove), and an escalated MCPJam-fault one would be captured twice.
 *
 * Deliberately NOT solved with a set of "recently handled values": primitives
 * are compared by value, so two unrelated failures that both threw
 * `"failure"` would dedupe against each other and the second would vanish.
 *
 * The wrapper preserves `String(value)` as its message, so classification and
 * the Axiom row read identically to the raw throw. Objects are returned
 * unchanged — identity matters for the `.cause` walk.
 */
export function ensureStampable(value: unknown): unknown {
  if (!isStampable(value)) return new Error(String(value));
  // A frozen or sealed error is an OBJECT, so it passes the type guard, but
  // `defineProperty` still cannot attach the stamp to it — same invisible
  // decision, same double-or-missed capture. Wrap it too, keeping the original
  // reachable as `cause` so the chain walk still finds everything.
  if (!Object.isExtensible(value)) {
    const wrapped = new Error(
      value instanceof Error ? value.message : String(value),
    );
    Object.defineProperty(wrapped, "cause", {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return wrapped;
  }
  return value;
}

/** How far to walk a `.cause` chain before giving up. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when this error (or anything in its cause chain, or its memoized
 * `normalized` block) has already been through a capture decision.
 *
 * The cause walk matters because `mapRuntimeError` constructs a *fresh*
 * `WebRouteError` for a non-`WebRouteError` input: the stamp lives on the
 * original, and only the `cause` link that mapper also sets makes it
 * reachable. The `normalized` check covers the mirror case — a `WebRouteError`
 * carries the same `NormalizedError` object across repeated `mapRuntimeError`
 * calls, so stamping the block dedupes even when the error identity changed.
 */
export function isOriginCaptureHandled(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isStampable(current) || seen.has(current)) return false;
    seen.add(current);
    if (current[CAPTURE_STAMP] === true) return true;
    const normalized = current.normalized;
    if (isStampable(normalized) && normalized[CAPTURE_STAMP] === true) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
