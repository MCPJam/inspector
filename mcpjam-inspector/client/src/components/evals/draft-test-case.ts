/**
 * A "draft" test case is a brand-new case the user is configuring but has NOT
 * saved yet. Creating one no longer writes to Convex immediately — the editor
 * holds it in local state and only calls `createTestCase` when the user presses
 * Save. This stops the suite from being polluted with "Untitled" cases every
 * time someone opens the New case menu.
 *
 * The draft kind is carried inside the `test-edit` route's `testId` as an opaque
 * sentinel (e.g. `draft:prompt`), so no route/navigation plumbing has to learn a
 * new field — every consumer keeps treating `testId` as a string. The sentinel
 * is not a real Convex id, so it must never be handed to a Convex query.
 */

// Render checks were unified into pinned prompt turns (created inside the
// editor), so the only top-level draft kind is a prompt test case.
export type DraftCaseKind = "prompt";

const DRAFT_TEST_CASE_PREFIX = "draft:";

/** Route `testId` sentinel for an unsaved case of the given kind. */
export function draftTestCaseId(kind: DraftCaseKind): string {
  return `${DRAFT_TEST_CASE_PREFIX}${kind}`;
}

/** Returns the draft kind when `id` is a draft sentinel, else `null`. */
export function parseDraftTestCaseId(
  id: string | null | undefined,
): DraftCaseKind | null {
  if (!id || !id.startsWith(DRAFT_TEST_CASE_PREFIX)) {
    return null;
  }
  const kind = id.slice(DRAFT_TEST_CASE_PREFIX.length);
  return kind === "prompt" ? kind : null;
}

export function isDraftTestCaseId(id: string | null | undefined): boolean {
  return parseDraftTestCaseId(id) !== null;
}
