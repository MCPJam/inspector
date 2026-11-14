/**
 * The v1 API's side of the CI-owned suite lock (PLB-238): which suites the
 * platform treats as read-only, the file-sync marker that is the exception,
 * and the up-front refusal. The 409 itself is built in `convex-errors.ts`,
 * which the Convex error translator shares.
 */

import { z } from "zod";
import { ciOwnedSuiteReadOnlyError } from "./convex-errors.js";

/** The two suite fields the lock reads; any suite document has them. */
type SuiteOwnership = { declaredSuiteId?: unknown; source?: unknown };

/**
 * Whether the platform will refuse configuration writes to this suite.
 *
 * MIRRORS the backend's `isCiOwnedSuite`, deliberately and with the same two
 * clauses — a committed suite file's `declaredSuiteId`, or `source: 'sdk'` from
 * ingest. Convex stays the guard. This copy lets the DTO say so before the
 * caller finds out from a 409, and lets the write routes refuse up front what
 * Convex would refuse anyway (`assertSuiteWritableViaApi`, which also names
 * the ceiling of a mirrored predicate).
 *
 * NOT `lastSdkRunAt`. CI reporting a result into a UI-authored suite does not
 * make that suite CI-owned, and saying otherwise here would advertise a lock
 * the platform does not apply.
 */
export function isCiOwnedSuiteDoc(suite: SuiteOwnership): boolean {
  const declared = suite.declaredSuiteId;
  return (
    (typeof declared === "string" && declared.length > 0) ||
    suite.source === "sdk"
  );
}

/**
 * The suite-file sync marker, on every write route a `mcpjam cloud eval run
 * --file` sync makes.
 *
 * A CI-owned suite (one with a `declaredSuiteId`, or created by SDK ingest) is
 * read-only from the app AND from this API — the platform refuses the write.
 * The file's own sync is the exception, and this is how it says so: by naming
 * the declared id, which only something holding the file can know. The platform
 * allows the write iff the id is the suite's own.
 *
 * NOT A CAPABILITY. Naming an id you do not own gets you nothing: the guard is
 * Convex's, and the route-level pre-check (`assertSuiteWritableViaApi`) only
 * ever stands aside for a marker, never vouches for one.
 *
 * ============================================================================
 * IT RIDES THE QUERY STRING, NOT THE BODY
 * ============================================================================
 *
 * Every body on these routes is `.strict()`, here and on every Inspector that
 * predates this change. A strict object REFUSES an unknown key, so a body field
 * is a 400 against an older deployment — the same reason the launcher rides a
 * header rather than the run-launch body.
 *
 * That matters far more here than it does for the launcher. A dropped launcher
 * costs a badge; a rejected `--file` sync costs the CLI's whole CI command,
 * against any self-hosted Inspector the user has not upgraded in lockstep with
 * their `@mcpjam/cli`. And the CLI sends this on EVERY file-sync write, so the
 * break would not be occasional. A query parameter is read by the deployments
 * that know it and ignored by the ones that do not, which is exactly the
 * degradation this needs: an Inspector with no lock has nothing to make an
 * exception to.
 *
 * The body shape below is kept so this server accepts either spelling. Nothing
 * has shipped sending the body form, but a route that refuses a marker it
 * understands would be its own compatibility break.
 */
export const fileSyncBodyShape = {
  declaredSuiteId: z.string().min(1).max(128).optional(),
} as const;

/**
 * The `fileSync` mutation argument, or nothing.
 *
 * Nothing, rather than `fileSync: undefined`: a platform deployment that
 * predates the CI-owned lock does not know this argument and rejects the whole
 * call for an unknown field, so sending it unconditionally would break every
 * suite edit against an older backend.
 */
export function fileSyncArg(declaredSuiteId: string | undefined | null): {
  fileSync?: { declaredSuiteId: string };
} {
  const trimmed =
    typeof declaredSuiteId === "string" ? declaredSuiteId.trim() : "";
  return trimmed.length > 0 ? { fileSync: { declaredSuiteId: trimmed } } : {};
}

/**
 * The marker a request carries: the query's `declaredSuiteId`, else the
 * body's, trimmed, or nothing. A blank query value (`?declaredSuiteId=`) does
 * not hide a marker in the body. Read it once per route and pass the result to
 * the guard and to every `fileSyncArg` call, so they cannot disagree.
 */
export function declaredSuiteIdOf(
  c: { req: { query(name: string): string | undefined } },
  body?: { declaredSuiteId?: string },
): string | undefined {
  return (
    c.req.query("declaredSuiteId")?.trim() ||
    body?.declaredSuiteId?.trim() ||
    undefined
  );
}

/**
 * Refuse a configuration write to a CI-owned suite BEFORE the mutation.
 *
 * The backend's `assertCiOwnedSuiteWritable` stays the guard and refuses the
 * same write if this is ever skipped; what this changes is WHERE the refusal
 * is produced. Thrown inside Convex it is an uncaught error, so one API caller
 * editing a CI-owned suite in a loop reopened Sentry CONVEX-2AT with refusals
 * that were working as designed, and buried the alert that issue exists for —
 * a regression like mcpjam-backend#1776 (PLB-238). Refused here, the caller
 * gets the identical 409 and Sentry sees nothing.
 *
 * STANDS ASIDE for a file-sync marker: that is `mcpjam cloud eval run --file`
 * writing as the file, and whether the id it names is the suite's own is the
 * backend's call — a mismatch is worth the event.
 *
 * The ceiling of a mirrored predicate: if the backend ever relaxes what counts
 * as CI-owned, this refuses a write the platform would accept until
 * `isCiOwnedSuiteDoc` is updated to match. It cannot err the other way — a
 * suite this copy calls writable still meets the lock in Convex.
 *
 * It also refuses a PATCH that would write nothing (say, only
 * `expectedRevisionNumber`): the one request on a CI-owned suite that the
 * platform answered 200 before this check and now gets 409.
 */
export function assertSuiteWritableViaApi(
  suite: SuiteOwnership,
  declaredSuiteId?: string | null,
): void {
  if (fileSyncArg(declaredSuiteId).fileSync) return;
  if (isCiOwnedSuiteDoc(suite)) throw ciOwnedSuiteReadOnlyError();
}
