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
   * Which write is the LATEST one started.
   *
   * The org id alone is not enough, because two writes for the SAME org
   * overlap all the time — a Switch toggled while a save is in flight, Enter
   * pressed twice. Comparing only the org, whichever finished FIRST would
   * clear `isSaving` out from under the one still running, and its failure
   * would overwrite the newer write's error. Only the newest generation may
   * report.
   */
  const generationRef = useRef(0);

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
      generationRef.current += 1;
      const generation = generationRef.current;
      const isCurrent = () =>
        currentOrgRef.current === startedFor &&
        generationRef.current === generation;

      setError(null);
      setIsSaving(true);
      try {
        await work();
      } catch (nextError) {
        if (isCurrent()) setError(messageOf(nextError));
        throw nextError;
      } finally {
        if (isCurrent()) setIsSaving(false);
      }
    },
    [organizationId],
  );

  return { error, isSaving, run };
}
