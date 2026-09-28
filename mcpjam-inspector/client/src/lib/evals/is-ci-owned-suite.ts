/**
 * WHERE A SUITE'S CONFIGURATION LIVES — the client mirror of the backend's
 * `isCiOwnedSuite`.
 *
 * ============================================================================
 * TWO WAYS TO BE CI-OWNED, AND THEY ARE DIFFERENT FACTS
 * ============================================================================
 *
 *   * `declaredSuiteId` — an author committed `suite.id` in a versioned suite
 *     file, and `mcpjam eval run --file` syncs that file into this row. The
 *     sync HARD-DELETES any case the file does not name, so a case added from
 *     the Evaluate tab survived until the next CI run and then vanished with
 *     nothing recording why.
 *   * `source: 'sdk'` — the row was created by SDK ingest reporting a run it
 *     had already executed. Its cases are synthesized from the report, so
 *     editing them here changes nothing about what CI runs.
 *
 * DELIBERATELY NOT `lastSdkRunAt`. That says CI has *reported into* this suite,
 * which happens to UI-authored suites all the time; locking one because CI
 * touched it once would take a working surface away from the person who built
 * it. Ownership is where the configuration lives, not who last wrote a result.
 *
 * ============================================================================
 * DESCRIPTIVE, NEVER AUTHORITATIVE
 * ============================================================================
 *
 * The backend refuses these writes itself, in the suite authorizers that every
 * write path funnels through. This predicate exists so the UI can disable a
 * control WITH A REASON instead of letting someone fill in a form and meet a
 * refusal at save. A client that raced a change still gets a clean refusal from
 * the mutation.
 *
 * It is also the reason `getSuiteCapabilities.ownership` is not the only
 * source: that query is newer than the lock's clients, so a client talking to a
 * backend that predates it still has to answer from the suite row it already
 * holds.
 */
export type CiOwnedSuiteInput = {
  declaredSuiteId?: string | null;
  source?: string | null;
};

export function isCiOwnedSuite(
  suite: CiOwnedSuiteInput | null | undefined,
): boolean {
  if (!suite) return false;
  const declared = suite.declaredSuiteId;
  return (
    (typeof declared === "string" && declared.length > 0) ||
    suite.source === "sdk"
  );
}

/**
 * The one sentence shown wherever a CI-owned suite refuses an edit.
 *
 * It names BOTH ways forward, because a user who reads only "no" has no next
 * move — and the two are genuinely different: editing the file keeps the
 * suite's history and its CI wiring, duplicating gives up both for an editable
 * copy. Kept beside the predicate so the reason and the rule cannot drift.
 */
export const CI_OWNED_REASON_COPY =
  "Managed by CI — edit the test file, or duplicate to edit here";
