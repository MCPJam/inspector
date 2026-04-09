export function hasSameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

export function resolveRestorableServerNames(
  savedServers: string[] | undefined,
  serversById: Map<string, string>,
  knownServerNames: Iterable<string>,
): string[] {
  if (!Array.isArray(savedServers) || savedServers.length === 0) {
    return [];
  }

  const knownNames = new Set(knownServerNames);
  const resolved: string[] = [];

  for (const savedServer of savedServers) {
    const resolvedName =
      serversById.get(savedServer) ??
      (knownNames.has(savedServer) ? savedServer : null);
    if (!resolvedName || resolved.includes(resolvedName)) {
      continue;
    }
    resolved.push(resolvedName);
  }

  return resolved;
}
