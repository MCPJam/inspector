/** Stable local namespace; the user id comes from backend-authenticated identity. */
export function taskOwnerScope(
  projectId: string | null | undefined,
  ownerUserId: string | null | undefined,
): string | undefined {
  return projectId && ownerUserId
    ? JSON.stringify(["owned-task-v1", projectId, ownerUserId])
    : undefined;
}
