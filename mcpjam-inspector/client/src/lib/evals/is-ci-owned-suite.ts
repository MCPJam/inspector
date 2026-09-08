/**
 * Is this suite configured OUTSIDE the app?
 *
 * A suite created by a suite file or by SDK ingest has its shape in a
 * repository, and the CLI's as-code sync hard-deletes any case the file does
 * not declare on the next `eval run --file`. So an edit made in the Evaluate
 * tab is not "an edit CI might overwrite" — it is an edit that WILL be deleted,
 * silently, at a time nobody is watching. A control that quietly loses your
 * work is worse than a disabled one.
 *
 * Two ways to be CI-owned, genuinely different mechanisms for one fact:
 *
 *   * `declaredSuiteId` — a suite file names it, so the file is authoritative.
 *   * `source === "sdk"` — SDK ingest authored it from a report.
 *
 * DELIBERATELY NOT `lastSdkRunAt`. A UI-authored suite that CI merely reported
 * a run into is still the app's suite; locking it would take an editable suite
 * away from its author because a pipeline mentioned it once. (`suite-switcher`
 * reads `lastSdkRunAt` for its own, unrelated delete rule — that stays.)
 *
 * MIRRORED, not authoritative: the platform enforces this in
 * `lib/evalPermissions.ts` and refuses the write with
 * `CI_OWNED_SUITE_READ_ONLY`. This predicate exists so the UI can disable the
 * control and explain it, rather than offering a button whose only outcome is
 * a 409.
 */
export function isCiOwnedSuite(
  suite:
    | {
        declaredSuiteId?: string | null;
        source?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!suite) return false;
  return (
    (typeof suite.declaredSuiteId === "string" &&
      suite.declaredSuiteId.length > 0) ||
    suite.source === "sdk"
  );
}

/**
 * The one sentence a locked control shows.
 *
 * Names both remedies, because they serve different readers: the person who
 * owns the repository edits the file, and the person who just wants to try
 * something duplicates. Neither is "ask an admin" — every project member holds
 * `suite.edit` here, so a permission-shaped message would send them after
 * access that changes nothing.
 */
export const CI_OWNED_REASON_COPY =
  "Managed by CI — edit the test file, or duplicate to edit here";
