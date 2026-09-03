import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The failure message an admin can act on, out of a Convex error.
 *
 * Convex prefixes a thrown error with the server stack, so the last line is
 * the sentence the server actually wrote ("That channel is already bound…").
 * The bracketed request-id prefix goes too — it means nothing to a reader.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) {
    const lines = error.message.split("\n").filter(Boolean);
    const last = lines[lines.length - 1] ?? error.message;
    return last.replace(/^\[.*?\]\s*/, "").trim() || error.message;
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

  useEffect(() => {
    currentOrgRef.current = organizationId;
    setError(null);
    setIsSaving(false);
  }, [organizationId]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      // A mutation is a round trip, and the org picker is one click away. The
      // org it started under is captured here so a completion that arrives
      // after a switch reports to nobody instead of to the wrong page.
      const startedFor = organizationId;
      setError(null);
      setIsSaving(true);
      try {
        await work();
      } catch (nextError) {
        if (currentOrgRef.current === startedFor) {
          setError(messageOf(nextError));
        }
        throw nextError;
      } finally {
        if (currentOrgRef.current === startedFor) setIsSaving(false);
      }
    },
    [organizationId],
  );

  return { error, isSaving, run };
}
