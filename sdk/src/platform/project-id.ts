/** Spread `projectId` only when the payload actually carries one. */
export function projectIdOf(source: { projectId?: string | null }): {
  projectId?: string;
} {
  return source.projectId ? { projectId: source.projectId } : {};
}
