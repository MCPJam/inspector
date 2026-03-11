export function resolveHostedWorkspaceId(
  isAuthenticated: boolean,
  sharedWorkspaceId: string | null | undefined,
): string | null {
  return isAuthenticated ? sharedWorkspaceId ?? null : null;
}
