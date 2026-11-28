export function indexProjectServersByName<
  Server extends { name: string; projectId?: string },
>(servers: readonly Server[], projectId: string | null): Map<string, Server> {
  // The workspace-wide query can return a same-name row from another project.
  // Prefer the active project's row for both displayed settings and saved IDs.
  const byName = new Map<string, Server>();
  for (const server of servers) {
    if (
      byName.get(server.name)?.projectId === projectId &&
      server.projectId !== projectId
    ) {
      continue;
    }
    byName.set(server.name, server);
  }
  return byName;
}
