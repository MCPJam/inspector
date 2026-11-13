/**
 * Reviewer credentials: the project secrets a directory's reviewer signs in
 * with. Their names share one prefix, so each delivery path can tell them
 * apart without a lookup. Chat and harness sessions never receive them, and
 * the browser types one only on the origins a readiness run sends it with:
 * typed on any other page, the password goes to whoever runs that page.
 */
export const REVIEWER_SECRET_PREFIX = "MCPJAM_REVIEWER_";

export function isReviewerSecretName(name: string): boolean {
  return name.startsWith(REVIEWER_SECRET_PREFIX);
}
