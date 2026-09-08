import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * The failure message an admin can act on, out of a Convex error.
 *
 * THE STRUCTURED PAYLOAD WINS. A `ConvexError` thrown with a payload carries
 * it on `.data`, and in production that is the only place the real sentence
 * survives: Convex redacts an ordinary thrown Error's message to "Server
 * Error" before it reaches the client, so reading `.message` first would show
 * every deliberate refusal ("Resume and enable the destination before
 * backfilling") as a generic failure.
 *
 * Otherwise the message is the server stack, whose LAST line is the sentence
 * the server wrote. Bracketed prefixes go too — an operation name and a
 * request id mean nothing to a reader, and Convex can put both on that one
 * line, so they are stripped repeatedly rather than once.
 */
export function messageOf(error: unknown): string {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (error instanceof Error && error.message) {
    const lines = error.message.split("\n").filter(Boolean);
    const last = lines[lines.length - 1] ?? error.message;
    let stripped = last;
    let previous: string;
    do {
      previous = stripped;
      stripped = stripped.replace(/^\[[^\]]*\]\s*/, "");
    } while (stripped !== previous);
    return stripped.trim() || error.message;
  }
  return String(error);
}

/**
 * A write that belongs to ONE org, and knows it.
 *
 * Every org-settings hook needs the same three things, and getting any of them
 * subtly wrong shows up only when an admin switches orgs mid-write:
 *
 *   - The error and saving flags reset when the org changes, so a failure does
 *     not follow the admin to a page where nothing failed.
 *   - A completion that lands after a switch reports to nobody, rather than
 *     putting "That channel is already bound" on a page about a different org.
 *   - The error is surfaced, never swallowed: the conflict message IS the
 *     product here — it is what tells an admin why their write did not take.
 *
 * Kept in one place because copies of stale-write logic diverge, and the
 * divergence would be invisible until someone hit exactly this race. It was
 * three copies (`useOrgSlackSettings`, `useOrgSharePolicy`,
 * `useOrgTraceDestinations`) before this module existed.
 */
export function useOrgScopedWrite(organizationId: string | null): {
  error: string | null;
  isSaving: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
} {
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /** The org currently on screen, for a write to compare itself against. */
  const currentOrgRef = useRef(organizationId);

  /**
   * Which write is the LATEST one started, for ERROR attribution.
   *
   * Two writes for the same org overlap all the time — a Switch toggled while
   * a save runs, Enter pressed twice — and the org id alone cannot separate
   * them. Only the newest may set `error`, so a stale failure cannot overwrite
   * a fresher answer.
   */
  const generationRef = useRef(0);

  /**
   * How many writes for the current org are still running, for `isSaving`.
   *
   * SEPARATE FROM THE GENERATION, because the two questions want different
   * answers when writes overlap. Newest-wins is right for the error — a stale
   * failure should not overwrite a fresher answer. It is wrong for the
   * spinner: if the NEWER write finishes first it is the current generation,
   * so it cleared `isSaving` out from under the older one still running, which
   * is the exact defect the generation was introduced to prevent. It only
   * looked fixed because the ordering that exposes it is the less obvious one.
   *
   * A count is true in both orderings: the spinner stops when the last write
   * stops. A switch away zeroes it, which is what retires the previous org's
   * writes.
   */
  const inFlightRef = useRef(0);

  /**
   * Which VISIT to an organization this is.
   *
   * The id cannot stand in for it. Switching `A → B → A` returns to the same
   * id, so a write left over from the first visit to A satisfied an
   * id-equality check on the second — and decremented a counter that had been
   * zeroed in between, stopping the spinner while the second visit's own write
   * was still in flight. A monotonic token separates the two visits, which an
   * id by construction cannot.
   */
  const visitRef = useRef(0);

  // LAYOUT, not passive. A passive effect runs after the browser paints, and a
  // write for the previous org can settle in the window between the commit for
  // the new one and that flush — reading a `currentOrgRef` that still says the
  // OLD org, and so reporting its result onto the new org's page. Running
  // before paint closes the window. Nothing here measures the DOM, so the
  // synchronous slot costs nothing.
  useLayoutEffect(() => {
    currentOrgRef.current = organizationId;
    // Retire every write in flight: a completion from the previous org must
    // not land on this one, whatever order the round trips finish in.
    generationRef.current += 1;
    // A NEW VISIT, even to an org just left. `A → B → A` reuses the id, so
    // comparing ids alone let the first visit's write decrement the second
    // visit's counter — clearing `isSaving` while the second visit's own
    // write was still in flight, and re-enabling Save under it.
    visitRef.current += 1;
    inFlightRef.current = 0;
    setError(null);
    setIsSaving(false);
  }, [organizationId]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      // A mutation is a round trip, and the org picker is one click away. The
      // org AND the generation it started under are captured here, so a
      // completion arriving after a switch — or after a newer write of its
      // own — reports to nobody rather than to the wrong page or over a
      // fresher answer.
      const startedFor = organizationId;
      const visit = visitRef.current;
      generationRef.current += 1;
      const generation = generationRef.current;
      // THE VISIT, not the id. Both have to match: the id alone cannot tell
      // this visit to org A from the last one.
      const isSameVisit = () =>
        currentOrgRef.current === startedFor && visitRef.current === visit;
      const isNewest = () =>
        isSameVisit() && generationRef.current === generation;

      inFlightRef.current += 1;
      setError(null);
      setIsSaving(true);
      try {
        await work();
      } catch (nextError) {
        if (isNewest()) setError(messageOf(nextError));
        throw nextError;
      } finally {
        // The visit, not the generation: an older write of THIS visit still
        // has to decrement the count it incremented, or the spinner never
        // stops. A write from a previous visit decrements nothing — its
        // counter was reset when the visit ended.
        if (isSameVisit()) {
          inFlightRef.current -= 1;
          if (inFlightRef.current <= 0) {
            inFlightRef.current = 0;
            setIsSaving(false);
          }
        }
      }
    },
    [organizationId],
  );

  return { error, isSaving, run };
}
